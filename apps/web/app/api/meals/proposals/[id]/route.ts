import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { approveProposal, rejectProposal } from "@/lib/ai/planner";
import { services } from "@/lib/services";
import { AppError } from "@/lib/errors";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const row = services().db.prepare("SELECT id, name, status, payload_json, mealie_slug FROM recipe_proposals WHERE id = ?").get(id) as
    | { id: string; name: string; status: string; payload_json: string; mealie_slug: string | null }
    | undefined;
  if (!row) throw new AppError("not_found", "Proposal not found");
  return { id: row.id, name: row.name, status: row.status, mealieSlug: row.mealie_slug, recipe: JSON.parse(row.payload_json) };
});

/** Review an AI-proposed recipe: approve creates it in Mealie, reject discards it. */
export const POST = route<{ id: string }>(async (req, { params, actor }) => {
  const { id } = await params;
  const { decision } = await body(req, z.object({ decision: z.enum(["approve", "reject"]) }));
  if (decision === "reject") {
    rejectProposal(id);
    audit(actor, "proposal.reject", { id });
    return { status: "rejected" };
  }
  const result = await approveProposal(id);
  audit(actor, "proposal.approve", { id, slug: result.slug });
  return { status: "approved", ...result };
});
