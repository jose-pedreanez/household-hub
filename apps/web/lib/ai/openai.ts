import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { UpstreamError } from "../errors";
import { toolResultText, type AiProvider, type ChatTurn, type StructuredResult, type ToolDef, type ToolRunResult } from "./provider";

/** OpenAI provider (Responses API). The model must be configured explicitly with OPENAI_MODEL. */
export class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, readonly model: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async structured<S extends z.ZodType>(opts: { system: string; prompt: string; schema: S; schemaName: string }): Promise<StructuredResult<z.infer<S>>> {
    try {
      const response = await this.client.responses.parse({
        model: this.model,
        instructions: opts.system,
        input: opts.prompt,
        text: { format: zodTextFormat(opts.schema, opts.schemaName) },
      });
      const refusal = findRefusal(response.output);
      return { data: refusal ? null : ((response.output_parsed ?? null) as z.infer<S> | null), raw: response.output_text ?? "", refusal };
    } catch (e) {
      throw mapError(e);
    }
  }

  async runTools(opts: { system: string; messages: ChatTurn[]; tools: ToolDef[]; maxIterations: number }): Promise<ToolRunResult> {
    const toolCalls: ToolRunResult["toolCalls"] = [];
    const defs = opts.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
      strict: false,
    }));
    const byName = new Map(opts.tools.map((t) => [t.name, t]));
    let input: OpenAI.Responses.ResponseInput = opts.messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      for (let i = 0; i < opts.maxIterations; i++) {
        const response = await this.client.responses.create({ model: this.model, instructions: opts.system, input, tools: defs });
        const refusal = findRefusal(response.output);
        if (refusal) return { text: response.output_text ?? "", refusal, toolCalls };
        const calls = response.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
        if (calls.length === 0) return { text: (response.output_text ?? "").trim(), refusal: null, toolCalls };

        const outputs: OpenAI.Responses.ResponseInputItem[] = [];
        for (const call of calls) {
          const tool = byName.get(call.name);
          let result: unknown;
          let ok = false;
          let parsedInput: unknown = null;
          try {
            parsedInput = JSON.parse(call.arguments || "{}");
            if (!tool) throw new Error(`Unknown tool ${call.name}`);
            result = await tool.run(tool.schema.parse(parsedInput));
            ok = true;
          } catch (e) {
            result = { error: e instanceof Error ? e.message : String(e) };
          }
          toolCalls.push({ name: call.name, input: parsedInput, ok });
          outputs.push({ type: "function_call_output", call_id: call.call_id, output: toolResultText(result) });
        }
        input = [...input, ...(response.output as OpenAI.Responses.ResponseInputItem[]), ...outputs];
      }
      return { text: "I could not finish that request within the allowed number of steps.", refusal: null, toolCalls };
    } catch (e) {
      throw mapError(e);
    }
  }
}

function findRefusal(output: OpenAI.Responses.ResponseOutputItem[]): string | null {
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const c of item.content) if (c.type === "refusal") return c.refusal;
  }
  return null;
}

function mapError(e: unknown): Error {
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) {
    return new UpstreamError({ service: "OpenAI", message: "The OpenAI API key was rejected", httpStatus: e.status ?? null, outcomeUncertain: false, unreachable: false });
  }
  if (e instanceof OpenAI.RateLimitError || e instanceof OpenAI.InternalServerError) {
    return new UpstreamError({ service: "OpenAI", message: `OpenAI API unavailable (${e.status})`, httpStatus: e.status ?? null, outcomeUncertain: false, unreachable: true });
  }
  if (e instanceof OpenAI.APIConnectionError) {
    return new UpstreamError({ service: "OpenAI", message: "Could not reach the OpenAI API", httpStatus: null, outcomeUncertain: false, unreachable: true });
  }
  if (e instanceof OpenAI.APIError) {
    return new UpstreamError({ service: "OpenAI", message: `OpenAI API error ${e.status}: ${e.message}`, httpStatus: e.status ?? null, outcomeUncertain: false, unreachable: false });
  }
  return e instanceof Error ? e : new Error(String(e));
}
