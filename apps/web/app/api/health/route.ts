import { NextResponse, connection, type NextRequest } from "next/server";
import { authenticate, errorResponse } from "@/lib/api";
import { getDb, schemaVersion } from "@/lib/db";
import { services } from "@/lib/services";

/** Liveness (public) and, with ?deep=1 and authentication, connectivity to every integration. */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const db = getDb();
    const base = { ok: true, service: "household-hub", schemaVersion: schemaVersion(db), time: new Date().toISOString() };
    if (req.nextUrl.searchParams.get("deep") !== "1") return NextResponse.json(base);

    await authenticate(req);
    const { grocy, mealie, gms } = services();
    const check = async (fn: () => Promise<unknown>) => {
      const started = Date.now();
      try {
        const detail = await fn();
        return { ok: true, ms: Date.now() - started, detail };
      } catch (e) {
        return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
      }
    };
    const [g, m, s] = await Promise.all([
      check(async () => (await grocy.systemInfo()).grocy_version.Version),
      check(async () => (await mealie.about()).version),
      check(async () => gms.status()),
    ]);
    const all = g.ok && m.ok && s.ok;
    return NextResponse.json({ ...base, ok: all, grocy: g, mealie: m, gms: s }, { status: all ? 200 : 503 });
  } catch (e) {
    return errorResponse(e);
  }
}
