import "server-only";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HUB_DATA_DIR: z.string().default("./.data"),
  HUB_CONFIG_DIR: z.string().default("../../config"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  MEALIE_PUBLIC_URL: z.string().default("http://localhost:9925"),
  TZ: z.string().default("America/Los_Angeles"),

  HUB_PASSWORD: z.string().min(8, "HUB_PASSWORD must be at least 8 characters"),
  HUB_SESSION_SECRET: z.string().min(32, "HUB_SESSION_SECRET must be at least 32 characters"),
  HUB_API_TOKEN: z.string().min(24, "HUB_API_TOKEN must be at least 24 characters"),

  GROCY_URL: z.string().url(),
  GROCY_API_KEY: z.string().min(1, "GROCY_API_KEY is missing — run scripts/bootstrap.sh"),
  MEALIE_URL: z.string().url(),
  MEALIE_API_TOKEN: z.string().min(1, "MEALIE_API_TOKEN is missing — run scripts/bootstrap.sh"),
  MEALIE_NEEDS_LIST_ID: optionalString,
  GMS_URL: z.string().url(),
  GMS_AUTH_SECRET: optionalString,

  OFF_USER_AGENT: z.string().default("HouseholdHub/0.1 (self-hosted)"),
  OFF_BASE_URL: z.string().url().default("https://world.openfoodfacts.org"),

  AI_PROVIDER: z.enum(["anthropic", "openai", "none"]).default("none"),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,

  INSTACART_API_KEY: optionalString,
  INSTACART_ENV: z.enum(["development", "production"]).default("development"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Validated server-only configuration. Throws a readable error listing every invalid variable. */
export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration: ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: forget the cached environment so tests can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
