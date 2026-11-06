import { audit, body, route } from "@/lib/api";
import { receivingDeps } from "@/lib/barcode/deps";
import { receive, receiveRequestSchema } from "@/lib/barcode/receive";
import { NextResponse } from "next/server";

/** Book one intended scan (default: one package) into Grocy. Safe to retry with the same key. */
export const POST = route(async (req, { actor }) => {
  const input = await body(req, receiveRequestSchema);
  const result = await receive(receivingDeps(), input);
  if (!result.replayed) audit(actor, "scan.receive", { id: result.transaction.id, productId: input.productId, status: result.transaction.status });
  // 202 = outcome not yet confirmed (retry with the same key to reconcile); failures carry their reason in the body.
  const status = result.transaction.status === "uncertain" ? 202 : 200;
  return NextResponse.json(result, { status });
});
