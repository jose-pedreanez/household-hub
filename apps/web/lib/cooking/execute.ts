import { randomUUID } from "node:crypto";
import { AppError, UpstreamError, errorMessage } from "../errors";
import type { ConsumeStockBody } from "../grocy/client";
import type { StockLogEntry } from "../grocy/schemas";
import { roundAmount } from "../units/convert";
import { CookingJournal, type JournalLine, type Occurrence, type OccurrenceStatus } from "./journal";
import type { CookingPlan } from "./plan";

/**
 * Executes a cooking plan against Grocy with a durable journal.
 *
 * Guarantees:
 *  - One Grocy consume call per journal line; a line that is `consumed` is never submitted again.
 *  - Repeating a request with the same idempotency key resumes or replays it; it never re-deducts.
 *  - A meal-plan entry can be cooked once until that cooking is reversed (enforced by a unique index).
 *  - A write whose outcome is unknown (timeout, 5xx) is reconciled against Grocy's stock log before
 *    anything is resubmitted.
 *  - Reversal undoes each recorded Grocy transaction; corrections are new journal lines.
 * Grocy and Mealie share no transaction, so Mealie bookkeeping (last made, timeline) is best-effort
 * and retried later; stock in Grocy is the authority.
 */

export interface CookingStock {
  consumeStock(productId: number, body: ConsumeStockBody): Promise<StockLogEntry[]>;
  listStockLog(query: string[], order?: string, limit?: number): Promise<StockLogEntry[]>;
  undoTransaction(transactionId: string): Promise<void>;
  transaction(transactionId: string): Promise<StockLogEntry[] | null>;
}

export interface CookingRecipeLog {
  setLastMade(slug: string, timestamp: string): Promise<void>;
  addTimelineEvent(event: { recipeId: string; subject: string; eventMessage?: string }): Promise<void>;
}

export interface CookingDeps {
  journal: CookingJournal;
  grocy: CookingStock;
  mealie: CookingRecipeLog | null;
  /** How long a submitted-but-unanswered write is left alone before reconciliation (ms). */
  reconcileAfterMs?: number;
}

export interface CookingView {
  occurrence: Occurrence;
  lines: JournalLine[];
  summary: Record<JournalLine["status"], number>;
  replayed?: boolean;
}

export interface NewOccurrence {
  idempotencyKey: string;
  requestHash: string;
  mealplanEntryId: number | null;
  servings: number;
  leftoverServings: number;
  plan: CookingPlan;
}

const locks = new Map<string, Promise<unknown>>();

/** Serialise work per occurrence within this process (the hub runs as a single instance). */
async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(id, chained);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === chained) locks.delete(id);
  }
}

export function view(journal: CookingJournal, id: string, replayed?: boolean): CookingView {
  const occurrence = journal.get(id);
  if (!occurrence) throw new AppError("not_found", "Cooking record not found");
  const lines = journal.lines(id);
  const summary = { pending: 0, submitting: 0, uncertain: 0, consumed: 0, failed: 0, skipped: 0, reversed: 0 };
  for (const l of lines) summary[l.status] += 1;
  return { occurrence, lines, summary, ...(replayed ? { replayed } : {}) };
}

