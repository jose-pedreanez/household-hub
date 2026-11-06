"use client";

import { Search, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Sheet } from "@/components/ui/dialog";
import { ErrorNote, Input, Loading } from "@/components/ui/primitives";
import { api } from "@/lib/client";

export interface RecipeListItem {
  id: string;
  slug: string;
  name: string;
  servings: number;
  totalTime: string | null;
  rating: number | null;
  lastMade: string | null;
  tags: string[];
}

/** Search Mealie recipes and pick one. */
export function RecipePicker({ open, onOpenChange, onPick, title = "Choose a recipe" }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (r: RecipeListItem) => void; title?: string }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<RecipeListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api<{ recipes: RecipeListItem[] }>(`/api/recipes?search=${encodeURIComponent(q)}`)
        .then((r) => {
          setItems(r.recipes);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description="Recipes come from Mealie.">
      <div className="grid gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus className="pl-9" placeholder="Search recipes" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {error ? <ErrorNote error={error} /> : null}
        {!items && !error ? <Loading /> : null}
        {items?.length === 0 ? <p className="text-sm text-muted-foreground">No recipes found. Add recipes in Mealie first.</p> : null}
        <ul className="grid gap-1">
          {items?.map((r) => (
            <li key={r.id}>
              <button
                className="flex w-full items-center justify-between gap-3 rounded-md p-2 text-left hover:bg-muted"
                onClick={() => {
                  onPick(r);
                  onOpenChange(false);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {[r.totalTime, r.servings ? `${r.servings} servings` : null, r.tags.slice(0, 3).join(", ") || null].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {r.rating ? (
                  <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                    <Star className="size-3 fill-current" />
                    {r.rating}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
