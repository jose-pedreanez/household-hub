import { z } from "zod";

/**
 * Receipt ingestion interface (future). A receipt source — an n8n email trigger, a retailer export,
 * an OCR step — posts parsed receipts in this shape to POST /api/automation/receipts.
 *
 * Design constraint: a receipt must never add stock by itself. Stock is added by receiving (scan or
 * manual receive), which is the single source of truth for purchases. A receipt implementation should
 * produce *suggestions* ("you bought 2 × milk that were not scanned — receive them?") that a person
 * confirms through the normal receiving pipeline, matched by barcode/UPC first and name second.
 */
export const parsedReceiptSchema = z.object({
  source: z.string().min(1).max(60),
  retailerId: z.string().regex(/^[a-z0-9_]+$/),
  externalId: z.string().min(1).max(200),
  purchasedAt: z.string().datetime({ offset: true }),
  currency: z.string().length(3).default("USD"),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(200),
        upc: z.string().max(20).nullable().default(null),
        quantity: z.number().positive(),
        unitPrice: z.number().nonnegative().nullable().default(null),
        total: z.number().nonnegative().nullable().default(null),
      }),
    )
    .min(1),
});
export type ParsedReceipt = z.infer<typeof parsedReceiptSchema>;

export interface ReceiptSource {
  readonly id: string;
  /** Fetch receipts newer than `since`. Implementations hold their own credentials. */
  fetchSince(since: Date): Promise<ParsedReceipt[]>;
}
