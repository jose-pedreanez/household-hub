"use client";

import { ArrowLeft, CheckCircle2, ChefHat, CircleAlert, Clock, RotateCcw, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ProductSearch, type ProductHit } from "@/components/product-search";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorNote, Field, Input, Loading, Select, Spinner } from "@/components/ui/primitives";
import type { CookingView } from "@/lib/cooking/execute";
import type { JournalLine } from "@/lib/cooking/journal";
import type { CookingPlan, ExtraLine, LineOverride, PlanLine } from "@/lib/cooking/plan";
import type { PlannedMeal } from "@/lib/meals/service";
import { ApiError, api, newKey } from "@/lib/client";
import { addDaysIso, cn, fmtAmount, fmtDate, localToday, weekday } from "@/lib/utils";

const STATUS: Record<PlanLine["status"], { label: string; variant: "success" | "warning" | "danger" | "muted" }> = {
  ok: { label: "In stock", variant: "success" },
  short: { label: "Not enough", variant: "warning" },
  unmapped: { label: "Not linked", variant: "danger" },
  mapping_unavailable: { label: "Sync offline", variant: "danger" },
  unconvertible: { label: "Unit unknown", variant: "danger" },
  skipped: { label: "Skipped", variant: "muted" },
  not_tracked: { label: "Not tracked", variant: "muted" },
  no_quantity: { label: "To taste", variant: "muted" },
};

