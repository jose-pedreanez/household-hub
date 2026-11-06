import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { UpstreamError } from "../errors";
import { toolResultText, type AiProvider, type ChatTurn, type StructuredResult, type ToolDef, type ToolRunResult } from "./provider";

/**
 * Claude provider. Uses server-side refusal fallbacks (`fallbacks: "default"`), so a policy decline
 * on the requested model is retried on Anthropic's recommended fallback model inside the same call.
 */

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async structured<S extends z.ZodType>(opts: { system: string; prompt: string; schema: S; schemaName: string }): Promise<StructuredResult<z.infer<S>>> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
        output_config: { effort: "medium", format: betaZodOutputFormat(opts.schema) },
      });
      const raw = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (response.stop_reason === "refusal") {
        return { data: null, raw, refusal: response.stop_details?.explanation ?? response.stop_details?.category ?? "declined" };
      }
      if (response.stop_reason === "max_tokens") return { data: null, raw, refusal: null };
      return { data: (response.parsed_output ?? null) as z.infer<S> | null, raw, refusal: null };
    } catch (e) {
      throw mapError(e);
    }
  }

  async runTools(opts: { system: string; messages: ChatTurn[]; tools: ToolDef[]; maxIterations: number }): Promise<ToolRunResult> {
    const toolCalls: ToolRunResult["toolCalls"] = [];
    const tools = opts.tools.map((t) =>
      betaZodTool({
        name: t.name,
        description: t.description,
        inputSchema: t.schema,
        run: async (input) => {
          try {
            const out = await t.run(input);
            toolCalls.push({ name: t.name, input, ok: true });
            return toolResultText(out);
          } catch (e) {
            toolCalls.push({ name: t.name, input, ok: false });
            return toolResultText({ error: e instanceof Error ? e.message : String(e) });
          }
        },
      }),
    );
    try {
      const final = await this.client.beta.messages.toolRunner({
        model: this.model,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: opts.system,
        output_config: { effort: "medium" },
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        tools,
        max_iterations: opts.maxIterations,
      });
      const text = final.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (final.stop_reason === "refusal") {
        return { text, refusal: final.stop_details?.explanation ?? "declined", toolCalls };
      }
      return { text, refusal: null, toolCalls };
    } catch (e) {
      throw mapError(e);
    }
  }
}

function mapError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new UpstreamError({ service: "Anthropic", message: "The Anthropic API key was rejected", httpStatus: e.status ?? null, outcomeUncertain: false, unreachable: false });
  }
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) {
    return new UpstreamError({ service: "Anthropic", message: `Anthropic API unavailable (${e.status})`, httpStatus: e.status ?? null, outcomeUncertain: false, unreachable: true });
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new UpstreamError({ service: "Anthropic", message: "Could not reach the Anthropic API", httpStatus: null, outcomeUncertain: false, unreachable: true });
  }
  if (e instanceof Anthropic.APIError) {
    return new UpstreamError({ service: "Anthropic", message: `Anthropic API error ${e.status}: ${e.message}`, httpStatus: e.status ?? null, outcomeUncertain: false, unreachable: false });
  }
  return e instanceof Error ? e : new Error(String(e));
}
