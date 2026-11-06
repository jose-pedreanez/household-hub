import { UpstreamError } from "./errors";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body (form data etc.). Mutually exclusive with `body`. */
  rawBody?: BodyInit;
  timeoutMs?: number;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * JSON-over-HTTP with timeouts and classified failures.
 *
 * A write (non-GET) that times out or loses its connection is reported with `outcomeUncertain`,
 * because the upstream may have applied it. Callers that write stock must reconcile in that case.
 */
export async function requestJson<T = unknown>(
  service: string,
  url: string,
  opts: RequestOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<T | null> {
  const method = opts.method ?? "GET";
  const isWrite = method !== "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: BodyInit | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetchImpl(url, { method, headers, body, signal: controller.signal, cache: "no-store" });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new UpstreamError({
      service,
      message: `${service} ${aborted ? "timed out" : "unreachable"} (${method} ${redactUrl(url)})`,
      httpStatus: null,
      outcomeUncertain: isWrite,
      unreachable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404 && opts.allow404) return null;

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    throw new UpstreamError({
      service,
      message: `${service} returned HTTP ${res.status} for ${method} ${redactUrl(url)}: ${summarize(parsed)}`,
      httpStatus: res.status,
      // A 5xx on a write might still have been partly applied; 4xx means it was rejected.
      outcomeUncertain: isWrite && res.status >= 500,
      unreachable: res.status === 502 || res.status === 503 || res.status === 504,
      details: parsed,
    });
  }
  return parsed as T;
}

function summarize(body: unknown): string {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const msg = o.error_message ?? o.detail ?? o.message ?? o.error;
    if (typeof msg === "string") return msg.slice(0, 300);
    if (msg !== undefined) return JSON.stringify(msg).slice(0, 300);
  }
  return String(body ?? "").slice(0, 300);
}

/** Never let credentials embedded in query strings reach logs or error messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/key|token|secret|password/i.test(key)) u.searchParams.set(key, "REDACTED");
    }
    return u.pathname + (u.search ? u.search : "");
  } catch {
    return url;
  }
}
