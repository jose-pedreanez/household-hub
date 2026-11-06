"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Sheet } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge, ErrorNote, Field, Input, Select } from "@/components/ui/primitives";
import type { UnknownBarcode } from "@/lib/barcode/resolve";
import type { RegisterResult } from "@/lib/barcode/register";
import { api, newKey } from "@/lib/client";
import { canonicalUnit, isCountUnitName, unitDimension } from "@/lib/units/builtin";
import { fmtAmount } from "@/lib/utils";

export interface Reference {
  locations: Array<{ id: number; name: string }>;
  units: Array<{ id: number; name: string; plural: string | null }>;
  stores: Array<{ id: number; name: string }>;
  productGroups: Array<{ id: number; name: string }>;
}

type LinkChoice = { kind: "none" } | { kind: "food"; id: string } | { kind: "parent"; id: number } | { kind: "new_food" };

function unitIdFor(ref: Reference, unit: string | null | undefined): number | null {
  if (!unit) return null;
  if (unit === "piece") return ref.units.find((u) => isCountUnitName(u.name) || isCountUnitName(u.plural))?.id ?? null;
  return ref.units.find((u) => canonicalUnit(u.name) === unit || canonicalUnit(u.plural) === unit)?.id ?? null;
}

/** The unit stock is counted in: grams for weights, millilitres for liquids, pieces for counts. */
function stockUnitFor(ref: Reference, packageUnit: string | null): number | null {
  if (!packageUnit) return null;
  if (packageUnit === "piece") return unitIdFor(ref, "piece");
  const dim = unitDimension(packageUnit);
  return unitIdFor(ref, dim === "mass" ? "g" : dim === "volume" ? "ml" : packageUnit);
}

