"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Sheet } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge, ErrorNote, Field, Input, Select, Spinner } from "@/components/ui/primitives";
import type { PlanResult } from "@/lib/ai/planner";
import { api } from "@/lib/client";
import { weekday } from "@/lib/utils";

const SLOT_LABEL: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", side: "Side", dessert: "Dessert", drink: "Drink" };

/** Pre-tick every suggestion except new-recipe proposals, which need approval first. */
function acceptable(run: PlanResult | null): Set<number> {
  return new Set((run?.meals ?? []).map((m, i) => (m.proposalId ? -1 : i)).filter((i) => i >= 0));
}

export function PlanSheet({
  open,
  onOpenChange,
  start,
  slots,
  defaultSlots,
  defaultServings,
  initialRun,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  start: string;
  slots: string[];
  defaultSlots: string[];
  defaultServings: number;
  initialRun?: PlanResult | null;
  onSaved: () => void;
}) {
  const [days, setDays] = useState(7);
  const [chosenSlots, setChosenSlots] = useState<string[]>(defaultSlots);
  const [servings, setServings] = useState(String(defaultServings));
  const [note, setNote] = useState("");
  const [result, setResult] = useState<PlanResult | null>(initialRun ?? null);
  const [accepted, setAccepted] = useState<Set<number>>(() => acceptable(initialRun ?? null));
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"plan" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate(useAi: boolean) {
    setBusy("plan");
    setError(null);
    try {
      const r = await api<PlanResult>("/api/meals/plan", { body: { start, days, slots: chosenSlots, servings: Number(servings) || undefined, note: note || undefined, useAi } });
      setResult(r);
      setAccepted(acceptable(r));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function decide(proposalId: string, decision: "approve" | "reject", index: number) {
    try {
      await api(`/api/meals/proposals/${proposalId}`, { body: { decision } });
      if (decision === "approve") {
        setApproved((s) => new Set(s).add(proposalId));
        setAccepted((s) => new Set(s).add(index));
        toast.success("Recipe added to Mealie");
      } else {
        setAccepted((s) => {
          const n = new Set(s);
          n.delete(index);
          return n;
        });
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function save() {
    if (!result) return;
    setBusy("save");
    try {
      const r = await api<{ created: unknown[]; skipped: string[] }>("/api/meals/plan/apply", { body: { runId: result.runId, accept: [...accepted] } });
      toast.success(`Added ${r.created.length} meal${r.created.length === 1 ? "" : "s"} to the plan`);
      r.skipped.forEach((s) => toast.warning(s));
      onSaved();
      onOpenChange(false);
      setResult(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Plan meals"
      description="Suggestions favour what you have, especially items expiring soon. Nothing is saved until you choose."
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={() => setResult(null)}>
              Start over
            </Button>
            <Button onClick={save} disabled={busy !== null || accepted.size === 0}>
              {busy === "save" ? <Spinner /> : null} Save {accepted.size} to plan
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => generate(false)} disabled={busy !== null || chosenSlots.length === 0}>
              Quick suggestions
            </Button>
            <Button onClick={() => generate(true)} disabled={busy !== null || chosenSlots.length === 0}>
              {busy === "plan" ? <Spinner /> : <Sparkles />} Plan with AI
            </Button>
          </>
        )
      }
    >
      {error ? <ErrorNote error={error} /> : null}
      {!result ? (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Days">
              <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 7, 10, 14].map((d) => (
                  <option key={d} value={d}>
                    {d} day{d > 1 ? "s" : ""} from {weekday(start)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Servings per meal">
              <Input inputMode="decimal" value={servings} onChange={(e) => setServings(e.target.value)} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Meals to plan</legend>
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <label key={s} className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-secondary">
                  <input type="checkbox" checked={chosenSlots.includes(s)} onChange={(e) => setChosenSlots((c) => (e.target.checked ? [...c, s] : c.filter((x) => x !== s)))} />
                  {SLOT_LABEL[s] ?? s}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Anything to consider?" hint="e.g. “quick weeknights”, “guests on Saturday”. Only empty slots are filled.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {busy === "plan" ? <p className="text-sm text-muted-foreground">Looking at your inventory and recipes…</p> : null}
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={result.source === "heuristic" ? "muted" : "default"}>
              {result.source === "heuristic" ? "Built-in planner" : result.source === "mixed" ? "AI + built-in" : `AI (${result.model ?? result.provider})`}
            </Badge>
            {result.cached ? <Badge variant="outline">Same as a moment ago</Badge> : null}
          </div>
          {result.issues.length ? (
            <ul className="grid gap-1 rounded-md bg-warning-soft p-3 text-xs text-warning">
              {result.issues.map((i, n) => (
                <li key={n}>{i}</li>
              ))}
            </ul>
          ) : null}
          {result.notes ? <p className="text-sm">{result.notes}</p> : null}
          <ul className="grid gap-2">
            {result.meals.map((m, i) => {
              const needsApproval = !!m.proposalId && !approved.has(m.proposalId);
              return (
                <li key={`${m.date}-${m.entryType}`} className="rounded-md border p-3">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={needsApproval}
                      checked={accepted.has(i)}
                      onChange={(e) =>
                        setAccepted((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(i);
                          else n.delete(i);
                          return n;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-muted-foreground">
                        {weekday(m.date)} · {SLOT_LABEL[m.entryType] ?? m.entryType} · {m.servings} servings
                      </span>
                      <span className="block font-medium">
                        {m.recipeName} {m.proposalId ? <Badge variant="warning">New recipe</Badge> : null}
                      </span>
                      <span className="block text-sm text-muted-foreground">{m.reason}</span>
                      {m.usesExpiring.length ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {m.usesExpiring.map((x) => (
                            <Badge key={x} variant="warning">
                              uses {x}
                            </Badge>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </label>
                  {m.newRecipe && m.proposalId ? (
                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer text-primary">Review recipe</summary>
                      <p className="mt-1 text-muted-foreground">{m.newRecipe.description}</p>
                      <ul className="mt-1 list-disc pl-5">
                        {m.newRecipe.ingredients.map((g, n) => (
                          <li key={n}>
                            {[g.quantity, g.unit, g.food, g.note].filter((x) => x !== null && x !== "").join(" ")}
                            {m.newRecipe!.unknownFoods.includes(g.food) ? <span className="text-warning"> (not in Mealie)</span> : null}
                          </li>
                        ))}
                      </ul>
                      <ol className="mt-1 list-decimal pl-5">
                        {m.newRecipe.steps.map((s, n) => (
                          <li key={n}>{s}</li>
                        ))}
                      </ol>
                      {needsApproval ? (
                        <div className="mt-2 flex gap-2">
                          <Button size="sm" onClick={() => decide(m.proposalId!, "approve", i)}>
                            Add to Mealie
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => decide(m.proposalId!, "reject", i)}>
                            Reject
                          </Button>
                        </div>
                      ) : (
                        <Badge variant="success" className="mt-2">
                          Added to Mealie
                        </Badge>
                      )}
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {result.unfilled.length ? <p className="text-xs text-muted-foreground">{result.unfilled.length} slot(s) could not be filled from your recipes.</p> : null}
        </div>
      )}
    </Sheet>
  );
}
