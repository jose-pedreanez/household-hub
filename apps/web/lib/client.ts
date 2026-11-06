"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Browser-side helpers. All privileged calls go to the hub's own /api routes; no upstream credentials here. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth")) {
    // A full navigation (not router.push) also discards any client state from the expired session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok && res.status !== 202) {
    const d = (data ?? {}) as { message?: string; error?: string; details?: unknown };
    throw new ApiError(d.message ?? `Request failed (${res.status})`, res.status, d.error ?? "error", d.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Idempotency keys for intended actions. crypto.randomUUID is only available in secure contexts, so a
 * getRandomValues-based fallback keeps keys unique when the hub is opened over plain HTTP on the LAN.
 */
export function newKey(prefix = "k"): string {
  if (typeof window !== "undefined" && window.isSecureContext && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Fetch JSON for a page section, with loading/error state and manual reload. */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(!!url);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!url) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(url);
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e as Error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;
    const mine = ++seq.current;
    api<T>(url).then(
      (d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: Error) => {
        if (mine !== seq.current) return;
        setError(e);
        setLoading(false);
      },
    );
  }, [url]);

  return { data, error, loading, reload: load, setData };
}
