/**
 * Retail barcode validation and normalisation (shared by browser and server).
 *
 * UPC-A (12 digits) is EAN-13 with a leading zero, and scanners disagree about which form they
 * report. Lookups therefore try both forms, while the form the user scanned is what gets stored.
 */

export type BarcodeFormat = "ean_13" | "upc_a" | "ean_8" | "upc_e" | "other";

/** GS1 mod-10 check digit for the digits *without* the check digit. */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function hasValidCheckDigit(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

/** Expand a UPC-E (8 digits incl. number system and check digit) to its UPC-A form. */
export function upcEToUpcA(upce: string): string | null {
  if (!/^[01]\d{7}$/.test(upce)) return null;
  const ns = upce[0];
  const d = upce.slice(1, 7);
  const check = upce[7];
  let body: string;
  switch (d[5]) {
    case "0":
    case "1":
    case "2":
      body = `${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}`;
      break;
    case "3":
      body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
      break;
    case "4":
      body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
      break;
    default:
      body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${d[5]}`;
  }
  const upca = `${ns}${body}${check}`;
  return hasValidCheckDigit(upca) ? upca : null;
}

export function detectFormat(code: string): BarcodeFormat {
  if (/^\d{13}$/.test(code) && hasValidCheckDigit(code)) return "ean_13";
  if (/^\d{12}$/.test(code) && hasValidCheckDigit(code)) return "upc_a";
  if (/^\d{8}$/.test(code)) {
    if (hasValidCheckDigit(code)) return "ean_8";
    if (upcEToUpcA(code)) return "upc_e";
  }
  return "other";
}

/** Trim scanner noise (whitespace, AIM prefixes such as "]E0") and reject obviously bad input. */
export function cleanBarcode(raw: string): string | null {
  let code = raw.trim().replace(/^\][A-Za-z]\d/, "").replace(/\s+/g, "");
  if (code.length < 4 || code.length > 64) return null;
  if (!/^[0-9A-Za-z_-]+$/.test(code)) return null;
  // Keep digits-only codes as digits; GTIN-14 with a leading zero is just an EAN-13.
  if (/^0\d{13}$/.test(code) && hasValidCheckDigit(code)) code = code.slice(1);
  return code;
}

/** Every representation under which this product might be stored (scanned form first). */
export function barcodeVariants(code: string): string[] {
  const out = [code];
  const add = (v: string | null) => {
    if (v && !out.includes(v)) out.push(v);
  };
  if (/^\d{12}$/.test(code)) add(`0${code}`);
  if (/^0\d{12}$/.test(code)) add(code.slice(1));
  if (/^\d{8}$/.test(code) && !hasValidCheckDigit(code)) {
    const upca = upcEToUpcA(code);
    add(upca);
    if (upca) add(`0${upca}`);
  }
  return out;
}

/** True for formats a phone camera scan should accept (UPC-A, EAN-13, EAN-8, UPC-E). */
export function isRetailBarcode(code: string): boolean {
  return detectFormat(code) !== "other";
}