/** Turn a validated, non-blocking plan into a journal and execute it. */
export async function startCooking(deps: CookingDeps, req: NewOccurrence): Promise<CookingView> {
  const { journal } = deps;

  const existing = journal.byKey(req.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== req.requestHash) {
      throw new AppError("idempotency_mismatch", "This idempotency key was already used for a different cooking request");
    }
    return resumeCooking(deps, existing.id, true);
  }
  if (req.mealplanEntryId != null) {
    const active = journal.activeForMealplan(req.mealplanEntryId);
    if (active) {
      throw new AppError("conflict", "This meal was already marked as cooked. Reverse it first to record it again.", {
        occurrenceId: active.id,
      });
    }
  }
  if (req.plan.blocking) {
    throw new AppError("unprocessable", "The plan has unresolved ingredients", { plan: req.plan });
  }

  const id = randomUUID();
  const lines = req.plan.lines.flatMap((pl) =>
    pl.allocations.map((a) => ({
      kind: pl.kind as JournalLine["kind"],
      correctsLineNo: null,
      ingredientRef: pl.kind === "recipe" ? pl.key : null,
      mealieFoodId: pl.foodId,
      description: pl.display,
      grocyProductId: a.productId,
      productName: a.productName,
      amount: a.amountStock,
      quId: a.stockQuId,
      unitName: a.stockUnitName,
      stockEntryId: a.stockId,
      bestBeforeDate: a.bestBeforeDate,
    })),
  );

  try {
    journal.create(
      {
        id,
        idempotencyKey: req.idempotencyKey,
        requestHash: req.requestHash,
        mealplanEntryId: req.mealplanEntryId,
        recipeId: req.plan.recipe.id,
        recipeSlug: req.plan.recipe.slug,
        recipeName: req.plan.recipe.name,
        recipeServings: req.plan.recipe.baseServings,
        servings: req.servings,
        leftoverServings: req.leftoverServings,
        status: "executing",
        plan: req.plan,
      },
      lines.map((l, i) => ({ ...l, lineNo: i + 1 })),
    );
  } catch (e) {
    // Lost a race with an identical or concurrent request: report what won.
    const winner = journal.byKey(req.idempotencyKey);
    if (winner) return resumeCooking(deps, winner.id, true);
    if (req.mealplanEntryId != null && journal.activeForMealplan(req.mealplanEntryId)) {
      throw new AppError("conflict", "This meal was already marked as cooked.");
    }
    throw e;
  }
  return resumeCooking(deps, id);
}

/** Continue an occurrence: reconcile uncertain lines, submit pending/failed ones, recompute status. */
export async function resumeCooking(deps: CookingDeps, id: string, replayed = false): Promise<CookingView> {
  return withLock(id, async () => {
    const { journal } = deps;
    const occ = journal.get(id);
    if (!occ) throw new AppError("not_found", "Cooking record not found");
    if (occ.status === "reversed" || occ.status === "reversing" || occ.status === "completed") {
      if (occ.status === "completed" && !occ.mealieSynced) await syncMealie(deps, occ);
      return view(journal, id, replayed);
    }

    journal.setStatus(id, "executing");
    let halted: string | null = null;
    for (const line of journal.lines(id)) {
      if (halted) break;
      try {
        if (line.status === "submitting" || line.status === "uncertain") {
          await reconcileLine(deps, line);
        }
        const fresh = journal.line(id, line.lineNo)!;
        if (fresh.status === "pending" || fresh.status === "failed") {
          await submitLine(deps, fresh);
        }
      } catch (e) {
        // Grocy unreachable before anything was sent: stop, leave remaining lines pending.
        halted = errorMessage(e);
      }
    }

    const status = computeStatus(journal.lines(id));
    journal.setStatus(id, status, halted);
    const updated = journal.get(id)!;
    if (status === "completed") await syncMealie(deps, updated);
    return view(journal, id, replayed);
  });
}

function computeStatus(lines: JournalLine[]): OccurrenceStatus {
  const open = lines.filter((l) => ["pending", "submitting", "uncertain", "failed"].includes(l.status));
  if (open.length === 0) return "completed";
  return lines.some((l) => l.status === "consumed") ? "partial" : "failed";
}

async function stockLogWatermark(grocy: CookingStock, productId: number): Promise<number> {
  const rows = await grocy.listStockLog([`product_id=${productId}`], "id:desc", 1);
  return rows[0]?.id ?? 0;
}

