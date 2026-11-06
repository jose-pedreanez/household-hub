import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/**
 * Optimistic page guard: send signed-out visitors to /login. Every API route still authenticates
 * on its own (see lib/api.ts), so this is a convenience, not the security boundary.
 */
export async function proxy(req: NextRequest) {
  const secret = process.env.HUB_SESSION_SECRET;
  if (secret && (await verifySessionToken(secret, req.cookies.get(SESSION_COOKIE)?.value))) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api/|_next/|login|manifest.webmanifest|sw.js|icons/|zxing/|favicon.ico|robots.txt).*)"],
};
