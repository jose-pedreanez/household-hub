import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PLAN_ENTRY_TYPES } from "./mealie/schemas";

/** Household and retailer preferences from version-controlled YAML (falls back to the examples). */

const packageSizeSchema = z.object({ amount: z.number().positive(), unit: z.string().min(1) });

export const householdConfigSchema = z.object({
  household: z.object({ name: z.string().default("Household"), defaultServings: z.number().positive().default(2) }).default({ name: "Household", defaultServings: 2 }),
  meals: z
    .object({
      slots: z.array(z.enum(PLAN_ENTRY_TYPES)).default(["breakfast", "lunch", "dinner", "snack"]),
      plannerSlots: z.array(z.enum(PLAN_ENTRY_TYPES)).default(["dinner"]),
      maxCookingMinutes: z.object({ weeknight: z.number().default(45), weekend: z.number().default(90) }).default({ weeknight: 45, weekend: 90 }),
      equipment: z.array(z.string()).default([]),
      preferences: z
        .object({ likes: z.array(z.string()).default([]), dislikes: z.array(z.string()).default([]), cuisines: z.array(z.string()).default([]) })
        .default({ likes: [], dislikes: [], cuisines: [] }),
      dietaryRestrictions: z.array(z.string()).default([]),
      favoritesTag: z.string().default("favorite"),
      avoidRepeatDays: z.number().int().min(0).default(7),
      showNutrition: z.boolean().default(true),
    })
    .prefault({}),
  cooking: z.object({ autoApproveMealieSubstitutions: z.boolean().default(false) }).prefault({}),
  inventory: z.object({ expiringSoonDays: z.number().int().min(0).default(4), auditProductGroups: z.array(z.string()).default([]) }).prefault({}),
  alerts: z.object({ repeatAfterHours: z.number().min(0).default(24) }).prefault({}),
});
export type HouseholdConfig = z.infer<typeof householdConfigSchema>;

const sourceSchema = z.object({
  retailer: z.string(),
  product: z.string(),
  packageSize: packageSizeSchema.optional(),
  price: z.number().nonnegative().optional(),
  maxPrice: z.number().nonnegative().optional(),
  upc: z.string().optional(),
});

export const retailerConfigSchema = z.object({
  retailers: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]+$/),
        name: z.string(),
        adapter: z.enum(["manual", "instacart"]).default("manual"),
        grocyStore: z.string().optional(),
        sectionOrder: z.array(z.string()).default([]),
        searchUrlTemplate: z.string().url().or(z.string().startsWith("https://")).optional(),
      }),
    )
    .min(1),
  defaults: z
    .object({ preferredRetailer: z.string().optional(), substitutionsRequireApproval: z.boolean().default(true) })
    .prefault({}),
  products: z
    .array(
      z.object({
        food: z.string(),
        preferred: sourceSchema.optional(),
        backups: z.array(sourceSchema).default([]),
        substitutions: z.array(z.object({ food: z.string(), requiresApproval: z.boolean().default(true) })).default([]),
      }),
    )
    .default([]),
});
export type RetailerConfig = z.infer<typeof retailerConfigSchema>;
export type RetailerSource = z.infer<typeof sourceSchema>;

function configDir(): string {
  return process.env.HUB_CONFIG_DIR ?? path.resolve(process.cwd(), "../../config");
}

function load<S extends z.ZodType>(name: string, schema: S): { config: z.infer<S>; file: string; isExample: boolean } {
  const dir = configDir();
  for (const [file, isExample] of [
    [path.join(dir, `${name}.yaml`), false],
    [path.join(dir, `${name}.example.yaml`), true],
  ] as const) {
    // Runtime-mounted config directory: not part of the build output.
    if (fs.existsSync(/*turbopackIgnore: true*/ file)) {
      const parsed = schema.safeParse(YAML.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")) ?? {});
      if (!parsed.success) {
        throw new Error(`${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      return { config: parsed.data, file, isExample };
    }
  }
  return { config: schema.parse({}), file: "(defaults)", isExample: true };
}

let cache: { household?: ReturnType<typeof load<typeof householdConfigSchema>>; retailers?: ReturnType<typeof load<typeof retailerConfigSchema>>; at: number } = { at: 0 };

function fresh() {
  // Re-read at most every 30 s so edits apply without a restart.
  if (Date.now() - cache.at > 30_000) cache = { at: Date.now() };
}

export function householdConfig() {
  fresh();
  cache.household ??= load("household", householdConfigSchema);
  return cache.household;
}

export function retailerConfig() {
  fresh();
  cache.retailers ??= load("retailers", retailerConfigSchema);
  return cache.retailers;
}
