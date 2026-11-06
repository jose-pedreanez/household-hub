/**
 * Decides which camera detections count as new scans.
 *
 * A camera sees the same package many times per second. A barcode is accepted once, then ignored
 * for as long as it stays in view; it becomes scannable again only after it has been out of view
 * for `absenceMs`. Holding a package in front of the camera therefore books one package, while
 * taking it away and showing it again (or pressing "+1") books another.
 *
 * Pure and clock-injected so it can be unit-tested and shared with the keyboard-wedge path.
 */
export interface ScanGateOptions {
  /** How long a code must be absent before it can be accepted again. */
  absenceMs: number;
  /** Consecutive frames a code must appear in before acceptance (guards against misreads). */
  confirmFrames: number;
}

export const DEFAULT_SCAN_GATE: ScanGateOptions = { absenceMs: 1500, confirmFrames: 2 };

export class ScanGate {
  private lastSeen = new Map<string, number>();
  private accepted = new Set<string>();
  private streak = new Map<string, number>();
  private rearmed = new Set<string>();

  constructor(private readonly opts: ScanGateOptions = DEFAULT_SCAN_GATE) {}

  /** Feed the codes decoded from one frame; returns codes to treat as new scans. */
  observe(codes: Iterable<string>, now: number): string[] {
    const present = new Set(codes);

    // Codes that left the view long enough become eligible again.
    for (const [code, seenAt] of this.lastSeen) {
      if (!present.has(code) && now - seenAt >= this.opts.absenceMs) {
        this.lastSeen.delete(code);
        this.accepted.delete(code);
        this.streak.delete(code);
      }
    }
    for (const code of [...this.streak.keys()]) if (!present.has(code)) this.streak.delete(code);

    const fresh: string[] = [];
    for (const code of present) {
      this.lastSeen.set(code, now);
      const streak = (this.streak.get(code) ?? 0) + 1;
      this.streak.set(code, streak);
      if (this.rearmed.has(code)) {
        this.rearmed.delete(code);
        this.accepted.add(code);
        fresh.push(code);
        continue;
      }
      if (!this.accepted.has(code) && streak >= this.opts.confirmFrames) {
        this.accepted.add(code);
        fresh.push(code);
      }
    }
    return fresh;
  }

  /** Intentional repeat: accept the next detection of `code` even if it never left the view. */
  rearm(code: string): void {
    this.rearmed.add(code);
  }

  reset(): void {
    this.lastSeen.clear();
    this.accepted.clear();
    this.streak.clear();
    this.rearmed.clear();
  }
}

/**
 * Keyboard-wedge scanners type the code and press Enter for every trigger pull, so each Enter is an
 * intentional scan. Some scanners send a burst twice; drop an identical code within `windowMs`.
 */
export class WedgeDebouncer {
  private last: { code: string; at: number } | null = null;
  constructor(private readonly windowMs = 250) {}

  accept(code: string, now: number): boolean {
    if (this.last && this.last.code === code && now - this.last.at < this.windowMs) return false;
    this.last = { code, at: now };
    return true;
  }
}
