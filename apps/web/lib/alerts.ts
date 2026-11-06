import "server-only";
import { today } from "./api";
import { householdConfig } from "./config";
import { mappingContext } from "./context";
import { nowIso, type Db } from "./db";
import { isNeverExpires } from "./grocy/client";
import { hashRequest } from "./idempotency";
import { services } from "./services";
import { unitName } from "./units/convert";

export interface Alert {
  kind: "expired" | "overdue" | "due_soon" | "low_stock";
  dedupeKey: string;
  title: string;
  body: string;
  link: string;
}

/** Current alert conditions from Grocy, one alert per kind (listing the products). */
export async function currentAlerts(): Promise<Alert[]> {
  const { grocy } = services();
  const cfg = householdConfig().config;
  const [v, ctx] = await Promise.all([grocy.volatileStock(cfg.inventory.expiringSoonDays), mappingContext()]);
  const name = (id: number, fallback?: string) => ctx.products.get(id)?.name ?? fallback ?? `#${id}`;
  const out: Alert[] = [];
  const group = (kind: Alert["kind"], title: string, rows: Array<{ product_id: number; best_before_date: string | null; amount_missing?: number | null; name?: string }>) => {
    if (rows.length === 0) return;
    const lines = rows
      .map((r) => {
        const p = ctx.products.get(r.product_id);
        if (kind === "low_stock") {
          return `${name(r.product_id, r.name)}: ${r.amount_missing ?? "?"} ${p ? unitName(ctx.catalog, p.qu_id_stock, 2) : ""} below minimum`;
        }
        return `${name(r.product_id, r.name)} (${isNeverExpires(r.best_before_date) ? "no date" : r.best_before_date})`;
      })
      .sort();
    out.push({ kind, dedupeKey: `alert:${kind}`, title: `${title} (${rows.length})`, body: lines.join("\n"), link: kind === "low_stock" ? "/shopping" : "/inventory?status=expiring" });
  };
  group("expired", "Expired", v.expired_products);
  group("overdue", "Past best-before", v.overdue_products);
  group("due_soon", `Due within ${cfg.inventory.expiringSoonDays} days`, v.due_products);
  group("low_stock", "Below minimum stock", v.missing_products);
  return out;
}

/**
 * Alerts worth sending now. An alert is repeated only when its content changed or when
 * `repeatAfterHours` passed since it was last sent, so scheduled checks do not spam the household.
 */
export function filterNewAlerts(db: Db, alerts: Alert[], repeatAfterHours: number, now = Date.now()): { send: Alert[]; suppressed: number } {
  const send: Alert[] = [];
  let suppressed = 0;
  for (const a of alerts) {
    const fp = hashRequest({ title: a.title, body: a.body });
    const row = db.prepare("SELECT fingerprint, last_sent_at FROM alert_state WHERE dedupe_key = ?").get(a.dedupeKey) as { fingerprint: string; last_sent_at: string } | undefined;
    const due = !row || row.fingerprint !== fp || now - Date.parse(row.last_sent_at) >= repeatAfterHours * 3600_000;
    if (!due) {
      suppressed++;
      continue;
    }
    send.push(a);
    db.prepare(
      `INSERT INTO alert_state(dedupe_key, fingerprint, last_sent_at) VALUES (?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET fingerprint = excluded.fingerprint, last_sent_at = excluded.last_sent_at`,
    ).run(a.dedupeKey, fp, new Date(now).toISOString());
    notify(db, { kind: a.kind, title: a.title, body: a.body, link: a.link });
  }
  return { send, suppressed };
}

export function notify(db: Db, n: { kind: string; title: string; body?: string; link?: string }): void {
  db.prepare("INSERT INTO notifications(kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?)").run(n.kind, n.title, n.body ?? null, n.link ?? null, nowIso());
}

export function listNotifications(db: Db, limit = 30) {
  return db
    .prepare("SELECT id, kind, title, body, link, created_at AS createdAt, read_at AS readAt FROM notifications ORDER BY id DESC LIMIT ?")
    .all(limit) as Array<{ id: number; kind: string; title: string; body: string | null; link: string | null; createdAt: string; readAt: string | null }>;
}

export function markNotificationsRead(db: Db, ids?: number[]): void {
  if (ids && ids.length) {
    db.prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).run(nowIso(), ...ids);
  } else {
    db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(nowIso());
  }
}

/** Stock worth a quick physical check: opened or perishable items and anything past its date. */
export async function auditCandidates() {
  const { grocy } = services();
  const cfg = householdConfig().config;
  const [stock, groups, ctx] = await Promise.all([grocy.currentStock(), grocy.listProductGroups(), mappingContext()]);
  const perishableGroups = new Set(
    groups.filter((g) => cfg.inventory.auditProductGroups.map((x) => x.toLowerCase()).includes(g.name.toLowerCase())).map((g) => g.id),
  );
  const t = today();
  return stock
    .filter((s) => s.amount > 0)
    .map((s) => {
      const reasons: string[] = [];
      if ((s.amount_opened ?? 0) > 0) reasons.push("opened");
      if (!isNeverExpires(s.best_before_date) && s.best_before_date! < t) reasons.push("past best-before");
      if (s.product.product_group_id && perishableGroups.has(s.product.product_group_id)) reasons.push("perishable");
      return {
        productId: s.product_id,
        name: s.product.name,
        amount: s.amount,
        unit: unitName(ctx.catalog, s.product.qu_id_stock, s.amount),
        due: isNeverExpires(s.best_before_date) ? null : s.best_before_date,
        reasons,
      };
    })
    .filter((x) => x.reasons.length > 0)
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
}
