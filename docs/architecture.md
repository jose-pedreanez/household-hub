# Architecture

```text
                    Household phones / laptops
                               │  HTTPS (Caddy, local CA)
                               ▼
                    Household Hub (Next.js 16, PWA)
         pages ─── server-side API routes (/api/*) ─── SQLite (hub.db)
                │              │               │            journals, idempotency,
                ▼              ▼               ▼            metadata, annotations
             Grocy          Mealie      Grocy-Mealie Sync
         (inventory)   (recipes, plans,   (food↔product and
                        shopping lists)    unit mappings)
                ▲              ▲               │
                └──────────────┴── polls ──────┘
                               ▲
                     n8n (schedules) ── calls /api/automation/* with a bearer token
                               │
              Open Food Facts · Anthropic/OpenAI · Instacart (optional)  ← called by the hub only
```

## Who owns what

| Data | Authority | Hub keeps |
|---|---|---|
| Physical stock, lots, due dates, barcodes, package sizes, locations, stores, unit conversions | **Grocy** | nothing |
| Recipes, foods, units, meal plan, shopping lists | **Mealie** | per-entry planned servings and leftovers links (`plan_entry_annotations`) |
| Mealie food ↔ Grocy product, Mealie unit ↔ Grocy unit | **Grocy-Mealie Sync** | nothing (read on demand) |
| Scan transactions, cooking journal, idempotency keys | **Hub** (`scan_transactions`, `cooking_occurrences`, `cooking_lines`, `idempotency_keys`) | — |
| Nutrition with its basis, ingredients, allergens, provenance; edible yield | **Hub metadata store** (`product_metadata`, `product_attributes`) | versioned, behind `MetadataStore` |
| AI runs, recipe proposals, assistant actions, notifications, alert dedupe, audit log | **Hub** | — |

No inventory or recipe data is duplicated. The hub's SQLite file holds only what the other services
cannot represent.

## Key decisions

**One ingredient, many products — Grocy parent products.** Grocy-Mealie Sync mappings are strictly 1:1
(a unique index on both sides), and mapping a product renames it to the Mealie food name. So each Mealie
food maps to a *generic* Grocy product ("Pasta", `no_own_stock`), and brand products ("Barilla Spaghetti
1 lb", "Trader Joe's Penne 500 g") are its sub-products. Availability and consumption walk the family.
Grocy-Mealie Sync runs with `SYNC_SUB_PRODUCTS=true`.

**Package size lives on the barcode.** Grocy's `product_barcodes.amount` / `qu_id` say what one scan is
(1 lb, 946 mL, 12 pieces, 1 pack). The hub converts that to the stock unit explicitly before calling
Grocy's `add` (which takes stock-unit amounts). Different package sizes are different barcodes.

**Single source of truth for purchases: receiving.** Stock goes up only through the hub's receiving
pipeline (scan, or receive without a barcode). Grocy-Mealie Sync books stock when a row on *its* Mealie
list is checked, so: (1) store lists are separate Mealie lists that GMS does not watch; (2) the hub refuses
to check rows on the GMS list; (3) checking a store-list item only marks it picked up.

**Cooking is hub-driven.** Mealie v3 has no "meal cooked" event (plan entries have no completion field;
its notifier only reports plan create/update/delete). The hub's `/cook/[slug]` page is the completion
workflow; a Mealie *link* Recipe Action ("Mark cooked in Household Hub") opens it from any recipe with
`${slug}` and `${servings}`. Mealie *post* actions were rejected for this: fire-and-forget, no auth header,
no confirmation step. After stock is deducted the hub sets the recipe's `lastMade` and adds a timeline
event (best effort, retried by the maintenance workflow).

**Uncertain writes are reconciled, never blindly retried.** Grocy and Mealie share no transaction. Every
Grocy stock write is journaled before it is sent, with a stock-log watermark (and a `hub:<key>` note on
purchases). A timeout or 5xx marks the write *uncertain*; after a 30 s settling window the hub looks for
the exact transaction in Grocy's stock log above the watermark and either adopts it or resubmits once.

**AI recommends, code decides.** The AI sees real inventory names and dates and the recipe catalogue,
returns a Zod-validated plan that references recipes by id, and never supplies quantities or nutrition.
Every reference is re-validated; anything invalid is dropped with an explanation; empty slots are filled by
a deterministic planner. New recipes are proposals that a person must approve before they reach Mealie.

## Security model

- Only Caddy listens on the LAN (80 for the CA certificate and redirects, 443 hub, 9443 Mealie). Grocy,
  Grocy-Mealie Sync, n8n and the raw hub port are bound to 127.0.0.1.
- Household sign-in: one shared password → HMAC-signed, HttpOnly, SameSite=Lax session cookie (30 days).
  Cookie-authenticated writes must come from the hub's own origin. Login attempts are rate limited.
- Automation (n8n) uses `Authorization: Bearer HUB_API_TOKEN`.
- Grocy, Mealie, GMS, AI and Instacart credentials exist only in `.env` and server containers; the smoke
  test and a browser test check that none of them appear in any page or JavaScript bundle.
- The proxy (`proxy.ts`) only redirects signed-out page views; every API route authenticates itself.

## Repository layout

```text
apps/web/              Next.js app (App Router, TypeScript strict, Tailwind 4, Radix UI)
  app/(app)/           household pages: /, /inventory, /scan, /meals, /cook/[slug], /shopping, /assistant, /settings
  app/api/             server-side API routes (the only place upstream credentials are used)
  lib/grocy|mealie|sync   validated API clients and the mapping snapshot
  lib/barcode          normalisation, scan gate, resolution, registration, receiving journal
  lib/cooking          plan builder (pure), journal, executor (retry, reversal, correction)
  lib/nutrition        Open Food Facts client, versioned metadata store
  lib/units            conversion engine (Grocy conversions first, exact physical constants second)
  lib/meals|shopping|retailers   requirements, store lists, retailer adapters, sourcing
  lib/ai               provider abstraction (Anthropic/OpenAI), planner, heuristic planner, assistant
  tests/unit|integration|e2e
config/                household and retailer preferences (YAML, version-controlled, no secrets)
infrastructure/proxy/  Caddyfile
workflows/n8n/         exported workflows (generated by scripts/build-n8n-workflows.mjs)
scripts/               bootstrap, seed, n8n import, backup, restore, smoke test
```
