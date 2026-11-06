import type { z } from "zod";

/** Provider-neutral surface used by the planner and the assistant. */

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  /** Returns a JSON-serialisable result; thrown errors are reported to the model as tool errors. */
  run: (input: z.infer<S>) => Promise<unknown>;
}

/** Keep each tool's input type while defining it; erase it for the heterogeneous tool list. */
export function defineTool<S extends z.ZodObject>(tool: ToolDef<S>): ToolDef {
  return tool as unknown as ToolDef;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface StructuredResult<T> {
  data: T | null;
  raw: string;
  /** Set when the model declined (policy refusal) instead of answering. */
  refusal: string | null;
}

export interface ToolRunResult {
  text: string;
  refusal: string | null;
  toolCalls: Array<{ name: string; input: unknown; ok: boolean }>;
}

export interface AiProvider {
  readonly name: "anthropic" | "openai";
  readonly model: string;
  structured<S extends z.ZodType>(opts: { system: string; prompt: string; schema: S; schemaName: string }): Promise<StructuredResult<z.infer<S>>>;
  runTools(opts: { system: string; messages: ChatTurn[]; tools: ToolDef[]; maxIterations: number }): Promise<ToolRunResult>;
}

export function toolResultText(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  // Keep tool results bounded; the tools already summarise.
  return s.length > 20_000 ? `${s.slice(0, 20_000)}…(truncated)` : s;
}
