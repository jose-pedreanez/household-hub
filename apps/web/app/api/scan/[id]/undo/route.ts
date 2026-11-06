import { audit, route } from "@/lib/api";
import { receivingDeps } from "@/lib/barcode/deps";
import { undoScan } from "@/lib/barcode/receive";
import { AppError } from "@/lib/errors";

export const POST = route<{ id: string }>(async (_req, { params, actor }) => {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) throw new AppError("bad_request", "Invalid scan id");
  const tx = await undoScan(receivingDeps(), id);
  audit(actor, "scan.undo", { id });
  return { transaction: tx };
});
