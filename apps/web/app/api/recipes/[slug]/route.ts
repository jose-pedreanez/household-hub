import { route } from "@/lib/api";
import { mappingContext, recipe as loadRecipe } from "@/lib/context";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { mappedProductForFood } from "@/lib/sync/mappings";

export const GET = route<{ slug: string }>(async (_req, { params }) => {
  const { slug } = await params;
  const r = await loadRecipe(slug);
  if (!r) throw new AppError("not_found", "Recipe not found");
  const ctx = await mappingContext();
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    servings: r.recipeServings,
    totalTime: r.totalTime,
    // Mealie's own nutrition fields, shown as entered (per serving, free text); never computed or invented here.
    nutrition: r.nutrition ?? null,
    mealieUrl: `${env().MEALIE_PUBLIC_URL.replace(/\/$/, "")}/g/home/r/${r.slug}`,
    ingredients: r.recipeIngredient.map((i) => ({
      display: i.display || i.originalText || i.note || "",
      foodId: i.food?.id ?? null,
      foodName: i.food?.name ?? null,
      mapped: i.food ? !!mappedProductForFood(ctx, i.food.id) : null,
    })),
    steps: (r.recipeInstructions ?? []).map((s) => s.text),
  };
});
