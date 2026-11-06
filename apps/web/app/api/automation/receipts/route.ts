import { body, route } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { parsedReceiptSchema } from "@/lib/receipts";

/**
 * Receipt ingestion endpoint (interface only). The payload contract is validated so a future source
 * can be built against it; matching receipts to unscanned purchases is not implemented yet.
 */
export const POST = route(async (req) => {
  const receipt = await body(req, parsedReceiptSchema);
  throw new AppError("not_configured", "Receipt ingestion is not implemented yet; the receipt was validated but not stored.", {
    lines: receipt.lines.length,
  });
});
