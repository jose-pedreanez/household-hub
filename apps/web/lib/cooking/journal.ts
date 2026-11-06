import type { Db } from "../db";
import { nowIso } from "../db";
import type { CookingPlan } from "./plan";

/** Durable record of one "we cooked this" event and every Grocy consume call it made. */

export type OccurrenceStatus = "executing" | "partial" | "completed" | "failed" | "reversing" | "reversed";
export type LineStatus = "pending" | "submitting" | "uncertain" | "consumed" | "failed" | "skipped" | "reversed";

export interface Occurrence {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  mealplanEntryId: number | null;
  recipeId: string;
  recipeSlug: string;
  recipeName: string;
  recipeServings: number;
  servings: number;
  leftoverServings: number;
  status: OccurrenceStatus;
  plan: CookingPlan;
  error: string | null;
  mealieSynced: boolean;
  createdAt: string;
  completedAt: string | null;
  reversedAt: string | null;
}

export interface JournalLine {
  occurrenceId: string;
  lineNo: number;
  kind: "recipe" | "extra" | "correction";
  correctsLineNo: number | null;
  ingredientRef: string | null;
  mealieFoodId: string | null;
  description: string;
  grocyProductId: number;
  productName: string;
  amount: number;
  quId: number;
  unitName: string;
  stockEntryId: string | null;
  bestBeforeDate: string | null;
  status: LineStatus;
  grocyTransactionId: string | null;
  logWatermark: number | null;
  attempts: number;
  error: string | null;
  submittedAt: string | null;
  consumedAt: string | null;
  reversedAt: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toOccurrence(r: any): Occurrence {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    mealplanEntryId: r.mealplan_entry_id,
    recipeId: r.recipe_id,
    recipeSlug: r.recipe_slug,
    recipeName: r.recipe_name,
    recipeServings: r.recipe_servings,
    servings: r.servings,
    leftoverServings: r.leftover_servings,
    status: r.status,
    plan: JSON.parse(r.plan_json),
    error: r.error,
    mealieSynced: r.mealie_synced === 1,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    reversedAt: r.reversed_at,
  };
}

