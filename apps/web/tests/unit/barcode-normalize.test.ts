import { describe, expect, it } from "vitest";
import { barcodeVariants, cleanBarcode, detectFormat, gs1CheckDigit, hasValidCheckDigit, upcEToUpcA } from "@/lib/barcode/normalize";

describe("barcode normalisation", () => {
  it("computes GS1 check digits", () => {
    expect(gs1CheckDigit("400638133393")).toBe(1); // EAN-13 4006381333931
    expect(gs1CheckDigit("03600029145")).toBe(2); // UPC-A 036000291452
    expect(hasValidCheckDigit("4006381333931")).toBe(true);
    expect(hasValidCheckDigit("4006381333932")).toBe(false);
  });

  it("detects UPC-A, EAN-13 and EAN-8", () => {
    expect(detectFormat("036000291452")).toBe("upc_a");
    expect(detectFormat("4006381333931")).toBe("ean_13");
    expect(detectFormat("96385074")).toBe("ean_8");
    expect(detectFormat("hello")).toBe("other");
  });

  it("expands UPC-E to UPC-A", () => {
    expect(upcEToUpcA("04252614")).toBe("042100005264");
  });

  it("tries both UPC-A and EAN-13 forms, scanned form first", () => {
    expect(barcodeVariants("036000291452")).toEqual(["036000291452", "0036000291452"]);
    expect(barcodeVariants("0036000291452")).toEqual(["0036000291452", "036000291452"]);
  });

  it("cleans scanner noise and GTIN-14 padding", () => {
    expect(cleanBarcode("  036000291452\r\n")).toBe("036000291452");
    expect(cleanBarcode("]E04006381333931")).toBe("4006381333931");
    expect(cleanBarcode("04006381333931")).toBe("4006381333931");
    expect(cleanBarcode("12")).toBeNull();
    expect(cleanBarcode("abc def<script>")).toBeNull();
  });
});
