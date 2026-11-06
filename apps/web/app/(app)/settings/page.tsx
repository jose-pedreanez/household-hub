"use client";

import { CheckCircle2, CircleAlert, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorNote, Loading, PageHeader } from "@/components/ui/primitives";
import { api, useApi } from "@/lib/client";
import { fmtDate } from "@/lib/utils";

interface Health {
  ok: boolean;
  grocy?: { ok: boolean; detail?: string; error?: string; ms: number };
  mealie?: { ok: boolean; detail?: string; error?: string; ms: number };
  gms?: { ok: boolean; detail?: unknown; error?: string; ms: number };
}
interface Settings {
  ai: { configured: string; model: string | null; problem: string | null };
  instacart: { enabled: boolean; environment: string };
  mealieNeedsListConfigured: boolean;
  mealieUrl: string;
  config: { household: { file: string; isExample: boolean }; retailers: { file: string; isExample: boolean } };
}
interface Notifications {
  notifications: Array<{ id: number; title: string; body: string | null; createdAt: string; readAt: string | null }>;
}

function Row({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      {ok ? <CheckCircle2 className="size-4 text-success" /> : <CircleAlert className="size-4 text-danger" />}
      <span className="w-40 font-medium">{label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{detail}</span>
    </li>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const health = useApi<Health>("/api/health?deep=1");
  const settings = useApi<Settings>("/api/settings");
  const notes = useApi<Notifications>("/api/notifications");

  async function logout() {
    await api("/api/auth/logout", { body: {} });
    router.replace("/login");
  }

  async function markRead() {
    await api("/api/notifications", { body: { markAllRead: true } });
    toast("Marked as read");
    void notes.reload();
  }

  const h = health.data;
  const s = settings.data;
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Settings"
        subtitle="Connections and configuration (no secrets are shown)."
        actions={
          <Button variant="outline" onClick={logout}>
            <LogOut /> Sign out
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
        </CardHeader>
        <CardContent>
          {health.loading && !h ? <Loading /> : null}
          {h ? (
            <ul className="divide-y">
              <Row label="Grocy (inventory)" ok={!!h.grocy?.ok} detail={h.grocy?.ok ? `version ${h.grocy.detail}` : h.grocy?.error ?? "unknown"} />
              <Row label="Mealie (recipes)" ok={!!h.mealie?.ok} detail={h.mealie?.ok ? `version ${h.mealie.detail}` : h.mealie?.error ?? "unknown"} />
              <Row label="Grocy-Mealie Sync" ok={!!h.gms?.ok} detail={h.gms?.ok ? "connected" : h.gms?.error ?? "unknown"} />
            </ul>
          ) : health.error ? (
            <ErrorNote error={health.error} onRetry={health.reload} />
          ) : null}
        </CardContent>
      </Card>

      {s ? (
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p>
              Meal-planning AI:{" "}
              {s.ai.configured === "none" ? (
                <Badge variant="muted">Off — built-in planner</Badge>
              ) : s.ai.problem ? (
                <Badge variant="danger">{s.ai.problem}</Badge>
              ) : (
                <Badge>
                  {s.ai.configured} · {s.ai.model}
                </Badge>
              )}
            </p>
            <p>Instacart hand-off: {s.instacart.enabled ? <Badge>enabled ({s.instacart.environment})</Badge> : <Badge variant="muted">not configured</Badge>}</p>
            <p>Low-stock list from Grocy-Mealie Sync: {s.mealieNeedsListConfigured ? <Badge>configured</Badge> : <Badge variant="warning">not configured</Badge>}</p>
            <p>
              Household preferences: <code className="text-xs">{s.config.household.file}</code> {s.config.household.isExample ? <Badge variant="warning">example file</Badge> : null}
            </p>
            <p>
              Retailers: <code className="text-xs">{s.config.retailers.file}</code> {s.config.retailers.isExample ? <Badge variant="warning">example file</Badge> : null}
            </p>
            <p>
              Recipes are edited in{" "}
              <a className="text-primary underline" href={s.mealieUrl} target="_blank" rel="noreferrer">
                Mealie
              </a>
              .
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card id="notifications">
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <Button size="sm" variant="ghost" onClick={markRead}>
            Mark all read
          </Button>
        </CardHeader>
        <CardContent>
          {notes.data?.notifications.length ? (
            <ul className="grid gap-3 text-sm">
              {notes.data.notifications.map((n) => (
                <li key={n.id} className={n.readAt ? "opacity-70" : ""}>
                  <p className="font-medium">
                    {n.title} <span className="text-xs font-normal text-muted-foreground">{fmtDate(n.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  </p>
                  {n.body ? <p className="whitespace-pre-line text-muted-foreground">{n.body}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No notifications yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Phone camera access</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <p>Phones only allow the camera on HTTPS. Install the hub’s certificate once on each phone:</p>
          <ol className="list-decimal pl-5">
            <li>
              On the phone, open <code>http://&lt;hub address&gt;/ca.crt</code> and install the certificate.
            </li>
            <li>iPhone: Settings → General → VPN &amp; Device Management → install; then Settings → General → About → Certificate Trust Settings → enable full trust.</li>
            <li>Android: Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate.</li>
            <li>
              Open <code>https://&lt;hub address&gt;</code> and add it to the home screen.
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
