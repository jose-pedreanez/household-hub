import { z } from "zod";
import { query, route } from "@/lib/api";
import { ScanJournal } from "@/lib/barcode/journal";
import { services } from "@/lib/services";

export const GET = route(async (req) => {
  const { batchId, limit } = query(req, z.object({ batchId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }));
  return { transactions: new ScanJournal(services().db).recent(limit, batchId) };
});
