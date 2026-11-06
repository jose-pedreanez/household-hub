import { z } from "zod";
import { query, route } from "@/lib/api";
import { services } from "@/lib/services";

export const GET = route(async (req) => {
  const { search, page, orderBy } = query(
    req,
    z.object({ search: z.string().max(80).optional(), page: z.coerce.number().int().min(1).default(1), orderBy: z.enum(["name", "lastMade", "rating"]).default("name") }),
  );
  const res = await services().mealie.searchRecipes({ search, page, perPage: 30, orderBy });
  return {
    page: res.page ?? page,
    totalPages: res.total_pages ?? 1,
    recipes: res.items.map((r) => ({ id: r.id, slug: r.slug, name: r.name, servings: r.recipeServings, totalTime: r.totalTime, rating: r.rating, lastMade: r.lastMade, tags: r.tags.map((t) => t.name) })),
  };
});