async function submitLine(deps: CookingDeps, line: JournalLine): Promise<void> {
  const { journal, grocy } = deps;
  // If this fails, nothing was sent; the caller halts and the line stays as it was.
  const watermark = await stockLogWatermark(grocy, line.grocyProductId);
  journal.markSubmitting(line.occurrenceId, line.lineNo, watermark);
  try {
    const body: ConsumeStockBody = { amount: line.amount, allow_subproduct_substitution: false };
    if (line.stockEntryId) body.stock_entry_id = line.stockEntryId;
    const rows = await grocy.consumeStock(line.grocyProductId, body);
    const tid = rows.find((r) => r.transaction_id)?.transaction_id ?? null;
    if (!tid) {
      journal.markLine(line.occurrenceId, line.lineNo, "uncertain", { error: "Grocy accepted the consume but returned no transaction id" });
      return;
    }
    journal.markLine(line.occurrenceId, line.lineNo, "consumed", { transactionId: tid });
  } catch (e) {
    if (e instanceof UpstreamError && e.outcomeUncertain) {
      journal.markLine(line.occurrenceId, line.lineNo, "uncertain", { error: e.message });
    } else {
      journal.markLine(line.occurrenceId, line.lineNo, "failed", { error: errorMessage(e) });
    }
  }
}

/**
 * Decide whether an unanswered consume was applied, using Grocy's stock log above the watermark
 * recorded just before the request. Grocy applies exactly the amount requested, so an applied
 * request shows up as one transaction for this product (and lot) with exactly this amount.
 */
async function reconcileLine(deps: CookingDeps, line: JournalLine): Promise<void> {
  const { journal, grocy } = deps;
  const now = Date.now();
  const waitMs = deps.reconcileAfterMs ?? 30_000;
  if (line.submittedAt && now - Date.parse(line.submittedAt) < waitMs) {
    throw new AppError("in_progress", "A Grocy write for this meal is still settling; retry in a few seconds");
  }
  if (line.logWatermark == null) {
    // Crashed before the watermark was stored, so nothing was sent.
    journal.markLine(line.occurrenceId, line.lineNo, "pending");
    return;
  }
  const rows = await grocy.listStockLog(
    [`product_id=${line.grocyProductId}`, `id>${line.logWatermark}`, "transaction_type=consume"],
    "id:asc",
    200,
  );
  const known = journal.knownTransactionIds(line.grocyProductId);
  const byTx = new Map<string, StockLogEntry[]>();
  for (const r of rows) {
    if (known.has(r.transaction_id) || r.undone) continue;
    if (line.stockEntryId && r.stock_id && r.stock_id !== line.stockEntryId) continue;
    byTx.set(r.transaction_id, [...(byTx.get(r.transaction_id) ?? []), r]);
  }
  const matches = [...byTx.entries()].filter(
    ([, rs]) => Math.abs(roundAmount(rs.reduce((s, r) => s + Math.abs(r.amount), 0)) - line.amount) < 0.0002,
  );
  if (matches.length === 1) {
    journal.markLine(line.occurrenceId, line.lineNo, "consumed", { transactionId: matches[0][0] });
  } else if (matches.length === 0) {
    journal.markLine(line.occurrenceId, line.lineNo, "pending");
  } else {
    journal.markLine(line.occurrenceId, line.lineNo, "uncertain", {
      error: `Found ${matches.length} identical consume transactions in Grocy; review the stock journal before retrying.`,
    });
    throw new AppError("conflict", "Ambiguous Grocy history; manual review needed");
  }
}

async function syncMealie(deps: CookingDeps, occ: Occurrence): Promise<void> {
  if (!deps.mealie) return;
  try {
    const lines = deps.journal.lines(occ.id).filter((l) => l.status === "consumed");
    const summary = lines.map((l) => `${fmtAmount(l.amount)} ${l.unitName} ${l.productName}`).join(", ");
    await deps.mealie.setLastMade(occ.recipeSlug, new Date().toISOString());
    await deps.mealie.addTimelineEvent({
      recipeId: occ.recipeId,
      subject: `Cooked ${fmtAmount(occ.servings)} servings (Household Hub)`,
      eventMessage: summary ? `Inventory used: ${summary}` : "No tracked inventory used.",
    });
    deps.journal.setMealieSynced(occ.id, true);
  } catch {
    deps.journal.setMealieSynced(occ.id, false);
  }
}

