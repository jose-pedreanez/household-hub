"use client";

import { useEffect, useRef } from "react";
import { cleanBarcode } from "@/lib/barcode/normalize";
import { WedgeDebouncer } from "@/lib/barcode/scan-gate";

/**
 * USB/Bluetooth barcode scanners in keyboard ("HID wedge") mode type the code very quickly and press
 * Enter. This captures such bursts anywhere on the page — except while the user is typing into a form
 * field — so a scanner works without first focusing an input. Human typing is far slower and ignored.
 */
export function useKeyboardWedge(onScan: (code: string) => void, enabled: boolean) {
  const buffer = useRef<{ chars: string; first: number; last: number }>({ chars: "", first: 0, last: 0 });
  const debounce = useRef(new WedgeDebouncer(150));
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (typing && !t?.dataset.wedge) return;
      const now = performance.now();
      const b = buffer.current;
      if (now - b.last > 80) {
        b.chars = "";
        b.first = now;
      }
      if (e.key === "Enter") {
        const fast = b.chars.length >= 6 && (now - b.first) / b.chars.length < 40;
        const code = fast ? cleanBarcode(b.chars) : null;
        b.chars = "";
        if (code && debounce.current.accept(code, now)) {
          e.preventDefault();
          onScanRef.current(code);
        }
        return;
      }
      if (e.key.length === 1) {
        b.chars += e.key;
        b.last = now;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
