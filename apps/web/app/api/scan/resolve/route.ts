import { z } from "zod";
import { query, route, today } from "@/lib/api";
import { resolveBarcode } from "@/lib/barcode/resolve";
import { mappingContext } from "@/lib/context";
import { services } from "@/lib/services";

export const GET = route(async (req) => {
  const { barcode } = query(req, z.object({ barcode: z.string().min(1).max(80) }));
  const { grocy, mealie, off, metadata } = services();
  return resolveBarcode({ grocy, mealie, off, metadata, ctx: () => mappingContext(), today }, barcode);
});
