import { createHash } from "node:crypto";
import type { Db } from "./db";
import { nowIso } from "./db";
import { AppError } from "./errors";

/** Stable hash of a request payload: key order does not matter, values do. */
export function hashRequest(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function assertIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AppError("bad_request", "A valid idempotency key (8–128 chars of [A-Za-z0-9_-]) is required");
  }
  return key;
}

interface Row {
  key: string;
  scope: string;
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  response_json: string | null;
  updated_at: string;
}

/** A claim older than this is assumed to belong to a crashed request and may be taken over. */
const STALE_CLAIM_MS = 2 * 60_000;

/**
 * Run `fn` at most once per idempotency key.
 *
 * - Same key, same payload, completed  → the stored response is returned (`replayed: true`).
 * - Same key, different payload        → 422 `idempotency_mismatch`.
 * - Same key, still running            → 409 `in_progress`.
 * - Same key, previously failed        → `fn` runs again (a failure means nothing was applied).
 *
 * Use this for writes whose side effects are a single upstream call. Multi-step stock writes
 * (receiving, cooking) keep their own journals so they can reconcile uncertain outcomes.
 */
export async function withIdempotency<T>(
  db: Db,
  opts: { key: string; scope: string; payload: unknown },
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const requestHash = hashRequest(opts.payload);
  const now = nowIso();

  const claim = db.transaction((): { kind: "run" } | { kind: "replay"; result: T } => {
    const row = db.prepare("SELECT * FROM idempotency_keys WHERE key = ?").get(opts.key) as Row | undefined;
    if (!row) {
      db.prepare(
        `INSERT INTO idempotency_keys(key, scope, request_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', ?, ?)`,
      ).run(opts.key, opts.scope, requestHash, now, now);
      return { kind: "run" };
    }
    if (row.scope !== opts.scope || row.request_hash !== requestHash) {
      throw new AppError("idempotency_mismatch", "This idempotency key was already used for a different request");
    }
    if (row.status === "completed") {
      return { kind: "replay", result: JSON.parse(row.response_json ?? "null") as T };
    }
    if (row.status === "in_progress" && Date.now() - Date.parse(row.updated_at) < STALE_CLAIM_MS) {
      throw new AppError("in_progress", "This request is already being processed; retry shortly");
    }
    db.prepare("UPDATE idempotency_keys SET status = 'in_progress', updated_at = ? WHERE key = ?").run(now, opts.key);
    return { kind: "run" };
  })();

  if (claim.kind === "replay") return { result: claim.result, replayed: true };

  try {
    const result = await fn();
    db.prepare(
      "UPDATE idempotency_keys SET status = 'completed', response_json = ?, updated_at = ? WHERE key = ?",
    ).run(JSON.stringify(result ?? null), nowIso(), opts.key);
    return { result, replayed: false };
  } catch (e) {
    db.prepare("UPDATE idempotency_keys SET status = 'failed', updated_at = ? WHERE key = ?").run(nowIso(), opts.key);
    throw e;
  }
}
