"use client";

import { Boxes, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { DueBadge } from "@/components/due-badge";
import { Badge, Card, Empty, ErrorNote, Input, Loading, PageHeader } from "@/components/ui/primitives";
import type { InventoryItem } from "@/lib/inventory/overview";
import { useApi } from "@/lib/client";
import { cn, fmtAmount, localToday } from "@/lib/utils";

interface InventoryResponse {
  items: InventoryItem[];
  locations: Array<{ id: number; name: string }>;
}

function InventoryView() {
  const params = useSearchParams();
  const router = useRouter();
  const status = (params.get("status") ?? "all") as "all" | "expiring" | "low";
  const location = params.get("location");
  const [q, setQ] = useState("");
  const url = `/api/inventory?status=${status}${location ? `&location=${location}` : ""}`;
  const { data, error, loading, reload } = useApi<InventoryResponse>(url);
  const today = localToday();

  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => !t || i.name.toLowerCase().includes(t) || i.parentName?.toLowerCase().includes(t) || i.mealieFoodName?.toLowerCase().includes(t));
  }, [data, q]);

  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (value) p.set(key, value);
    else p.delete(key);
    router.replace(`/inventory${p.size ? `?${p}` : ""}`);
  };

  const chip = (active: boolean) =>
    cn("rounded-full border px-3 py-1 text-sm whitespace-nowrap", active ? "border-primary bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-muted");

  return (
    <div className="grid gap-4">
      <PageHeader title="Inventory" subtitle={data ? `${data.items.length} products in stock` : undefined} />
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search products or ingredients" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        <button className={chip(status === "all" && !location)} onClick={() => router.replace("/inventory")}>
          Everything
        </button>
        <button className={chip(status === "expiring")} onClick={() => setParam("status", status === "expiring" ? null : "expiring")}>
          Use soon
        </button>
        <button className={chip(status === "low")} onClick={() => setParam("status", status === "low" ? null : "low")}>
          Low stock
        </button>
        {data?.locations.map((l) => (
          <button key={l.id} className={chip(location === String(l.id))} onClick={() => setParam("location", location === String(l.id) ? null : String(l.id))}>
            {l.name}
          </button>
        ))}
      </div>

      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNote error={error} onRetry={reload} /> : null}
      {data && items.length === 0 ? (
        <Empty icon={<Boxes />} title={q ? "No matching products" : "Nothing here"}>
          {q ? "Try another name." : <Link href="/scan" className="text-primary underline">Scan groceries to add them.</Link>}
        </Empty>
      ) : null}

      <Card className="divide-y">
        {items.map((i) => (
          <Link key={i.productId} href={`/inventory/${i.productId}`} className="flex items-center gap-3 p-3 hover:bg-muted/60">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{i.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {[i.mealieFoodName && i.mealieFoodName !== i.name ? `counts as ${i.mealieFoodName}` : null, i.locations.map((l) => l.name).join(", ") || null].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-sm font-medium tabular-nums">
                {fmtAmount(i.amount)} {i.unit}
              </span>
              <div className="flex gap-1">
                {i.belowMin ? <Badge variant="danger">Low</Badge> : null}
                {i.opened > 0 ? <Badge variant="muted">opened</Badge> : null}
                <DueBadge status={i.dueStatus} due={i.nextDue} today={today} />
              </div>
            </div>
          </Link>
        ))}
      </Card>
    </div>
  );
}

export default function InventoryPage() {
  return (
    <Suspense fallback={<Loading />}>
      <InventoryView />
    </Suspense>
  );
}
