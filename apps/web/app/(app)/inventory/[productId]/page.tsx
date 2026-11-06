"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorNote, Field, Input, Loading } from "@/components/ui/primitives";
import type { ProductMetadata } from "@/lib/nutrition/off";
import { api, newKey, useApi } from "@/lib/client";
import { fmtAmount, fmtDate } from "@/lib/utils";

interface Detail {
  product: {
    id: number;
    name: string;
    description: string | null;
    stockUnit: string;
    stockAmount: number;
    opened: number;
    minStock: number;
    defaultBestBeforeDays: number;
    lastPrice: number | null;
    barcodes: Array<{ barcode: string; amount: number | null; unit: string | null }>;
  };
  family: {
    root: { id: number; name: string } | null;
    mealieFood: { id: string; name: string } | null;
    availability: { amount: number; unitName: string; members: Array<{ productId: number; name: string; amount: number; unitName: string; usable: number }> };
  };
  entries: Array<{ id: number; amount: number; bestBefore: string | null; purchased: string | null; opened: boolean; location: string | null; note: string | null }>;
  history: Array<{ id: number; type: string; amount: number; at: string | null; undone: boolean; note: string | null }>;
  edibleYield: number | null;
  metadata: { source: string; verification: string; data: ProductMetadata } | null;
}

const TYPE_LABEL: Record<string, string> = { purchase: "Added", consume: "Used", "inventory-correction": "Corrected", "product-opened": "Opened", "stock-edit-new": "Edited", "stock-edit-old": "Edited" };

export default function ProductPage({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = use(params);
  const { data, error, loading, reload } = useApi<Detail>(`/api/inventory/${productId}`);
  const [count, setCount] = useState("");
  const [yieldPct, setYieldPct] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [correctionKey, setCorrectionKey] = useState(() => newKey("count"));

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;
  const p = data.product;

  async function correct() {
    const n = Number(count);
    if (!(n >= 0)) return;
    setBusy(true);
    try {
      await api(`/api/inventory/${p.id}/correct`, { body: { idempotencyKey: correctionKey, newAmount: n } });
      toast.success(`Stock set to ${fmtAmount(n)} ${p.stockUnit}`);
      setCount("");
      setCorrectionKey(newKey("count"));
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveYield() {
    const v = yieldPct === "" ? null : Number(yieldPct) / 100;
    try {
      await api(`/api/inventory/${p.id}/yield`, { method: "PUT", body: { edibleYield: v } });
      toast.success("Saved");
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const n = data.metadata?.data.nutrition;
  return (
    <div className="grid gap-4">
      <Link href="/inventory" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Inventory
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          {fmtAmount(p.stockAmount)} {p.stockUnit} in stock{p.opened ? ` (${fmtAmount(p.opened)} opened)` : ""}
          {p.minStock > 0 ? ` · keep at least ${fmtAmount(p.minStock)}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {data.family.mealieFood ? <Badge>Ingredient: {data.family.mealieFood.name}</Badge> : <Badge variant="outline">Not linked to recipes</Badge>}
          {data.family.root ? <Badge variant="muted">Group: {data.family.root.name}</Badge> : null}
          {p.barcodes.map((b) => (
            <Badge key={b.barcode} variant="outline">
              {b.barcode}
              {b.amount ? ` = ${fmtAmount(b.amount)} ${b.unit ?? ""}` : ""}
            </Badge>
          ))}
        </div>
      </div>

      {data.family.availability.members.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Usable {data.family.mealieFood?.name ?? data.family.root?.name ?? ""}: {fmtAmount(data.family.availability.amount)} {data.family.availability.unitName}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm">
              {data.family.availability.members.map((m) => (
                <li key={m.productId} className="flex justify-between">
                  <Link href={`/inventory/${m.productId}`} className="hover:underline">
                    {m.name}
                  </Link>
                  <span className="text-muted-foreground">
                    {fmtAmount(m.amount)} {m.unitName}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Packages in stock</CardTitle>
        </CardHeader>
        <CardContent>
          {data.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-1 font-medium">Amount</th>
                  <th className="pb-1 font-medium">Best before</th>
                  <th className="pb-1 font-medium">Where</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="py-1.5">
                      {fmtAmount(e.amount)} {p.stockUnit} {e.opened ? <Badge variant="muted">opened</Badge> : null}
                    </td>
                    <td className="py-1.5">{e.bestBefore ? fmtDate(e.bestBefore) : "—"}</td>
                    <td className="py-1.5">{e.location ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Correct the count</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">Enter how much is actually there. The difference is recorded as an inventory correction.</p>
          <div className="flex gap-2">
            <Input inputMode="decimal" placeholder={`${fmtAmount(p.stockAmount)}`} value={count} onChange={(e) => setCount(e.target.value)} className="w-36" />
            <span className="self-center text-sm text-muted-foreground">{p.stockUnit}</span>
            <Button onClick={correct} disabled={busy || count === ""}>
              Save count
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent history</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-1 text-sm">
            {data.history.map((h) => (
              <li key={h.id} className="flex justify-between gap-2">
                <span className={h.undone ? "line-through text-muted-foreground" : ""}>
                  {TYPE_LABEL[h.type] ?? h.type} {fmtAmount(Math.abs(h.amount))} {p.stockUnit}
                </span>
                <span className="text-muted-foreground">{h.at ? fmtDate(h.at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usable portion</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          <p className="text-sm text-muted-foreground">For items with waste (bones, peel), the share that ends up in recipes. Leave empty for 100 %.</p>
          <div className="flex items-end gap-2">
            <Field label="Edible yield (%)">
              <Input inputMode="decimal" className="w-28" value={yieldPct ?? (data.edibleYield ? String(Math.round(data.edibleYield * 100)) : "")} onChange={(e) => setYieldPct(e.target.value)} />
            </Field>
            <Button variant="outline" onClick={saveYield} disabled={yieldPct === null}>
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {data.metadata ? (
        <Card>
          <CardHeader>
            <CardTitle>Nutrition & ingredients</CardTitle>
            <Badge variant={data.metadata.verification === "user_confirmed" ? "success" : "muted"}>
              {data.metadata.source === "openfoodfacts" ? "Open Food Facts" : "Manual"} · {data.metadata.verification === "user_confirmed" ? "confirmed" : "unverified"}
            </Badge>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {n ? (
              <>
                <p className="text-muted-foreground">Values {n.basis === "per_100ml" ? "per 100 mL" : n.basis === "per_100g" ? "per 100 g" : "(basis unknown)"}; blank means not provided by the source.</p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
                  {(["energyKcal", "protein", "carbohydrates", "fat", "fiber", "sugars", "sodium"] as const).map((k) => (
                    <div key={k} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{k === "energyKcal" ? "kcal" : k}</dt>
                      <dd className="tabular-nums">{n.per100[k] ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className="text-muted-foreground">No nutrition data available.</p>
            )}
            {data.metadata.data.allergens.length ? <p>Allergens: {data.metadata.data.allergens.join(", ")}</p> : null}
            {data.metadata.data.ingredientsText ? <p className="text-muted-foreground">{data.metadata.data.ingredientsText}</p> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
