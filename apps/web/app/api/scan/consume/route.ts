import { NextResponse } from "next/server";
import { audit, body, route } from "@/lib/api";
import { receivingDeps } from "@/lib/barcode/deps";
import { consumeByScan, consumeScanRequestSchema } from "@/lib/barcode/receive";

export const POST = route(async (req, { actor }) => {
  const input = await body(req, consumeScanRequestSchema);
  const result = await consumeByScan(receivingDeps(), input);
  if (!result.replayed) audit(actor, "scan.consume", { id: result.transaction.id, productId: input.productId, status: result.transaction.status });
  // 202 = outcome not yet confirmed (retry with the same key to reconcile); failures carry their reason in the body.
  const status = result.transaction.status === "uncertain" ? 202 : 200;
  return NextResponse.json(result, { status });
});
