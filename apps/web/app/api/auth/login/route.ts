import { NextResponse, connection, type NextRequest } from "next/server";
import { z } from "zod";
import { body, errorResponse } from "@/lib/api";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken, secretsEqual } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

const attempts = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;

function clientKey(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

export async function POST(req: NextRequest) {
  await connection();
  try {
    const key = clientKey(req);
    const now = Date.now();
    const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) throw new AppError("unauthorized", "Too many attempts; wait a minute");
    recent.push(now);
    attempts.set(key, recent);

    const { password } = await body(req, z.object({ password: z.string().min(1).max(200) }));
    const e = env();
    if (!(await secretsEqual(password, e.HUB_PASSWORD))) throw new AppError("unauthorized", "Wrong password");
    attempts.delete(key);

    const res = NextResponse.json({ ok: true });
    const secure = req.headers.get("x-forwarded-proto") === "https" || req.nextUrl.protocol === "https:";
    res.cookies.set(SESSION_COOKIE, await createSessionToken(e.HUB_SESSION_SECRET), {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
