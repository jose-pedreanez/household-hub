"use client";

import { Copy, ExternalLink, Mail, Plus, Printer, RefreshCw, Share2, ShoppingCart, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, Empty, ErrorNote, Input, Loading, PageHeader } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ShoppingListResult } from "@/lib/retailers/types";
import type { StoreListView } from "@/lib/shopping/service";
import { api, useApi } from "@/lib/client";
import { addDaysIso, cn, localToday } from "@/lib/utils";

interface ShoppingResponse {
  stores: StoreListView[];
  needsList: StoreListView | null;
}

export default function ShoppingPage() {
  const { data, error, loading, reload, setData } = useApi<ShoppingResponse>("/api/shopping");
  const [tab, setTab] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState<ShoppingListResult | null>(null);
  const active = tab ?? data?.stores.find((s) => s.items.some((i) => !i.checked))?.retailerId ?? data?.stores[0]?.retailerId ?? null;

  async function generate() {
    setBusy(true);
    try {
      const start = localToday();
      const r = await api<{ items: unknown[]; created: number; updated: number; removed: number; unresolved: Array<{ foodName: string | null; display: string }> }>("/api/shopping/generate", { body: { start, end: addDaysIso(start, 6) } });
      toast.success(`Lists updated: ${r.created} added, ${r.updated} changed, ${r.removed} removed`);
      if (r.unresolved.length) toast.warning(`Not checked against inventory: ${r.unresolved.map((u) => u.foodName ?? u.display).join(", ")}`);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(store: StoreListView, id: string, checked: boolean) {
    // Optimistic: checking an item off only marks it picked up; it never changes inventory.
    setData((d) => (d ? { ...d, stores: d.stores.map((s) => (s.retailerId === store.retailerId ? { ...s, items: s.items.map((i) => (i.id === id ? { ...i, checked } : i)) } : s)) } : d));
    try {
      await api(`/api/shopping/items/${id}`, { method: "PATCH", body: { checked } });
    } catch (e) {
      toast.error((e as Error).message);
      void reload();
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/shopping/items/${id}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!adding.trim() || !active) return;
    try {
      await api("/api/shopping/items", { body: { retailerId: active, text: adding.trim() } });
      setAdding("");
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function exportText(retailerId: string): Promise<string> {
    const res = await fetch(`/api/shopping/${retailerId}/export?format=text`, { credentials: "same-origin" });
    if (!res.ok) throw new Error("Export failed");
    return res.text();
  }

  async function copy(retailerId: string) {
    try {
      await navigator.clipboard.writeText(await exportText(retailerId));
      toast.success("List copied");
    } catch {
      toast.error("Copy is not available here; use Share or Email.");
    }
  }

  async function share(store: StoreListView) {
    const text = await exportText(store.retailerId);
    if (navigator.share) {
      await navigator.share({ title: `${store.name} list`, text }).catch(() => undefined);
    } else {
      await copy(store.retailerId);
    }
  }

  async function email(store: StoreListView) {
    const text = await exportText(store.retailerId);
    window.location.href = `mailto:?subject=${encodeURIComponent(`${store.name} shopping list`)}&body=${encodeURIComponent(text)}`;
  }

  async function startHandoff(store: StoreListView) {
    try {
      const r = await api<ShoppingListResult>(`/api/shopping/${store.retailerId}/handoff`, { body: {} });
      setHandoff(r);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Shopping"
        subtitle="Checking items off marks them as picked up. Scan purchases on the Scan page to add them to inventory."
        actions={
          <Button onClick={generate} disabled={busy}>
            <RefreshCw className={cn(busy && "animate-spin")} /> Update from meal plan
          </Button>
        }
      />
      {error ? <ErrorNote error={error} onRetry={reload} /> : null}
      {loading && !data ? <Loading /> : null}

      {data && active ? (
        <Tabs value={active} onValueChange={setTab}>
          <div className="-mx-4 overflow-x-auto px-4">
            <TabsList>
              {data.stores.map((s) => {
                const open = s.items.filter((i) => !i.checked).length;
                return (
                  <TabsTrigger key={s.retailerId} value={s.retailerId}>
                    {s.name.replace(/ \(.*\)$/, "")} {open ? <Badge className="ml-1">{open}</Badge> : null}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
          {data.stores.map((s) => (
            <TabsContent key={s.retailerId} value={s.retailerId} className="mt-4 grid gap-3">
              <div className="no-print flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => copy(s.retailerId)}>
                  <Copy /> Copy
                </Button>
                <Button size="sm" variant="outline" onClick={() => share(s)}>
                  <Share2 /> Share
                </Button>
                <Button size="sm" variant="outline" onClick={() => email(s)}>
                  <Mail /> Email
                </Button>
                <Button size="sm" variant="outline" onClick={() => window.print()}>
                  <Printer /> Print
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={`/api/shopping/${s.retailerId}/export?format=csv`}>CSV</a>
                </Button>
                <Button size="sm" variant="secondary" onClick={() => startHandoff(s)} disabled={!s.items.some((i) => !i.checked)}>
                  <ExternalLink /> {s.adapter === "instacart" ? "Send to Instacart" : "Prepare order list"}
                </Button>
              </div>
              <form onSubmit={add} className="no-print flex gap-2">
                <Input placeholder={`Add to ${s.name}`} value={adding} onChange={(e) => setAdding(e.target.value)} />
                <Button type="submit" variant="outline" disabled={!adding.trim()}>
                  <Plus /> Add
                </Button>
              </form>
              {s.items.length === 0 ? (
                <Empty icon={<ShoppingCart />} title="Nothing on this list">
                  Use “Update from meal plan” or add items yourself.
                </Empty>
              ) : (
                <Card className="divide-y">
                  <h2 className="hidden p-3 text-lg font-semibold print:block">{s.name}</h2>
                  {s.items.map((i) => (
                    <div key={i.id} className="flex items-center gap-3 p-3">
                      <input type="checkbox" className="size-5" checked={i.checked} onChange={(e) => toggle(s, i.id, e.target.checked)} aria-label={`Picked up ${i.text}`} />
                      <div className={cn("min-w-0 flex-1", i.checked && "text-muted-foreground line-through")}>
                        <p className="truncate">{i.text}</p>
                        {i.need ? <p className="text-xs text-muted-foreground">need {i.need}</p> : null}
                      </div>
                      {i.source === "low_stock" ? <Badge variant="danger">low</Badge> : i.source === "plan" ? <Badge variant="muted">plan</Badge> : null}
                      <button className="no-print rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => remove(i.id)} aria-label={`Remove ${i.text}`}>
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  ))}
                </Card>
              )}
            </TabsContent>
          ))}
        </Tabs>
      ) : null}

      {data?.needsList ? (
        <Card className="no-print">
          <CardContent className="grid gap-2 p-4">
            <p className="font-medium">{data.needsList.name}</p>
            <p className="text-xs text-muted-foreground">
              Maintained automatically by Grocy-Mealie Sync from low stock. It is read-only here: items leave it when you scan the purchase in, which avoids counting the
              same purchase twice.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {data.needsList.items.filter((i) => !i.checked).map((i) => (
                <li key={i.id}>
                  <Badge variant="outline">{i.text}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {handoff ? (
        <Card className="no-print border-primary">
          <CardContent className="grid gap-3 p-4">
            {handoff.kind === "link" ? (
              <>
                <p className="text-sm">Instacart shopping list created. Pick the store and check out there — nothing is ordered until you do.</p>
                <Button asChild>
                  <a href={handoff.url} target="_blank" rel="noreferrer">
                    Open in Instacart <ExternalLink />
                  </a>
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm">This store has no ordering integration. Use the list below; every purchase is made by you.</p>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{handoff.text}</pre>
                {handoff.links.length ? (
                  <ul className="grid gap-1 text-sm">
                    {handoff.links.map((l) => (
                      <li key={l.url}>
                        <a className="text-primary underline" href={l.url} target="_blank" rel="noreferrer">
                          Search “{l.name}”
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
            <Button variant="ghost" onClick={() => setHandoff(null)}>
              Close
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
