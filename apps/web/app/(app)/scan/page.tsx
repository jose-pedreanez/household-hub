"use client";

import { CheckCircle2, CircleAlert, Clock, Keyboard, Loader2, PackagePlus, Plus, RotateCcw, ScanBarcode, Search, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CameraScanner } from "@/components/scanner/camera-scanner";
import { RegisterSheet, type Reference } from "@/components/scanner/register-sheet";
import { useKeyboardWedge } from "@/components/scanner/use-keyboard-wedge";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, Field, Input, PageHeader, Select } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { KnownBarcode, ResolveResult, UnknownBarcode } from "@/lib/barcode/resolve";
import type { ScanResult } from "@/lib/barcode/receive";
import { ApiError, api, newKey, useApi } from "@/lib/client";
import { cn, fmtAmount, fmtDate } from "@/lib/utils";

type Mode = "receive" | "consume";
type Source = "camera" | "keyboard" | "manual";
type Status = "resolving" | "confirm" | "booking" | "done" | "uncertain" | "unknown" | "error" | "undone";

interface Item {
  key: string;
  barcode: string;
  source: Source;
  mode: Mode;
  status: Status;
  at: number;
  productId?: number;
  productName?: string;
  amountText?: string;
  txId?: number;
  error?: string;
  known?: KnownBarcode;
  unknown?: UnknownBarcode;
  /** Edits made on the confirm card. */
  packages?: number;
  dueDate?: string;
  locationId?: number | null;
  price?: string;
}

