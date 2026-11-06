"use client";

import { ChefHat, ChevronLeft, ChevronRight, Plus, Repeat, ShoppingCart, Sparkles, Trash2, UtensilsCrossed } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { PlanSheet } from "@/components/meals/plan-sheet";
import { RecipePicker, type RecipeListItem } from "@/components/meals/recipe-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorNote, Field, Input, Loading, PageHeader, Select } from "@/components/ui/primitives";
import type { PlanResult } from "@/lib/ai/planner";
import type { PlannedMeal } from "@/lib/meals/service";
import type { NeedsResult } from "@/lib/shopping/service";
import { api, useApi } from "@/lib/client";
import { addDaysIso, cn, fmtAmount, localToday, weekday } from "@/lib/utils";

interface MealsResponse {
  start: string;
  end: string;
  today: string;
  meals: PlannedMeal[];
}
interface Ref {
  meals: { slots: string[]; plannerSlots: string[]; defaultServings: number; showNutrition: boolean };
}

const SLOT_LABEL: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", side: "Side", dessert: "Dessert", drink: "Drink" };

function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return addDaysIso(iso, -((d.getUTCDay() + 6) % 7));
}

function MealsView() {
  const params = useSearchParams();
  const router = useRouter();
  const start = params.get("start") ?? mondayOf(localToday());
  const end = addDaysIso(start, 6);
  const { data, error, loading, reload } = useApi<MealsResponse>(`/api/meals?start=${start}&end=${end}`);
  const ref = useApi<Ref>("/api/reference");
  const needs = useApi<NeedsResult & { start: string; end: string }>(`/api/requirements?start=${start < localToday() ? localToday() : start}&end=${end}`);
  const [picking, setPicking] = useState<{ date: string; entryType: string; replace?: PlannedMeal } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [draftRun, setDraftRun] = useState<PlanResult | null>(null);
  const [editing, setEditing] = useState<PlannedMeal | null>(null);
  const [leftovers, setLeftovers] = useState<PlannedMeal | null>(null);

  // Opening a draft from a notification (?run=…).
  const runId = params.get("run");
  useEffect(() => {
    if (!runId) return;
    api<PlanResult>(`/api/meals/plan/${runId}`)
      .then((r) => {
        setDraftRun(r);
        setPlanning(true);
      })
      .catch((e: Error) => toast.error(e.message));
  }, [runId]);

  const slots = ref.data?.meals.slots ?? ["breakfast", "lunch", "dinner"];
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(start, i));
  const [showPast, setShowPast] = useState(false);
  // In the current week, earlier days are folded away so today is at the top on a phone.
  const todayIso = data?.today ?? localToday();
  const visibleDays = showPast ? days : days.filter((d) => d >= todayIso || (data?.meals.some((m) => m.date === d && !m.cooked && !m.leftoverOf) ?? false));
  const hiddenPast = days.length - visibleDays.length;
  const refresh = () => {
    void reload();
    void needs.reload();
  };

  async function pick(r: RecipeListItem) {
    if (!picking) return;
    try {
      if (picking.replace) {
        await api(`/api/meals/${picking.replace.id}`, { method: "PATCH", body: { recipeId: r.id, servings: r.servings || undefined } });
        toast.success(`Swapped in ${r.name}`);
      } else {
        await api("/api/meals", { body: { date: picking.date, entryType: picking.entryType, recipeId: r.id, servings: r.servings || ref.data?.meals.defaultServings } });
        toast.success(`Planned ${r.name}`);
      }
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove(m: PlannedMeal) {
    try {
      await api(`/api/meals/${m.id}`, { method: "DELETE" });
      toast(`Removed ${m.recipe?.name ?? m.title}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function buildLists() {
    try {
      const r = await api<{ items: unknown[]; created: number; updated: number; removed: number }>("/api/shopping/generate", { body: { start: start < localToday() ? localToday() : start, end } });
      toast.success(`Shopping lists updated (${r.items.length} items)`, { action: { label: "Open", onClick: () => router.push("/shopping") } });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Meals"
        subtitle={`${weekday(start)} – ${weekday(end)}`}
        actions={
          <>
            <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => router.replace(`/meals?start=${addDaysIso(start, -7)}`)}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon" aria-label="Next week" onClick={() => router.replace(`/meals?start=${addDaysIso(start, 7)}`)}>
              <ChevronRight />
            </Button>
            <Button onClick={() => { setDraftRun(null); setPlanning(true); }}>
              <Sparkles /> Plan
            </Button>
          </>
        }
      />

      {error ? <ErrorNote error={error} onRetry={reload} /> : null}
      {loading && !data ? <Loading /> : null}

      {hiddenPast > 0 ? (
        <button className="justify-self-start text-sm text-primary" onClick={() => setShowPast(true)}>
          Show {hiddenPast} earlier day{hiddenPast > 1 ? "s" : ""}
        </button>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {visibleDays.map((d) => {
          const dayMeals = data?.meals.filter((m) => m.date === d) ?? [];
          const isToday = d === data?.today;
          const empty = slots.filter((slot) => !dayMeals.some((m) => m.entryType === slot));
          return (
            <Card key={d} className={cn(isToday && "border-primary")}>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm">
                  {weekday(d)} {isToday ? <Badge className="ml-1">Today</Badge> : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                {dayMeals.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 rounded-md border bg-background/60 px-2.5 py-2">
                    <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(m)}>
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{SLOT_LABEL[m.entryType] ?? m.entryType}</span>
                      <span className="block truncate text-sm font-medium">{m.recipe?.name ?? (m.title || "Note")}</span>
                      <span className="text-xs text-muted-foreground">
                        {fmtAmount(m.plannedServings)} servings{m.recipe?.totalTime ? ` · ${m.recipe.totalTime}` : ""}
                      </span>
                    </button>
                    {m.cooked ? (
                      <Badge variant="success">Cooked</Badge>
                    ) : m.leftoverOf ? (
                      <Badge variant="muted">Leftovers</Badge>
                    ) : m.recipe ? (
                      <Button asChild size="sm" variant="secondary" aria-label={`Mark ${m.recipe.name} cooked`}>
                        <Link href={`/cook/${m.recipe.slug}?entry=${m.id}&servings=${m.plannedServings}`}>
                          <ChefHat /> Mark cooked
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                ))}
                {empty.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {empty.map((slot) => (
                      <button
                        key={slot}
                        className="flex h-8 items-center gap-1 rounded-full border border-dashed px-3 text-xs text-muted-foreground hover:bg-muted"
                        onClick={() => setPicking({ date: d, entryType: slot })}
                      >
                        <Plus className="size-3.5" /> {SLOT_LABEL[slot] ?? slot}
                      </button>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="size-4 text-muted-foreground" /> Ingredients needed this week
          </CardTitle>
          <Button size="sm" onClick={buildLists} disabled={!needs.data || needs.data.needs.length === 0}>
            Build shopping lists
          </Button>
        </CardHeader>
        <CardContent>
          {needs.loading && !needs.data ? <Loading /> : null}
          {needs.error ? <ErrorNote error={needs.error} onRetry={needs.reload} /> : null}
          {needs.data ? (
            <div className="grid gap-3 text-sm">
              {needs.data.requirements.length === 0 && needs.data.unresolved.length === 0 ? <p className="text-muted-foreground">No tracked ingredients needed for the remaining planned meals.</p> : null}
              <ul className="grid gap-1">
                {needs.data.requirements.map((r) => (
                  <li key={r.productId} className="flex items-center justify-between gap-2">
                    <span>{r.foodName}</span>
                    <span className={cn("tabular-nums", r.shortfall > 0 ? "text-danger" : "text-muted-foreground")}>
                      {r.shortfall > 0 ? `need ${fmtAmount(r.shortfall)} more` : "have enough"} · {fmtAmount(r.required)} {r.unitName} total
                    </span>
                  </li>
                ))}
              </ul>
              {needs.data.unresolved.length ? (
                <div className="rounded-md bg-warning-soft p-3 text-warning">
                  <p className="font-medium">Not checked against inventory:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {needs.data.unresolved.map((u, i) => (
                      <li key={i}>
                        {u.foodName ?? u.display} — {u.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <RecipePicker
        open={!!picking}
        onOpenChange={(o) => !o && setPicking(null)}
        onPick={pick}
        title={picking?.replace ? `Swap ${picking.replace.recipe?.name ?? "meal"}` : picking ? `${SLOT_LABEL[picking.entryType] ?? picking.entryType}, ${weekday(picking.date)}` : ""}
      />

      {editing ? (
        <MealSheet
          meal={editing}
          slots={slots}
          onClose={() => setEditing(null)}
          onChanged={refresh}
          onSwap={() => {
            setPicking({ date: editing.date, entryType: editing.entryType, replace: editing });
            setEditing(null);
          }}
          onRemove={() => {
            void remove(editing);
            setEditing(null);
          }}
          onLeftovers={() => {
            setLeftovers(editing);
            setEditing(null);
          }}
        />
      ) : null}

      {leftovers ? <LeftoversSheet meal={leftovers} onClose={() => setLeftovers(null)} onDone={refresh} /> : null}

      {ref.data ? (
        <PlanSheet
          key={draftRun?.runId ?? "new"}
          open={planning}
          onOpenChange={setPlanning}
          start={start < localToday() ? localToday() : start}
          slots={slots}
          defaultSlots={ref.data.meals.plannerSlots}
          defaultServings={ref.data.meals.defaultServings}
          initialRun={draftRun}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

function MealSheet({ meal, slots, onClose, onChanged, onSwap, onRemove, onLeftovers }: { meal: PlannedMeal; slots: string[]; onClose: () => void; onChanged: () => void; onSwap: () => void; onRemove: () => void; onLeftovers: () => void }) {
  const [servings, setServings] = useState(String(meal.plannedServings));
  const [date, setDate] = useState(meal.date);
  const [slot, setSlot] = useState<string>(meal.entryType);

  async function save() {
    try {
      const body: Record<string, unknown> = {};
      if (date !== meal.date) body.date = date;
      if (slot !== meal.entryType) body.entryType = slot;
      if (Number(servings) !== meal.plannedServings && !meal.cooked) body.servings = Number(servings);
      if (Object.keys(body).length) await api(`/api/meals/${meal.id}`, { method: "PATCH", body });
      onChanged();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={meal.recipe?.name ?? meal.title}
      description={meal.cooked ? "Already cooked — inventory was deducted." : meal.leftoverOf ? "Leftovers — no inventory is deducted." : "Planned meal"}
      footer={
        <>
          {!meal.cooked ? (
            <Button variant="ghost" onClick={onRemove}>
              <Trash2 /> Remove
            </Button>
          ) : null}
          {!meal.cooked && !meal.leftoverOf ? (
            <Button variant="outline" onClick={onSwap}>
              <Repeat /> Swap
            </Button>
          ) : null}
          <Button onClick={save}>Save</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Day">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Meal">
            <Select value={slot} onChange={(e) => setSlot(e.target.value)}>
              {slots.map((s) => (
                <option key={s} value={s}>
                  {SLOT_LABEL[s] ?? s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Servings">
            <Input inputMode="decimal" value={servings} disabled={!!meal.cooked} onChange={(e) => setServings(e.target.value)} />
          </Field>
        </div>
        {meal.cooked ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href={`/cook/${meal.recipe?.slug}?occurrence=${meal.cooked.occurrenceId}`}>View cooking record</Link>
            </Button>
            <Button variant="secondary" onClick={onLeftovers}>
              <UtensilsCrossed /> Plan leftovers
            </Button>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function LeftoversSheet({ meal, onClose, onDone }: { meal: PlannedMeal; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(addDaysIso(meal.date, 1));
  const [slot, setSlot] = useState("lunch");
  const [servings, setServings] = useState("2");
  async function save() {
    try {
      await api("/api/meals/leftovers", { body: { occurrenceId: meal.cooked!.occurrenceId, date, entryType: slot, servings: Number(servings) } });
      toast.success("Leftovers planned");
      onDone();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`Leftovers: ${meal.recipe?.name ?? ""}`} description="Eating leftovers doesn’t deduct inventory again." footer={<Button onClick={save}>Plan leftovers</Button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Day">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Meal">
          <Select value={slot} onChange={(e) => setSlot(e.target.value)}>
            {["breakfast", "lunch", "dinner", "snack"].map((s) => (
              <option key={s} value={s}>
                {SLOT_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Servings">
          <Input inputMode="decimal" value={servings} onChange={(e) => setServings(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}

export default function MealsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <MealsView />
    </Suspense>
  );
}
