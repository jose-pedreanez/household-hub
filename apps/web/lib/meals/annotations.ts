import type { Db } from "../db";
import { nowIso } from "../db";

/**
 * Per-entry facts Mealie's meal plan cannot store: planned servings, and whether the entry eats
 * leftovers of an earlier cooking (which must not be deducted from stock again).
 * This is an annotation keyed by Mealie's entry id, not a second calendar.
 */
export interface PlanAnnotation {
  mealplanEntryId: number;
  plannedServings: number | null;
  leftoverOfOccurrenceId: string | null;
  note: string | null;
}

export class PlanAnnotations {
  constructor(private readonly db: Db) {}

  getMany(ids: number[]): Map<number, PlanAnnotation> {
    const out = new Map<number, PlanAnnotation>();
    if (ids.length === 0) return out;
    const rows = this.db
      .prepare(`SELECT * FROM plan_entry_annotations WHERE mealplan_entry_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Array<{ mealplan_entry_id: number; planned_servings: number | null; leftover_of_occurrence_id: string | null; note: string | null }>;
    for (const r of rows) {
      out.set(r.mealplan_entry_id, {
        mealplanEntryId: r.mealplan_entry_id,
        plannedServings: r.planned_servings,
        leftoverOfOccurrenceId: r.leftover_of_occurrence_id,
        note: r.note,
      });
    }
    return out;
  }

  set(id: number, fields: Partial<Omit<PlanAnnotation, "mealplanEntryId">>): void {
    const current = this.getMany([id]).get(id);
    const next = {
      plannedServings: fields.plannedServings !== undefined ? fields.plannedServings : current?.plannedServings ?? null,
      leftoverOfOccurrenceId:
        fields.leftoverOfOccurrenceId !== undefined ? fields.leftoverOfOccurrenceId : current?.leftoverOfOccurrenceId ?? null,
      note: fields.note !== undefined ? fields.note : current?.note ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO plan_entry_annotations(mealplan_entry_id, planned_servings, leftover_of_occurrence_id, note, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(mealplan_entry_id) DO UPDATE SET planned_servings = excluded.planned_servings,
           leftover_of_occurrence_id = excluded.leftover_of_occurrence_id, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(id, next.plannedServings, next.leftoverOfOccurrenceId, next.note, nowIso());
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM plan_entry_annotations WHERE mealplan_entry_id = ?").run(id);
  }
}