function toLine(r: any): JournalLine {
  return {
    occurrenceId: r.occurrence_id,
    lineNo: r.line_no,
    kind: r.kind,
    correctsLineNo: r.corrects_line_no,
    ingredientRef: r.ingredient_ref,
    mealieFoodId: r.mealie_food_id,
    description: r.description,
    grocyProductId: r.grocy_product_id,
    productName: r.product_name,
    amount: r.amount,
    quId: r.qu_id,
    unitName: r.unit_name,
    stockEntryId: r.stock_entry_id,
    bestBeforeDate: r.best_before_date,
    status: r.status,
    grocyTransactionId: r.grocy_transaction_id,
    logWatermark: r.log_watermark,
    attempts: r.attempts,
    error: r.error,
    submittedAt: r.submitted_at,
    consumedAt: r.consumed_at,
    reversedAt: r.reversed_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class CookingJournal {
  constructor(private readonly db: Db) {}

  byKey(key: string): Occurrence | null {
    const r = this.db.prepare("SELECT * FROM cooking_occurrences WHERE idempotency_key = ?").get(key);
    return r ? toOccurrence(r) : null;
  }

  get(id: string): Occurrence | null {
    const r = this.db.prepare("SELECT * FROM cooking_occurrences WHERE id = ?").get(id);
    return r ? toOccurrence(r) : null;
  }

  activeForMealplan(entryId: number): Occurrence | null {
    const r = this.db
      .prepare("SELECT * FROM cooking_occurrences WHERE mealplan_entry_id = ? AND status <> 'reversed'")
      .get(entryId);
    return r ? toOccurrence(r) : null;
  }

  forMealplanEntries(entryIds: number[]): Map<number, Occurrence> {
    const out = new Map<number, Occurrence>();
    if (entryIds.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT * FROM cooking_occurrences WHERE status <> 'reversed' AND mealplan_entry_id IN (${entryIds.map(() => "?").join(",")})`,
      )
      .all(...entryIds);
    for (const r of rows) {
      const o = toOccurrence(r);
      out.set(o.mealplanEntryId!, o);
    }
    return out;
  }

  recent(limit = 30): Occurrence[] {
    return this.db.prepare("SELECT * FROM cooking_occurrences ORDER BY created_at DESC LIMIT ?").all(limit).map(toOccurrence);
  }

  lines(occurrenceId: string): JournalLine[] {
    return this.db
      .prepare("SELECT * FROM cooking_lines WHERE occurrence_id = ? ORDER BY line_no")
      .all(occurrenceId)
      .map(toLine);
  }

  line(occurrenceId: string, lineNo: number): JournalLine | null {
    const r = this.db.prepare("SELECT * FROM cooking_lines WHERE occurrence_id = ? AND line_no = ?").get(occurrenceId, lineNo);
    return r ? toLine(r) : null;
  }

  /** Transaction ids already attributed to any journal line (used when reconciling uncertain writes). */
  knownTransactionIds(productId: number): Set<string> {
    const rows = this.db
      .prepare("SELECT grocy_transaction_id AS t FROM cooking_lines WHERE grocy_product_id = ? AND grocy_transaction_id IS NOT NULL")
      .all(productId) as { t: string }[];
    return new Set(rows.map((r) => r.t));
  }

  /** Insert the occurrence and its lines atomically. Throws on a duplicate key or an already-cooked plan entry. */
  create(o: Omit<Occurrence, "createdAt" | "completedAt" | "reversedAt" | "error" | "mealieSynced">, lines: Omit<JournalLine, "occurrenceId" | "attempts" | "error" | "submittedAt" | "consumedAt" | "reversedAt" | "grocyTransactionId" | "logWatermark" | "status">[]): void {
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cooking_occurrences(id, idempotency_key, request_hash, mealplan_entry_id, recipe_id, recipe_slug, recipe_name,
             recipe_servings, servings, leftover_servings, status, plan_json, created_at)
           VALUES (@id, @key, @hash, @entry, @rid, @slug, @name, @rs, @s, @ls, @status, @plan, @now)`,
        )
        .run({
          id: o.id,
          key: o.idempotencyKey,
          hash: o.requestHash,
          entry: o.mealplanEntryId,
          rid: o.recipeId,
          slug: o.recipeSlug,
          name: o.recipeName,
          rs: o.recipeServings,
          s: o.servings,
          ls: o.leftoverServings,
          status: o.status,
          plan: JSON.stringify(o.plan),
          now,
        });
      const ins = this.db.prepare(
        `INSERT INTO cooking_lines(occurrence_id, line_no, kind, corrects_line_no, ingredient_ref, mealie_food_id, description,
           grocy_product_id, product_name, amount, qu_id, unit_name, stock_entry_id, best_before_date, status)
         VALUES (@oid, @no, @kind, @corr, @ref, @food, @desc, @pid, @pname, @amount, @qu, @unit, @stock, @bbd, 'pending')`,
      );
      for (const l of lines) {
        ins.run({
          oid: o.id,
          no: l.lineNo,
          kind: l.kind,
          corr: l.correctsLineNo,
          ref: l.ingredientRef,
          food: l.mealieFoodId,
          desc: l.description,
          pid: l.grocyProductId,
          pname: l.productName,
          amount: l.amount,
          qu: l.quId,
          unit: l.unitName,
          stock: l.stockEntryId,
          bbd: l.bestBeforeDate,
        });
      }
    })();
  }

  addLine(line: Omit<JournalLine, "attempts" | "error" | "submittedAt" | "consumedAt" | "reversedAt" | "grocyTransactionId" | "logWatermark" | "status" | "lineNo">): number {
    return this.db.transaction(() => {
      const next = (this.db.prepare("SELECT COALESCE(MAX(line_no), 0) + 1 AS n FROM cooking_lines WHERE occurrence_id = ?").get(line.occurrenceId) as { n: number }).n;
      this.db
        .prepare(
          `INSERT INTO cooking_lines(occurrence_id, line_no, kind, corrects_line_no, ingredient_ref, mealie_food_id, description,
             grocy_product_id, product_name, amount, qu_id, unit_name, stock_entry_id, best_before_date, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          line.occurrenceId, next, line.kind, line.correctsLineNo, line.ingredientRef, line.mealieFoodId, line.description,
          line.grocyProductId, line.productName, line.amount, line.quId, line.unitName, line.stockEntryId, line.bestBeforeDate,
        );
      return next;
    })();
  }

  markSubmitting(occurrenceId: string, lineNo: number, watermark: number): void {
    this.db
      .prepare(
        `UPDATE cooking_lines SET status = 'submitting', attempts = attempts + 1, log_watermark = ?, submitted_at = ?, error = NULL
         WHERE occurrence_id = ? AND line_no = ?`,
      )
      .run(watermark, nowIso(), occurrenceId, lineNo);
  }

  markLine(
    occurrenceId: string,
    lineNo: number,
    status: LineStatus,
    fields: { transactionId?: string | null; error?: string | null } = {},
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE cooking_lines SET status = @status,
           grocy_transaction_id = CASE WHEN @setTid THEN @tid ELSE grocy_transaction_id END,
           error = @error,
           consumed_at = CASE WHEN @status = 'consumed' THEN @now ELSE consumed_at END,
           reversed_at = CASE WHEN @status = 'reversed' THEN @now ELSE reversed_at END
         WHERE occurrence_id = @oid AND line_no = @no`,
      )
      .run({
        status,
        setTid: fields.transactionId !== undefined ? 1 : 0,
        tid: fields.transactionId ?? null,
        error: fields.error ?? null,
        now,
        oid: occurrenceId,
        no: lineNo,
      });
  }

  setStatus(id: string, status: OccurrenceStatus, error: string | null = null): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE cooking_occurrences SET status = @status, error = @error,
           completed_at = CASE WHEN @status = 'completed' AND completed_at IS NULL THEN @now ELSE completed_at END,
           reversed_at = CASE WHEN @status = 'reversed' THEN @now ELSE reversed_at END
         WHERE id = @id`,
      )
      .run({ status, error, now, id });
  }

  setMealieSynced(id: string, synced: boolean): void {
    this.db.prepare("UPDATE cooking_occurrences SET mealie_synced = ? WHERE id = ?").run(synced ? 1 : 0, id);
  }

  unsyncedCompleted(): Occurrence[] {
    return this.db
      .prepare("SELECT * FROM cooking_occurrences WHERE status = 'completed' AND mealie_synced = 0 ORDER BY created_at")
      .all()
      .map(toOccurrence);
  }
}
