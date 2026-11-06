import "server-only";
import { unstable_rethrow } from "next/navigation";
import { NextResponse, connection, type NextRequest } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, secretsEqual, verifySessionToken } from "./auth/session";
import { getDb, nowIso } from "./db";
import { env } from "./env";
import { AppError, UpstreamError, errorMessage } from "./errors";

export type Actor = "household" | "automation";

export interface RouteContext<P> {
  params: Promise<P>;
  actor: Actor;
}

/**
 * Authenticate a request: a valid household session cookie, or `Authorization: Bearer <HUB_API_TOKEN>`
 * for automation (n8n). Cookie-authenticated writes must also come from our own origin.
 */
export async function authenticate(req: NextRequest): Promise<Actor> {
  const e = env();
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    if (await secretsEqual(auth.slice(7).trim(), e.HUB_API_TOKEN)) return "automation";
    throw new AppError("unauthorized", "Invalid API token");
  }
  if (!(await verifySessionToken(e.HUB_SESSION_SECRET, req.cookies.get(SESSION_COOKIE)?.value))) {
    throw new AppError("unauthorized", "Please sign in");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) {
      throw new AppError("unauthorized", "Cross-origin request rejected");
    }
  }
  return "household";
}

export function errorResponse(e: unknown): NextResponse {
  // Next.js signals redirects and prerender bail-outs by throwing; never turn those into responses.
  unstable_rethrow(e);
  if (e instanceof AppError) {
    const body: Record<string, unknown> = { error: e.code, message: e.message };
    if (e.details !== undefined) body.details = e.details;
    if (e instanceof UpstreamError) {
      body.service = e.service;
      body.outcomeUncertain = e.outcomeUncertain;
    }
    return NextResponse.json(body, { status: e.status });
  }
  if (e instanceof z.ZodError) {
    return NextResponse.json(
      { error: "bad_request", message: "Invalid request", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 400 },
    );
  }
  console.error("[hub] unexpected error", e);
  return NextResponse.json({ error: "internal", message: "Unexpected server error" }, { status: 500 });
}

type Handler<P> = (req: NextRequest, ctx: RouteContext<P>) => Promise<unknown>;

/** Wrap a route handler with authentication, JSON serialisation and consistent error responses. */
export function route<P = Record<string, never>>(handler: Handler<P>, opts: { public?: boolean } = {}) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) => {
    // Every API route reads live data for the caller: always render at request time.
    await connection();
    try {
      const actor: Actor = opts.public ? "household" : await authenticate(req);
      const result = await handler(req, { params: ctx.params, actor });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<S extends z.ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("bad_request", "Request body must be JSON");
  }
  return schema.parse(raw);
}

export function query<S extends z.ZodType>(req: NextRequest, schema: S): z.infer<S> {
  return schema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
}

export function audit(actor: Actor, action: string, details: unknown): void {
  try {
    getDb()
      .prepare("INSERT INTO audit_log(at, actor, action, details_json) VALUES (?, ?, ?, ?)")
      .run(nowIso(), actor, action, JSON.stringify(details ?? null));
  } catch (e) {
    console.error("[hub] audit log write failed", errorMessage(e));
  }
}

/** Today in the household's timezone (YYYY-MM-DD). */
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env().TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
