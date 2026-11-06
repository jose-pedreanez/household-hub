"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/primitives";
import { api } from "@/lib/client";

export interface ProductHit {
  id: number;
  name: string;
  stockUnit: string;
  stockQuId: number;
  generic: boolean;
  mealieFoodName: string | null;
}

/** Inline Grocy product search (for extras, unmapped lines and manual receiving). */
export function ProductSearch({ onPick, placeholder = "Search products", ownStockOnly = true }: { onPick: (p: ProductHit) => void; placeholder?: string; ownStockOnly?: boolean }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const query = q.trim();
  useEffect(() => {
    if (query.length < 2) return;
    const t = setTimeout(() => {
      api<{ products: ProductHit[] }>(`/api/products/search?q=${encodeURIComponent(query)}`)
        .then((r) => setHits(r.products.filter((p) => !ownStockOnly || !p.generic)))
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, ownStockOnly]);
  const visible = query.length < 2 ? [] : hits;
  return (
    <div className="grid gap-1">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} />
      {visible.length ? (
        <ul className="max-h-48 overflow-y-auto rounded-md border">
          {visible.map((p) => (
            <li key={p.id}>
              <button
                className="flex w-full justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => {
                  onPick(p);
                  setQ("");
                  setHits([]);
                }}
              >
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.stockUnit}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