const STORAGE_KEY = "hub.scan.session";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function ScanPage() {
  const ref = useApi<Reference & { retailers: Array<{ id: string; name: string; grocyStore: string | null }> }>("/api/reference");
  const [mode, setMode] = useState<Mode>("receive");
  const [method, setMethod] = useState<"camera" | "scanner" | "manual">("camera");
  const [quick, setQuick] = useState(true);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [registering, setRegistering] = useState<Item | null>(null);
  const [manual, setManual] = useState("");
  const batchId = useMemo(() => (typeof window === "undefined" ? "" : sessionStorage.getItem(`${STORAGE_KEY}.batch`) ?? newKey("batch")), []);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const itemsRef = useRef<Item[]>([]);

  // Restore this session's scans after navigating away and back.
  useEffect(() => {
    try {
      sessionStorage.setItem(`${STORAGE_KEY}.batch`, batchId);
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as Item[];
      // Restoring from sessionStorage can only happen after hydration (the server has no storage).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setItems(saved.map((i) => (i.status === "resolving" || i.status === "booking" ? { ...i, status: "error", error: "Interrupted — tap Retry" } : i)));
    } catch {
      /* storage unavailable */
    }
  }, [batchId]);

  useEffect(() => {
    itemsRef.current = items;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 60)));
    } catch {
      /* storage unavailable */
    }
  }, [items]);

  const update = useCallback((key: string, patch: Partial<Item>) => {
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }, []);

  const enqueue = useCallback((job: () => Promise<void>) => {
    queue.current = queue.current.then(job).catch(() => undefined);
  }, []);

  /** Book one intended scan. Retries reuse the same idempotency key, so nothing is booked twice. */
  const book = useCallback(
    async (item: Item) => {
      if (!item.known) return;
      const k = item.known;
      update(item.key, { status: "booking", error: undefined });
      const url = item.mode === "receive" ? "/api/scan/receive" : "/api/scan/consume";
      const packages = item.packages ?? 1;
      const body =
        item.mode === "receive"
          ? {
              idempotencyKey: item.key,
              productId: k.product.id,
              barcode: k.barcode,
              packages,
              source: item.source,
              batchId,
              ...(item.locationId ? { locationId: item.locationId } : {}),
              ...(storeId ? { shoppingLocationId: storeId } : {}),
              ...(item.dueDate && item.dueDate !== k.defaults.dueDate ? { bestBeforeDate: item.dueDate } : {}),
              ...(item.price && Number(item.price) >= 0 ? { pricePerPackage: Number(item.price) } : {}),
            }
          : { idempotencyKey: item.key, productId: k.product.id, barcode: k.barcode, packages, source: item.source, batchId };

      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const r = await api<ScanResult>(url, { body });
          const tx = r.transaction;
          const sign = item.mode === "receive" ? "+" : "−";
          const amountText = `${sign}${fmtAmount(tx.stockAmount)} ${k.product.stockUnit}`;
          if (tx.status === "completed") {
            update(item.key, { status: "done", txId: tx.id, amountText });
            toast.success(`${k.product.name} ${amountText}`);
            return;
          }
          if (tx.status === "uncertain") {
            // Grocy may or may not have applied it; the server reconciles on retry after a settling window.
            update(item.key, { status: "uncertain", txId: tx.id, amountText, error: "Waiting for Grocy to confirm…" });
            await sleep(32_000);
            continue;
          }
          update(item.key, { status: "error", txId: tx.id, error: tx.error ?? "Grocy rejected the booking" });
          return;
        } catch (e) {
          if (e instanceof ApiError && e.code === "in_progress") {
            await sleep(5_000);
            continue;
          }
          if (e instanceof TypeError || (e instanceof ApiError && e.status >= 500 && e.code !== "upstream_error")) {
            await sleep(1500 * 2 ** attempt);
            continue;
          }
          update(item.key, { status: "error", error: (e as Error).message });
          return;
        }
      }
      update(item.key, { status: "error", error: "Still unconfirmed — tap Retry later" });
    },
    [batchId, storeId, update],
  );

  /** Shared pipeline for camera, keyboard-wedge scanner and manual entry. */
  const handleCode = useCallback(
    (barcode: string, source: Source, opts: { forceConfirm?: boolean } = {}) => {
      const item: Item = { key: newKey("scan"), barcode, source, mode, status: "resolving", at: Date.now() };
      setItems((list) => [item, ...list]);
      enqueue(async () => {
        try {
          const r = await api<ResolveResult>(`/api/scan/resolve?barcode=${encodeURIComponent(barcode)}`);
          if (r.status === "unknown") {
            const name = r.off.status === "found" ? r.off.metadata.name ?? undefined : undefined;
            update(item.key, { status: "unknown", unknown: r, productName: name, error: mode === "consume" ? "Unknown product — nothing to consume" : undefined });
            if (mode === "receive" && !registering) setRegistering({ ...item, status: "unknown", unknown: r });
            return;
          }
          if (r.packageError) {
            update(item.key, { status: "error", known: r, productId: r.product.id, productName: r.product.name, error: r.packageError });
            return;
          }
          const resolved: Item = { ...item, known: r, productId: r.product.id, productName: r.product.name, dueDate: r.defaults.dueDate, locationId: r.defaults.locationId, packages: 1 };
          if (quick && !opts.forceConfirm) {
            update(item.key, { known: r, productId: r.product.id, productName: r.product.name });
            await book(resolved);
          } else {
            update(item.key, { ...resolved, status: "confirm" });
          }
        } catch (e) {
          update(item.key, { status: "error", error: (e as Error).message });
        }
      });
    },
    [book, enqueue, mode, quick, registering, update],
  );

  useKeyboardWedge(useCallback((code: string) => handleCode(code, "keyboard"), [handleCode]), !registering);

  async function undo(item: Item) {
    if (!item.txId) return;
    try {
      await api(`/api/scan/${item.txId}/undo`, { body: {} });
      update(item.key, { status: "undone" });
      toast(`Undid ${item.productName}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function undoAll() {
    for (const i of itemsRef.current.filter((x) => x.status === "done")) await undo(i);
  }

  function again(item: Item) {
    if (!item.known) return;
    const copy = rebookCopy(item);
    setItems((list) => [copy, ...list]);
    enqueue(() => book(copy));
  }

  const reference = ref.data;
  const doneCount = items.filter((i) => i.status === "done").length;
  const storeHint = reference?.stores.find((s) => s.id === storeId)?.name;

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Scan"
        subtitle={mode === "receive" ? "Each scan adds one package to inventory." : "Each scan uses up one package."}
        actions={
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="receive">
                <PackagePlus className="size-4" /> Put away
              </TabsTrigger>
              <TabsTrigger value="consume">Use up</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      <Card>
        <CardContent className="grid gap-4 p-4">
          <Tabs value={method} onValueChange={(v) => setMethod(v as typeof method)}>
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="camera" className="flex-1">
                <ScanBarcode className="size-4" /> Camera
              </TabsTrigger>
              <TabsTrigger value="scanner" className="flex-1">
                <Keyboard className="size-4" /> Scanner
              </TabsTrigger>
              <TabsTrigger value="manual" className="flex-1">
                <Search className="size-4" /> Type
              </TabsTrigger>
            </TabsList>
            <TabsContent value="camera" className="mt-4">
              <CameraScanner onDetect={(c) => handleCode(c, "camera")} paused={!!registering || method !== "camera"} />
            </TabsContent>
            <TabsContent value="scanner" className="mt-4">
              <div className="flex items-center gap-3 rounded-lg border border-dashed p-6">
                <span className="relative flex size-3">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                  <span className="relative inline-flex size-3 rounded-full bg-success" />
                </span>
                <div className="text-sm">
                  <p className="font-medium">Ready for a USB or Bluetooth scanner</p>
                  <p className="text-muted-foreground">Scan anywhere on this page. The scanner must send Enter after the code (most do by default).</p>
                </div>
              </div>
            </TabsContent>
            <TabsContent value="manual" className="mt-4">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (manual.trim()) handleCode(manual.trim(), "manual", { forceConfirm: true });
                  setManual("");
                }}
              >
                <Input inputMode="numeric" autoComplete="off" placeholder="Barcode number" value={manual} onChange={(e) => setManual(e.target.value)} />
                <Button type="submit" disabled={!manual.trim()}>
                  Look up
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          {mode === "receive" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Bought at" hint={storeHint ? `Price history is recorded for ${storeHint}.` : undefined}>
                <Select value={storeId ?? ""} onChange={(e) => setStoreId(Number(e.target.value) || null)}>
                  <option value="">Not recorded</option>
                  {reference?.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-3 self-end rounded-md border p-2.5 text-sm">
                <input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} className="size-4" />
                <span>
                  <span className="font-medium">Quick mode</span>
                  <span className="block text-xs text-muted-foreground">Book known products immediately with their defaults. Turn off to set dates and prices per item.</span>
                </span>
              </label>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">This session {doneCount ? `· ${doneCount} booked` : ""}</h2>
        {doneCount > 1 ? (
          <Button variant="ghost" size="sm" onClick={undoAll}>
            <Undo2 /> Undo all
          </Button>
        ) : null}
      </div>

      <ul className="grid gap-2" data-testid="scan-session">
        {items.length === 0 ? <li className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Scanned items appear here.</li> : null}
        {items.map((item) => (
          <li key={item.key}>
            <Card className={cn("p-3", item.status === "undone" && "opacity-60")}>
              <div className="flex items-center gap-3">
                <StatusIcon status={item.status} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{item.productName ?? item.barcode}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.mode === "consume" ? "Use up" : "Put away"} · {item.barcode}
                    {item.amountText ? ` · ${item.amountText}` : ""}
                    {item.status === "undone" ? " · undone" : ""}
                  </p>
                  {item.error ? <p className={cn("text-xs", item.status === "uncertain" ? "text-warning" : "text-danger")}>{item.error}</p> : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  {item.status === "done" ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => again(item)} aria-label="Book another package">
                        <Plus /> 1
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => undo(item)}>
                        <Undo2 /> Undo
                      </Button>
                    </>
                  ) : null}
                  {(item.status === "error" || item.status === "uncertain") && item.known ? (
                    <Button variant="outline" size="sm" onClick={() => enqueue(() => book(item))}>
                      <RotateCcw /> Retry
                    </Button>
                  ) : null}
                  {item.status === "unknown" && item.mode === "receive" ? (
                    <Button size="sm" onClick={() => setRegistering(item)}>
                      Register
                    </Button>
                  ) : null}
                </div>
              </div>
              {item.status === "confirm" && item.known ? (
                <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-4">
                  <Field label="Packages">
                    <Input inputMode="decimal" value={item.packages ?? 1} onChange={(e) => update(item.key, { packages: Number(e.target.value) || 1 })} />
                  </Field>
                  {item.mode === "receive" ? (
                    <>
                      <Field label="Best before" hint={item.known.defaults.dueDateAssumed === "none" ? "No default set" : undefined}>
                        <Input type="date" value={item.dueDate?.startsWith("2999") ? "" : item.dueDate ?? ""} onChange={(e) => update(item.key, { dueDate: e.target.value || "2999-12-31" })} />
                      </Field>
                      <Field label="Stored in">
                        <Select value={item.locationId ?? ""} onChange={(e) => update(item.key, { locationId: Number(e.target.value) || null })}>
                          {reference?.locations.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Price / package">
                        <Input inputMode="decimal" placeholder="optional" value={item.price ?? ""} onChange={(e) => update(item.key, { price: e.target.value })} />
                      </Field>
                    </>
                  ) : null}
                  <div className="flex items-end gap-2 sm:col-span-4">
                    <p className="flex-1 text-xs text-muted-foreground">
                      1 package = {fmtAmount(item.known.package?.stockPerPackage)} {item.known.product.stockUnit} · in stock {fmtAmount(item.known.stock.amount)} {item.known.stock.unit}
                      {item.known.family.mealieFoodName ? ` · counts as ${item.known.family.mealieFoodName}` : ""}
                      {item.known.defaults.dueDate && !item.known.defaults.dueDate.startsWith("2999") ? ` · default date ${fmtDate(item.known.defaults.dueDate)}` : ""}
                    </p>
                    <Button variant="ghost" onClick={() => update(item.key, { status: "undone", error: "Skipped" })}>
                      Skip
                    </Button>
                    <Button onClick={() => enqueue(() => book(itemsRef.current.find((i) => i.key === item.key) ?? item))}>{item.mode === "receive" ? "Put away" : "Use up"}</Button>
                  </div>
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>

      {registering?.unknown && reference ? (
        <RegisterSheet
          open
          onOpenChange={(o) => !o && setRegistering(null)}
          data={registering.unknown}
          reference={reference}
          defaultLocationId={null}
          defaultStoreId={storeId}
          onRegistered={(r) => {
            const pending = registering;
            setRegistering(null);
            toast.success(`Registered ${r.productName}`);
            update(pending.key, { productName: r.productName, status: "resolving", error: undefined });
            // Book the scan that triggered registration with its original key.
            enqueue(async () => {
              const resolved = await api<ResolveResult>(`/api/scan/resolve?barcode=${encodeURIComponent(pending.barcode)}`);
              if (resolved.status !== "known") return update(pending.key, { status: "error", error: "Registration did not take effect" });
              const ready: Item = { ...pending, known: resolved, productId: resolved.product.id, productName: resolved.product.name, dueDate: resolved.defaults.dueDate, locationId: resolved.defaults.locationId, packages: 1 };
              if (quick) await book(ready);
              else update(pending.key, { ...ready, status: "confirm" });
            });
          }}
        />
      ) : null}
    </div>
  );
}

/** Another package of an already-booked product: a new intended scan with its own idempotency key. */
function rebookCopy(item: Item): Item {
  return { ...item, key: newKey("scan"), status: "booking", at: Date.now(), txId: undefined, error: undefined, amountText: undefined };
}

function StatusIcon({ status }: { status: Status }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="size-5 shrink-0 text-success" />;
    case "error":
      return <CircleAlert className="size-5 shrink-0 text-danger" />;
    case "uncertain":
      return <Clock className="size-5 shrink-0 text-warning" />;
    case "unknown":
      return <Badge variant="warning">New</Badge>;
    case "confirm":
      return <Badge variant="default">Check</Badge>;
    case "undone":
      return <Undo2 className="size-5 shrink-0 text-muted-foreground" />;
    default:
      return <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />;
  }
}