function CookView({ slug }: { slug: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const occurrenceParam = params.get("occurrence");
  const [entryId, setEntryId] = useState<number | null>(params.get("entry") ? Number(params.get("entry")) : null);
  const [servings, setServings] = useState(params.get("servings") ?? "");
  const [leftover, setLeftover] = useState("0");
  const [overrides, setOverrides] = useState<Record<string, LineOverride>>({});
  const [extras, setExtras] = useState<Array<ExtraLine & { name: string; unit: string }>>([]);
  const [plan, setPlan] = useState<CookingPlan | null>(null);
  const [already, setAlready] = useState<{ occurrenceId: string } | null>(null);
  const [record, setRecord] = useState<CookingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [matched, setMatched] = useState<PlannedMeal | null>(null);
  const keyRef = useRef<{ key: string; payload: string } | null>(null);

  const request = useMemo(
    () => ({
      recipeSlug: slug,
      mealplanEntryId: entryId,
      servings: Number(servings) || 0,
      leftoverServings: Number(leftover) || 0,
      overrides,
      extras: extras.map(({ productId, amount, note }) => ({ productId, amount, note })),
    }),
    [slug, entryId, servings, leftover, overrides, extras],
  );

  // Opened from a Mealie recipe action (no plan entry): offer to attach to a matching planned meal.
  useEffect(() => {
    if (entryId || occurrenceParam) return;
    const t = localToday();
    api<{ meals: PlannedMeal[] }>(`/api/meals?start=${addDaysIso(t, -1)}&end=${addDaysIso(t, 1)}`)
      .then((r) => setMatched(r.meals.find((m) => m.recipe?.slug === slug && !m.cooked && !m.leftoverOf) ?? null))
      .catch(() => undefined);
  }, [entryId, occurrenceParam, slug]);

  useEffect(() => {
    if (!occurrenceParam) return;
    let cancelled = false;
    api<CookingView>(`/api/cook/${occurrenceParam}`).then(
      (v) => !cancelled && setRecord(v),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [occurrenceParam]);

  // Preview (debounced) whenever the request changes.
  useEffect(() => {
    if (occurrenceParam || record) return;
    const t = setTimeout(async () => {
      try {
        const body = { ...request, servings: request.servings || 1 };
        const r = await api<{ plan: CookingPlan; alreadyCooked: { occurrenceId: string } | null }>("/api/cook/preview", { body });
        setPlan(r.plan);
        setAlready(r.alreadyCooked);
        if (!servings) setServings(String(r.plan.recipe.baseServings || 1));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [request, occurrenceParam, record, servings]);

  const setOverride = (key: string, o: Partial<LineOverride> | null) =>
    setOverrides((cur) => {
      const next = { ...cur };
      if (o === null) delete next[key];
      else next[key] = Object.fromEntries(Object.entries({ ...cur[key], ...o }).filter(([, v]) => v !== undefined && v !== false && v !== "")) as LineOverride;
      return next;
    });

  async function cook() {
    const payload = JSON.stringify(request);
    // Same intent → same key (safe retries); any change → new key.
    if (!keyRef.current || keyRef.current.payload !== payload) keyRef.current = { key: newKey("cook"), payload };
    setBusy(true);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const v = await api<CookingView>("/api/cook", { body: { ...request, idempotencyKey: keyRef.current.key } });
        setRecord(v);
        if (v.occurrence.status === "completed") toast.success("Recorded — inventory updated");
        else toast.warning("Some ingredients were not deducted yet; see below.");
        router.replace(`/cook/${slug}?occurrence=${v.occurrence.id}`);
        break;
      } catch (e) {
        if (e instanceof TypeError && attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
          continue;
        }
        if (e instanceof ApiError && e.code === "conflict" && (e.details as { occurrenceId?: string })?.occurrenceId) {
          router.replace(`/cook/${slug}?occurrence=${(e.details as { occurrenceId: string }).occurrenceId}`);
        }
        setError((e as Error).message);
        break;
      }
    }
    setBusy(false);
  }

  if (record || occurrenceParam) {
    return record ? <RecordView view={record} onChange={setRecord} /> : error ? <ErrorNote error={error} /> : <Loading />;
  }

  return (
    <div className="grid gap-4">
      <Link href="/meals" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Meals
      </Link>
      <div>
        <p className="text-sm text-muted-foreground">We cooked</p>
        <h1 className="text-2xl font-semibold tracking-tight">{plan?.recipe.name ?? slug}</h1>
      </div>

      {already ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-warning p-3 text-sm">
          <span>This planned meal is already recorded as cooked, so it can’t be deducted again.</span>
          <Button size="sm" variant="outline" onClick={() => router.replace(`/cook/${slug}?occurrence=${already.occurrenceId}`)}>
            View cooking record
          </Button>
        </Card>
      ) : null}
      {matched && !entryId ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
          <span>
            Planned for {weekday(matched.date)} ({matched.entryType}). Record it against that plan entry?
          </span>
          <Button size="sm" onClick={() => { setEntryId(matched.id); setServings(String(matched.plannedServings)); }}>
            Yes, link it
          </Button>
        </Card>
      ) : null}

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
          <Field label="Servings prepared" hint={plan?.recipe.baseServings ? `Recipe makes ${fmtAmount(plan.recipe.baseServings)}` : undefined}>
            <Input inputMode="decimal" value={servings} onChange={(e) => setServings(e.target.value)} />
          </Field>
          <Field label="Of which leftovers" hint="Saved for later meals; nothing extra is deducted when you eat them.">
            <Input inputMode="decimal" value={leftover} onChange={(e) => setLeftover(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <p className="text-xs text-muted-foreground">{plan?.warnings.join(" ")}</p>
          </div>
        </CardContent>
      </Card>

      {error ? <ErrorNote error={error} /> : null}
      {!plan && !error ? <Loading label="Checking inventory…" /> : null}

      {plan ? (
        <Card className="divide-y">
          {plan.lines.map((l) => (
            <LineEditor key={l.key} line={l} override={overrides[l.key] ?? {}} onOverride={(o) => setOverride(l.key, o)} />
          ))}
          {extras.map((x, i) => (
            <div key={`x${i}`} className="flex items-center justify-between gap-2 p-3 text-sm">
              <span>
                Added: {x.name} · {fmtAmount(x.amount)} {x.unit}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setExtras((e) => e.filter((_, n) => n !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <ExtraAdder onAdd={(p, amount) => setExtras((e) => [...e, { productId: p.id, amount, name: p.name, unit: p.stockUnit, note: p.name }])} />
        </Card>
      ) : null}

      <div className="sticky bottom-[5.25rem] z-10 flex items-center justify-between gap-3 rounded-xl border bg-card p-3 shadow-lg md:bottom-4">
        <p className="text-sm text-muted-foreground">
          {!plan
            ? "Checking inventory…"
            : already
              ? "Already recorded."
              : plan.blocking
                ? `${plan.lines.filter((l) => l.blocking).length} line(s) need a decision above.`
                : `${plan.lines.reduce((n, l) => n + l.allocations.length, 0)} item(s) will be taken from inventory.`}
        </p>
        <Button size="lg" onClick={cook} disabled={!plan || plan.blocking || busy || !!already}>
          {busy ? <Spinner /> : <ChefHat />} Mark as cooked
        </Button>
      </div>
    </div>
  );
}

function LineEditor({ line, override, onOverride }: { line: PlanLine; override: LineOverride; onOverride: (o: Partial<LineOverride> | null) => void }) {
  const s = STATUS[line.status];
  const [picking, setPicking] = useState(false);
  return (
    <div className={cn("grid gap-2 p-3", line.blocking && "bg-danger-soft/40")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{line.display}</p>
          {line.target ? (
            <p className="text-xs text-muted-foreground">
              Uses {fmtAmount(line.target.amount)} {line.target.unitName} of {line.target.productName}
              {line.available !== null ? ` · have ${fmtAmount(line.available)}` : ""}
              {line.substitutedFrom ? ` · instead of ${line.substitutedFrom}` : ""}
            </p>
          ) : null}
        </div>
        <Badge variant={s.variant}>{s.label}</Badge>
      </div>
      {line.allocations.length ? (
        <ul className="grid gap-0.5 text-xs text-muted-foreground">
          {line.allocations.map((a) => (
            <li key={a.stockId}>
              − {fmtAmount(a.amountStock)} {a.stockUnitName} {a.productName}
              {a.bestBeforeDate ? ` (best before ${fmtDate(a.bestBeforeDate)})` : ""}
              {a.opened ? " · opened" : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {line.issues.length ? <p className="text-xs text-warning">{line.issues.join(" ")}</p> : null}

      {line.kind === "recipe" && line.status !== "not_tracked" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={!!override.skip} onChange={(e) => onOverride({ skip: e.target.checked || undefined })} /> Didn’t use
          </label>
          {!override.skip && line.target ? (
            <label className="flex items-center gap-1.5">
              Used
              <Input
                className="h-8 w-24"
                inputMode="decimal"
                placeholder={fmtAmount(line.target.amount)}
                value={override.amount ?? ""}
                onChange={(e) => onOverride({ amount: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
              />
              {line.target.unitName}
            </label>
          ) : null}
          {line.status === "short" ? (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!override.acceptShortfall} onChange={(e) => onOverride({ acceptShortfall: e.target.checked || undefined })} /> Use what’s there
            </label>
          ) : null}
          {line.substitutions.length ? (
            <Select className="h-8 w-auto" value={override.substituteFoodId ?? ""} onChange={(e) => onOverride({ substituteFoodId: e.target.value || undefined })}>
              <option value="">No substitute</option>
              {line.substitutions.map((s) => (
                <option key={s.foodId} value={s.foodId}>
                  Use {s.foodName}
                  {s.available !== null ? ` (have ${fmtAmount(s.available)} ${s.unitName ?? ""})` : " (not linked)"}
                </option>
              ))}
            </Select>
          ) : null}
          {(line.status === "unmapped" || line.status === "unconvertible") && !override.skip ? (
            <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
              {override.productId ? "Change product" : "Choose product"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Sheet open={picking} onOpenChange={setPicking} title={`What did you use for “${line.foodName ?? line.display}”?`} description="This choice applies to this meal only. Link the ingredient permanently in Grocy-Mealie Sync.">
        <ProductSearch
          onPick={(p: ProductHit) => {
            onOverride({ productId: p.id });
            setPicking(false);
          }}
        />
      </Sheet>
    </div>
  );
}

function ExtraAdder({ onAdd }: { onAdd: (p: ProductHit, amount: number) => void }) {
  const [product, setProduct] = useState<ProductHit | null>(null);
  const [amount, setAmount] = useState("");
  return (
    <div className="grid gap-2 p-3">
      <p className="text-sm font-medium">Added something not in the recipe?</p>
      {product ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{product.name}</span>
          <Input className="h-8 w-24" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="amount" />
          <span>{product.stockUnit}</span>
          <Button
            size="sm"
            disabled={!(Number(amount) > 0)}
            onClick={() => {
              onAdd(product, Number(amount));
              setProduct(null);
              setAmount("");
            }}
          >
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setProduct(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <ProductSearch onPick={setProduct} placeholder="Search inventory to add" />
      )}
    </div>
  );
}

const LINE_ICON: Record<JournalLine["status"], React.ReactNode> = {
  consumed: <CheckCircle2 className="size-4 text-success" />,
  reversed: <Undo2 className="size-4 text-muted-foreground" />,
  skipped: <span className="text-xs text-muted-foreground">skipped</span>,
  failed: <CircleAlert className="size-4 text-danger" />,
  uncertain: <Clock className="size-4 text-warning" />,
  submitting: <Clock className="size-4 text-warning" />,
  pending: <Clock className="size-4 text-muted-foreground" />,
};

function RecordView({ view, onChange }: { view: CookingView; onChange: (v: CookingView) => void }) {
  const o = view.occurrence;
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState<JournalLine | null>(null);
  const [amount, setAmount] = useState("");

  async function act(url: string, body: unknown = {}) {
    setBusy(true);
    try {
      onChange(await api<CookingView>(url, { body }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusBadge =
    o.status === "completed" ? <Badge variant="success">Recorded</Badge> : o.status === "reversed" ? <Badge variant="muted">Reversed</Badge> : o.status === "partial" || o.status === "failed" ? <Badge variant="warning">Needs attention</Badge> : <Badge variant="muted">{o.status}</Badge>;

  return (
    <div className="grid gap-4">
      <Link href="/meals" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Meals
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Cooked {fmtDate(o.createdAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {fmtAmount(o.servings)} servings
            {o.leftoverServings ? ` (${fmtAmount(o.leftoverServings)} leftovers)` : ""}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{o.recipeName}</h1>
        </div>
        {statusBadge}
      </div>
      {o.error ? <ErrorNote error={o.error} /> : null}
      {o.status === "completed" && !o.mealieSynced ? <p className="text-xs text-muted-foreground">Mealie’s “last made” will be updated when Mealie is reachable.</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Taken from inventory</CardTitle>
        </CardHeader>
        <CardContent>
          {view.lines.length === 0 ? <p className="text-sm text-muted-foreground">No tracked ingredients were used.</p> : null}
          <ul className="divide-y">
            {view.lines.map((l) => (
              <li key={l.lineNo} className="flex items-center gap-3 py-2 text-sm">
                {LINE_ICON[l.status]}
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate", l.status === "reversed" && "line-through text-muted-foreground")}>
                    {fmtAmount(l.amount)} {l.unitName} {l.productName}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {l.kind === "correction" ? `correction of line ${l.correctsLineNo}` : l.description}
                    {l.error && l.status !== "consumed" ? ` · ${l.error}` : ""}
                  </p>
                </div>
                {l.status === "consumed" && o.status !== "reversed" ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setCorrecting(l); setAmount(String(l.amount)); }}>
                    Correct
                  </Button>
                ) : null}
                {(l.status === "failed" || l.status === "pending") && o.status !== "reversed" ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(`/api/cook/${o.id}/lines/${l.lineNo}`, { action: "skip" })}>
                    Skip
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        {o.status === "partial" || o.status === "failed" || o.status === "executing" ? (
          <Button disabled={busy} onClick={() => act(`/api/cook/${o.id}/retry`)}>
            <RotateCcw /> Retry
          </Button>
        ) : null}
        {o.status !== "reversed" ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Put every ingredient back into inventory and un-mark this meal as cooked?")) void act(`/api/cook/${o.id}/reverse`);
            }}
          >
            <Undo2 /> Undo cooking
          </Button>
        ) : null}
      </div>

      <Sheet
        open={!!correcting}
        onOpenChange={(v) => !v && setCorrecting(null)}
        title={`Correct ${correcting?.productName ?? ""}`}
        description="Enter how much was actually used. The original deduction is undone and the corrected amount recorded."
        footer={
          <Button
            disabled={busy || !(Number(amount) >= 0)}
            onClick={async () => {
              const l = correcting!;
              setCorrecting(null);
              await act(`/api/cook/${o.id}/lines/${l.lineNo}`, { action: "correct", amount: Number(amount) });
            }}
          >
            Save correction
          </Button>
        }
      >
        <Field label={`Amount used (${correcting?.unitName ?? ""})`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </Sheet>
    </div>
  );
}

export default function CookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return (
    <Suspense fallback={<Loading />}>
      <CookView slug={slug} />
    </Suspense>
  );
}
