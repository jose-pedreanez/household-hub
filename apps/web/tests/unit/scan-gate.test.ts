import { describe, expect, it } from "vitest";
import { ScanGate, WedgeDebouncer } from "@/lib/barcode/scan-gate";

describe("camera scan gate", () => {
  const opts = { absenceMs: 1500, confirmFrames: 2 };

  it("needs consecutive frames before accepting (guards against misreads)", () => {
    const g = new ScanGate(opts);
    expect(g.observe(["A"], 0)).toEqual([]);
    expect(g.observe(["A"], 100)).toEqual(["A"]);
  });

  it("books one package while the barcode stays in view", () => {
    const g = new ScanGate(opts);
    const accepted: string[] = [];
    for (let t = 0; t <= 10_000; t += 100) accepted.push(...g.observe(["A"], t));
    expect(accepted).toEqual(["A"]);
  });

  it("brief dropouts shorter than the absence window do not re-trigger", () => {
    const g = new ScanGate(opts);
    g.observe(["A"], 0);
    g.observe(["A"], 100);
    g.observe([], 600);
    g.observe([], 1200);
    expect(g.observe(["A"], 1300)).toEqual([]);
    expect(g.observe(["A"], 1400)).toEqual([]);
  });

  it("accepts the same barcode again after it leaves the view", () => {
    const g = new ScanGate(opts);
    g.observe(["A"], 0);
    expect(g.observe(["A"], 100)).toEqual(["A"]);
    g.observe([], 200);
    g.observe([], 1700); // absent ≥ 1500 ms since last seen at 100
    expect(g.observe(["A"], 1800)).toEqual([]);
    expect(g.observe(["A"], 1900)).toEqual(["A"]);
  });

  it("rearm allows an intentional repeat without moving the package", () => {
    const g = new ScanGate(opts);
    g.observe(["A"], 0);
    g.observe(["A"], 100);
    g.rearm("A");
    expect(g.observe(["A"], 200)).toEqual(["A"]);
    expect(g.observe(["A"], 300)).toEqual([]);
  });

  it("handles two different barcodes in view independently", () => {
    const g = new ScanGate(opts);
    g.observe(["A", "B"], 0);
    expect(g.observe(["A", "B"], 100).sort()).toEqual(["A", "B"]);
  });
});

describe("keyboard-wedge debouncer", () => {
  it("treats each Enter as a scan but drops an identical burst echo", () => {
    const d = new WedgeDebouncer(250);
    expect(d.accept("A", 0)).toBe(true);
    expect(d.accept("A", 100)).toBe(false);
    expect(d.accept("A", 400)).toBe(true);
    expect(d.accept("B", 450)).toBe(true);
  });
});