/** Undo every consumed line. Idempotent: lines already reversed are skipped. */
export async function reverseCooking(deps: CookingDeps, id: string): Promise<CookingView> {
  return withLock(id, async () => {
    const { journal, grocy } = deps;
    const occ = journal.get(id);
    if (!occ) throw new AppError("not_found", "Cooking record not found");
    if (occ.status === "reversed") return view(journal, id, true);
    const unsettled = journal.lines(id).filter((l) => l.status === "submitting" || l.status === "uncertain");
    if (unsettled.length > 0) {
      throw new AppError("conflict", "Some consume calls are still unconfirmed; retry the meal first so they can be reconciled.");
    }
    journal.setStatus(id, "reversing");
    const errors: string[] = [];
    for (const line of [...journal.lines(id)].reverse()) {
      if (line.status === "consumed" && line.grocyTransactionId) {
        const ok = await undo(grocy, line.grocyTransactionId);
        if (ok) journal.markLine(id, line.lineNo, "reversed");
        else errors.push(`${line.productName}: undo failed`);
      } else if (line.status === "pending" || line.status === "failed") {
        journal.markLine(id, line.lineNo, "skipped", { error: "Not consumed; cancelled by reversal" });
      }
    }
    if (errors.length > 0) {
      journal.setStatus(id, "reversing", errors.join("; "));
    } else {
      journal.setStatus(id, "reversed");
      if (deps.mealie) {
        await deps.mealie
          .addTimelineEvent({ recipeId: occ.recipeId, subject: "Cooking record reversed (Household Hub)", eventMessage: "Inventory was restored in Grocy." })
          .catch(() => undefined);
      }
    }
    return view(journal, id);
  });
}

/** Grocy undo; treats "already undone" as success after checking the transaction. */
async function undo(grocy: CookingStock, tid: string): Promise<boolean> {
  try {
    await grocy.undoTransaction(tid);
    return true;
  } catch (e) {
    try {
      const rows = await grocy.transaction(tid);
      if (rows && rows.length > 0 && rows.every((r) => r.undone)) return true;
    } catch {
      /* fall through */
    }
    if (e instanceof UpstreamError) return false;
    throw e;
  }
}

/**
 * Correct a consumed line to a new amount: undo its transaction, then consume `newAmount` from the same
 * lot as a new journal line. `newAmount = 0` simply returns the stock.
 */
export async function correctLine(deps: CookingDeps, id: string, lineNo: number, newAmount: number): Promise<CookingView> {
  const { journal, grocy } = deps;
  await withLock(id, async () => {
    const line = journal.line(id, lineNo);
    if (!line) throw new AppError("not_found", "Line not found");
    if (line.status !== "consumed" || !line.grocyTransactionId) {
      throw new AppError("conflict", "Only consumed lines can be corrected");
    }
    if (!(await undo(grocy, line.grocyTransactionId))) throw new AppError("upstream_error", "Grocy could not undo the original consume");
    journal.markLine(id, lineNo, "reversed");
    if (newAmount > 0) {
      journal.addLine({
        occurrenceId: id,
        kind: "correction",
        correctsLineNo: lineNo,
        ingredientRef: line.ingredientRef,
        mealieFoodId: line.mealieFoodId,
        description: `Correction of line ${lineNo}: ${line.description}`,
        grocyProductId: line.grocyProductId,
        productName: line.productName,
        amount: roundAmount(newAmount),
        quId: line.quId,
        unitName: line.unitName,
        stockEntryId: line.stockEntryId,
        bestBeforeDate: line.bestBeforeDate,
      });
    }
    journal.setStatus(id, "executing");
  });
  return resumeCooking(deps, id);
}

/** Give up on a line that cannot be consumed (e.g. the stock is gone); the meal can then complete. */
export async function skipLine(deps: CookingDeps, id: string, lineNo: number): Promise<CookingView> {
  const { journal } = deps;
  await withLock(id, async () => {
    const line = journal.line(id, lineNo);
    if (!line) throw new AppError("not_found", "Line not found");
    if (line.status !== "failed" && line.status !== "pending") {
      throw new AppError("conflict", `A ${line.status} line cannot be skipped`);
    }
    journal.markLine(id, lineNo, "skipped", { error: line.error });
  });
  return resumeCooking(deps, id);
}

function fmtAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}
