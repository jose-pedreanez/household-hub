# Barcode workflow

## Input methods (one pipeline)

| Method | How | Notes |
|---|---|---|
| Phone camera | `/scan` → Camera → Start camera | Rear camera; decoded **in the browser** by ZXing-C++ (WebAssembly, served from the hub at `/zxing/`, no CDN). Accepts only checksum-valid UPC-A, EAN-13, EAN-8, UPC-E. Needs HTTPS (or localhost). |
| USB / Bluetooth scanner | Just scan on the `/scan` page | Keyboard-wedge mode: the scanner types the code and Enter. Bursts typed faster than a person can type are captured anywhere on the page; normal typing in form fields is ignored. |
| Manual | `/scan` → Type | Always shows the confirm card. |

All three call the same `handleCode()` → `GET /api/scan/resolve` → `POST /api/scan/receive` (or
`/consume`). Scans are processed one at a time in arrival order.

## Duplicate reads vs. intentional rescans

- **Camera:** a code must appear in two consecutive frames, is accepted once, and is then ignored while it
  stays in view. It becomes scannable again after it has been out of view for 1.5 s. Holding a carton in
  front of the camera books one carton; taking it away and showing it again books another.
- **Hardware scanner:** every trigger pull is a scan; an identical burst within 150 ms (some scanners send
  twice) is dropped.
- **+1** on a booked item books another package without rescanning.
- Each *intended* scan gets its own idempotency key. Network retries reuse it, so a retried request can
  never book twice; a new scan gets a new key and books again.

## Resolution

1. Grocy barcode lookup, trying both UPC-A and EAN-13 forms (scanners disagree about the leading zero).
2. Known → product, package definition (barcode `amount` in barcode `qu_id`, converted to the stock unit),
   current stock, the Mealie food it counts as (via the parent product), default location/store/due date.
3. Unknown → Open Food Facts (cached locally 30 days; stale data served if OFF is down; an OFF failure is
   shown as a failure, not as "no data"), plus ranked suggestions from Mealie foods and generic Grocy
   products. Close calls are flagged *ambiguous* and nothing is pre-selected.

## Registration (first scan of a new product)

The sheet is pre-filled from Open Food Facts: name, brand, package size (parsed from structured fields or
text like "16 oz (454 g)", "6 x 150 g", "12 eggs"), stock unit (g for weights, mL for liquids, pieces for
counts), storage location, store, category, shelf life, minimum stock. Nutrition is shown read-only with its
basis and an *unverified* label. The household chooses which ingredient it is:

- an existing Mealie food → the product becomes a sub-product of the food's mapped generic Grocy product;
- an existing generic Grocy product (group);
- a new ingredient → a Mealie food and a generic `no_own_stock` Grocy product are created and mapped
  through Grocy-Mealie Sync;
- not linked (not used in recipes).

The barcode is created with its package size, so later scans need no registration. Registering a barcode
that already exists is refused (no silent re-linking). The OFF data is stored in the hub's metadata store,
linked to the product and marked household-confirmed.

## Receiving

`POST /api/scan/receive` with `{idempotencyKey, productId, barcode, packages=1, locationId?,
shoppingLocationId?, bestBeforeDate?, pricePerPackage?, batchId?}`:

1. Journal row (`scan_transactions`) with the computed package and stock amounts.
2. Watermark of the product's stock log, then `POST /stock/products/{id}/add` with `amount` = packages ×
   package size in the stock unit, `note: hub:<key>`, price converted to per-stock-unit.
3. Completed (Grocy transaction id stored), failed (rejected; may be retried), or uncertain (timeout/5xx).
4. A retry of an uncertain scan waits out a 30 s settling window, then looks for the `hub:<key>` row in the
   stock log: found → completed without a second booking; absent → submitted once.

Default due date: the product's default shelf life; "never expires" if set so; otherwise no date (Grocy
would otherwise stamp *today*, making new stock appear expired) — the confirm card lets you set one.

Examples: one 500 g bag → 500 g; one 1 lb box stocked in grams → 453.59 g; one 946 mL carton → 946 mL; a
dozen eggs → 12 pieces; a six-pack stocked in pieces with a product conversion "1 Pack = 6 Piece" → 6.

**Undo:** per item or the whole session batch; it calls Grocy's transaction undo and is idempotent.

**Consume by scan:** `/scan` → Use up. One package by default (Grocy picks lots by its default rule).