export function RegisterSheet({
  open,
  onOpenChange,
  data,
  reference,
  defaultLocationId,
  defaultStoreId,
  onRegistered,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: UnknownBarcode;
  reference: Reference;
  defaultLocationId: number | null;
  defaultStoreId: number | null;
  onRegistered: (r: RegisterResult) => void;
}) {
  const meta = data.off.status === "found" ? data.off.metadata : null;
  const suggestedFood = !data.suggestions.ambiguous ? data.suggestions.foods[0] : undefined;
  const [name, setName] = useState(meta?.name ?? "");
  const [brand, setBrand] = useState(meta?.brand ?? "");
  const [packageAmount, setPackageAmount] = useState<string>(meta?.packageAmount ? String(meta.packageAmount) : "");
  const [packageQuId, setPackageQuId] = useState<number | null>(unitIdFor(reference, meta?.packageUnit) ?? null);
  const [stockQuId, setStockQuId] = useState<number | null>(stockUnitFor(reference, meta?.packageUnit ?? null));
  const [locationId, setLocationId] = useState<number | null>(defaultLocationId ?? reference.locations[0]?.id ?? null);
  const [storeId, setStoreId] = useState<number | null>(defaultStoreId);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [shelf, setShelf] = useState<string>("0");
  const [minStock, setMinStock] = useState("0");
  const [link, setLink] = useState<LinkChoice | null>(suggestedFood ? { kind: "food", id: suggestedFood.id } : null);
  const [newFoodName, setNewFoodName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useMemo(() => newKey("reg"), []);

  const ready = name.trim() && Number(packageAmount) > 0 && packageQuId && stockQuId && locationId && link && (link.kind !== "new_food" || newFoodName.trim());

  async function save() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        idempotencyKey: key,
        barcode: data.barcode,
        name: name.trim(),
        brand: brand.trim() || undefined,
        stockQuId,
        packageAmount: Number(packageAmount),
        packageQuId,
        locationId,
        shoppingLocationId: storeId ?? undefined,
        productGroupId: groupId ?? undefined,
        defaultBestBeforeDays: Number(shelf),
        minStockAmount: Number(minStock) || 0,
        confirmMetadata: !!meta,
        link:
          link!.kind === "food"
            ? { kind: "food", mealieFoodId: link!.id }
            : link!.kind === "parent"
              ? { kind: "parent", parentProductId: link!.id }
              : link!.kind === "new_food"
                ? { kind: "new_food", foodName: newFoodName.trim() }
                : { kind: "none" },
      };
      const r = await api<RegisterResult>("/api/products/register", { body });
      r.warnings.forEach((w) => toast.warning(w));
      onRegistered(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const unitOptions = reference.units.map((u) => (
    <option key={u.id} value={u.id}>
      {u.name}
    </option>
  ));

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="New product"
      description={`Barcode ${data.barcode} is not registered yet. Confirm the details once; later scans are instant.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!ready || busy}>
            {busy ? "Saving…" : "Save product"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {data.off.status === "error" ? <ErrorNote error={`Open Food Facts lookup failed (${data.off.message}). Enter the details by hand.`} /> : null}
        {data.off.status === "not_found" ? <p className="text-sm text-muted-foreground">Open Food Facts doesn’t know this barcode. Enter the details by hand.</p> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Product name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spaghetti" />
          </Field>
          <Field label="Brand">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="One package contains" hint={meta?.quantityText ? `Label says “${meta.quantityText}”` : undefined}>
            <div className="flex gap-2">
              <Input inputMode="decimal" value={packageAmount} onChange={(e) => setPackageAmount(e.target.value)} placeholder="500" className="w-28" />
              <Select value={packageQuId ?? ""} onChange={(e) => setPackageQuId(Number(e.target.value) || null)}>
                <option value="">Unit…</option>
                {unitOptions}
              </Select>
            </div>
          </Field>
          <Field label="Count stock in" hint="Recipes are deducted in this unit.">
            <Select value={stockQuId ?? ""} onChange={(e) => setStockQuId(Number(e.target.value) || null)}>
              <option value="">Unit…</option>
              {unitOptions}
            </Select>
          </Field>
          <Field label="Stored in">
            <Select value={locationId ?? ""} onChange={(e) => setLocationId(Number(e.target.value) || null)}>
              {reference.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Usually bought at">
            <Select value={storeId ?? ""} onChange={(e) => setStoreId(Number(e.target.value) || null)}>
              <option value="">—</option>
              {reference.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Select value={groupId ?? ""} onChange={(e) => setGroupId(Number(e.target.value) || null)}>
              <option value="">—</option>
              {reference.productGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Keeps for" hint="Sets the expiration date when you scan it.">
            <Select value={shelf} onChange={(e) => setShelf(e.target.value)}>
              <option value="0">No default (set when scanning)</option>
              <option value="-1">Never expires</option>
              {[3, 5, 7, 10, 14, 21, 30, 60, 90, 180, 365, 730].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Keep at least" hint="Below this it goes on the low-stock list (stock unit).">
            <Input inputMode="decimal" value={minStock} onChange={(e) => setMinStock(e.target.value)} />
          </Field>
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">
            Which ingredient is this?{" "}
            {data.suggestions.ambiguous ? <Badge variant="warning">Please choose</Badge> : <Badge variant="muted">Suggested</Badge>}
          </legend>
          <p className="text-xs text-muted-foreground">Recipes use ingredients like “Pasta”; this product will count toward it. Nothing is linked without your choice.</p>
          <div className="grid gap-1.5">
            {data.suggestions.foods.map((f) => (
              <label key={f.id} className="flex items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-secondary">
                <input type="radio" name="link" checked={link?.kind === "food" && link.id === f.id} onChange={() => setLink({ kind: "food", id: f.id })} />
                <span className="flex-1">{f.name}</span>
                <span className="text-xs text-muted-foreground">{Math.round(f.score * 100)}% match</span>
              </label>
            ))}
            {data.suggestions.products
              .filter((p) => p.generic)
              .map((p) => (
                <label key={p.id} className="flex items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-secondary">
                  <input type="radio" name="link" checked={link?.kind === "parent" && link.id === p.id} onChange={() => setLink({ kind: "parent", id: p.id })} />
                  <span className="flex-1">{p.name} (Grocy group)</span>
                </label>
              ))}
            <label className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-secondary">
              <input type="radio" name="link" checked={link?.kind === "new_food"} onChange={() => setLink({ kind: "new_food" })} />
              <span>New ingredient:</span>
              <Input className="h-8 flex-1" value={newFoodName} onChange={(e) => { setNewFoodName(e.target.value); setLink({ kind: "new_food" }); }} placeholder="e.g. Pasta" />
            </label>
            <label className="flex items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-secondary">
              <input type="radio" name="link" checked={link?.kind === "none"} onChange={() => setLink({ kind: "none" })} />
              <span>Don’t link (not used in recipes)</span>
            </label>
          </div>
        </fieldset>

        {meta?.nutrition ? (
          <details className="rounded-md border p-3 text-sm">
            <summary className="cursor-pointer font-medium">
              Nutrition ({meta.nutrition.basis === "per_100ml" ? "per 100 mL" : meta.nutrition.basis === "per_100g" ? "per 100 g" : "basis unknown"})
              <Badge variant="muted" className="ml-2">
                Open Food Facts · unverified
              </Badge>
            </summary>
            <table className="mt-2 w-full text-left">
              <tbody>
                {(
                  [
                    ["Energy", "energyKcal", "kcal"],
                    ["Protein", "protein", "g"],
                    ["Carbohydrates", "carbohydrates", "g"],
                    ["Sugars", "sugars", "g"],
                    ["Fat", "fat", "g"],
                    ["Fiber", "fiber", "g"],
                    ["Sodium", "sodium", "g"],
                  ] as const
                ).map(([label, k, unit]) => (
                  <tr key={k} className="border-t">
                    <td className="py-1">{label}</td>
                    <td className="py-1 text-right">{meta.nutrition!.per100[k] === null || meta.nutrition!.per100[k] === undefined ? "not provided" : `${fmtAmount(meta.nutrition!.per100[k])} ${unit}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {meta.allergens.length ? <p className="mt-2">Allergens: {meta.allergens.join(", ")}</p> : null}
            {meta.ingredientsText ? <p className="mt-1 text-muted-foreground">{meta.ingredientsText}</p> : null}
          </details>
        ) : null}
        {error ? <ErrorNote error={error} /> : null}
      </div>
    </Sheet>
  );
}
