import { Badge } from "@/components/ui/primitives";
import type { DueStatus } from "@/lib/inventory/overview";
import { daysUntil, fmtDate } from "@/lib/utils";

export function DueBadge({ status, due, today }: { status: DueStatus; due: string | null; today: string }) {
  if (status === "no_date" || !due) return null;
  const d = daysUntil(due, today) ?? 0;
  if (status === "expired") return <Badge variant="danger">Expired</Badge>;
  if (status === "overdue") return <Badge variant="danger">{-d}d past date</Badge>;
  if (status === "due_soon") return <Badge variant="warning">{d === 0 ? "Today" : d === 1 ? "Tomorrow" : `${d} days`}</Badge>;
  return <Badge variant="muted">{fmtDate(due)}</Badge>;
}
