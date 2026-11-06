import { z } from "zod";
import { query, route } from "@/lib/api";
import { formatList } from "@/lib/retailers/adapters";
import { exportStoreList } from "@/lib/shopping/service";

/** Plain-text, Markdown or CSV export of a store list (for copying, sharing, email and printing). */
export const GET = route<{ retailerId: string }>(async (req, { params }) => {
  const { retailerId } = await params;
  const { format } = query(req, z.object({ format: z.enum(["text", "markdown", "csv"]).default("text") }));
  const { title, items } = await exportStoreList(retailerId);
  if (format === "csv") {
    const csv = ["item,quantity", ...items.map((i) => `"${i.name.replace(/"/g, '""')}",${i.quantity}`)].join("\n");
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${retailerId}-list.csv"` } });
  }
  const f = formatList(title, items);
  return new Response(format === "markdown" ? f.markdown : f.text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
});
