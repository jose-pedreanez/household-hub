import "server-only";
import { env } from "../env";
import { AnthropicProvider } from "./anthropic";
import { OpenAiProvider } from "./openai";
import type { AiProvider } from "./provider";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export interface ProviderStatus {
  provider: AiProvider | null;
  configured: "anthropic" | "openai" | "none";
  problem: string | null;
}

/** The configured cloud AI provider, or null (the hub then uses its deterministic planner). */
export function aiProvider(): ProviderStatus {
  const e = env();
  if (e.AI_PROVIDER === "anthropic") {
    if (!e.ANTHROPIC_API_KEY) return { provider: null, configured: "anthropic", problem: "ANTHROPIC_API_KEY is not set" };
    return { provider: new AnthropicProvider(e.ANTHROPIC_API_KEY, e.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL), configured: "anthropic", problem: null };
  }
  if (e.AI_PROVIDER === "openai") {
    if (!e.OPENAI_API_KEY) return { provider: null, configured: "openai", problem: "OPENAI_API_KEY is not set" };
    if (!e.OPENAI_MODEL) return { provider: null, configured: "openai", problem: "OPENAI_MODEL is not set" };
    return { provider: new OpenAiProvider(e.OPENAI_API_KEY, e.OPENAI_MODEL), configured: "openai", problem: null };
  }
  return { provider: null, configured: "none", problem: null };
}
