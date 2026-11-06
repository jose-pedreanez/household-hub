# API integrations

All calls are made server-side by `apps/web/lib/*/client.ts`, validated with Zod at the boundary, with
timeouts and classified failures (`lib/http.ts`). A write that times out or gets a 5xx is reported as
*outcome uncertain*.

## Grocy 4.7.1 (`lib/grocy/client.ts`)

Header `GROCY-API-KEY`. Endpoints used:

| Purpose | Endpoint |
|---|---|
| Version / health | `GET /api/system/info` |
| Products, units, locations, stores, groups, barcodes, conversions | `GET/POST/PUT /api/objects/{entity}` (filters `query[]=field=value`, `field>n`) |
| Resolved conversions (incl. product-specific and derived) | `GET /api/objects/quantity_unit_conversions_resolved` |
| Stock per product / location | `GET /api/stock`, `GET /api/objects/stock_current_locations` |
| Expiring, overdue, below minimum | `GET /api/stock/volatile?due_soon_days=N` |
| Barcode lookup | `GET /api/stock/products/by-barcode/{barcode}` (HTTP 400 = unknown) |
| Lots | `GET /api/stock/products/{id}/entries` |
| Receive | `POST /api/stock/products/{id}/add` — `amount` in **stock units**, `best_before_date`, `price` per stock unit, `location_id`, `shopping_location_id`, `note` |
| Consume | `POST /api/stock/products/{id}/consume` — `amount` in stock units, optional `stock_entry_id` (a lot) |
| Count correction | `POST /api/stock/products/{id}/inventory` |
| Undo / inspect | `POST /api/stock/transactions/{tid}/undo`, `GET /api/stock/transactions/{tid}` |
| Reconciliation | `GET /api/objects/stock_log?query[]=product_id=X&query[]=id>W` |

The hub does **not** use `.../by-barcode/{barcode}/add`: it converts the barcode's package size itself so
the amount booked is explicit and journaled. Behaviours the integration suite checks on a live instance:
`add` takes stock-unit amounts and returns the transaction id; purchase log rows carry the `note`; the
`id>` filter works on `stock_log`; `consume` honours `stock_entry_id` for amounts above 1.

## Mealie v3.28.0 (`lib/mealie/client.ts`)

`Authorization: Bearer <long-lived token>` (created by `scripts/bootstrap.mjs`).

| Purpose | Endpoint |
|---|---|
| Recipes | `GET /api/recipes?search=`, `GET /api/recipes/{slug}`, `POST /api/recipes` + `PATCH /api/recipes/{slug}` (approved AI proposals) |
| Cooked bookkeeping | `PATCH /api/recipes/{slug}/last-made`, `POST /api/recipes/timeline/events` |
| Foods / units | `GET/POST /api/foods`, `GET /api/units` (food `substitutions` are used as the only automatic substitution source) |
| Meal plan (authority) | `GET/POST /api/households/mealplans`, `GET/PUT/DELETE /api/households/mealplans/{id}` |
| Shopping lists | `GET/POST /api/households/shopping/lists`, `GET .../lists/{id}`, `POST/PUT/DELETE /api/households/shopping/items` |
| Recipe action | `POST /api/households/recipe-actions` (`actionType: link`, created by bootstrap) |

**Meal completion in Mealie:** not available as an event. Mealie's "I made this" button only adds a
timeline entry and `lastMade`, with no servings and no plan entry, and its notifier has no such event, so
the hub cannot react to it reliably. The supported path is the Recipe Action link or the hub's Meals page.

## Grocy-Mealie Sync 1.18.0 (`lib/sync/gms-client.ts`)

`Authorization: Bearer AUTH_SECRET`. Used for: `GET /api/mappings/products`, `GET /api/mappings/units`,
`GET /api/status`, `POST /api/mapping-wizard/products/sync` (create a food ↔ generic-product mapping during
registration), `POST /api/sync/grocy-to-mealie/in-possession`, `POST /api/sync/products`.

What GMS does that the hub deliberately does not duplicate: name-based product and unit matching, Mealie
"In possession" from Grocy stock, low-stock → Mealie list, the mapping wizard, the unit-conversion library
(Units & Conversions page), and its device API for the ESP32 scanner. What the hub adds: idempotent
receiving with explicit package conversion, nutrition metadata, cooking deduction, store-specific lists.

Configuration (compose.yaml): `SYNC_SUB_PRODUCTS=true`, `SYNC_MEALIE_IN_POSSESSION=true`,
`ENSURE_LOW_STOCK_ON_MEALIE_LIST=true`, `AUTO_CREATE_PRODUCTS=false`, `AUTO_CREATE_UNITS=false`,
`MEALIE_SHOPPING_LIST_ID=<the "Low stock (synced from Grocy)" list>`.

## Open Food Facts (`lib/nutrition/off.ts`)

`GET https://world.openfoodfacts.org/api/v2/product/{barcode}?fields=…` with a custom `User-Agent`
(`OFF_USER_AGENT`). Read limit is 15 requests/min per IP, so results are cached locally for 30 days and
stale data is served when OFF is down. Missing nutrients stay `null`; the basis (per 100 g / per 100 mL /
per serving) is stored with how it was determined; data is marked *unverified* until a person confirms it.
Grocy's native `calories` field is filled only when the conversion is exact.

## Cloud AI (`lib/ai/*`)

`AI_PROVIDER=anthropic|openai|none`.

- **Anthropic** (`@anthropic-ai/sdk` 1.1.0): `beta.messages.parse` with a Zod output format for plans,
  `beta.messages.toolRunner` for the assistant. Default model `claude-opus-5-5` (`ANTHROPIC_MODEL`
  overrides). Requests opt into server-side refusal fallbacks (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`): if the model declines, Anthropic retries on its recommended fallback
  model within the same call. Refusals are still detected and fall back to the built-in planner.
- **OpenAI** (`openai` 7.42.0): Responses API `responses.parse` with `zodTextFormat`; function-calling loop
  for the assistant. `OPENAI_MODEL` must be set explicitly.
- **none**: deterministic planner and a rule-based assistant for the common requests.

## Retailers (`lib/retailers/*`)

| Store | Adapter | What it can do |
|---|---|---|
| Trader Joe's (Alameda) | manual | list to copy / share / email / print / CSV. Trader Joe's has no online ordering or public API. |
| Grocery Outlet (Alameda) | manual (or `instacart`) | as above; with an Instacart key, an Instacart shopping-list link where the shopper picks the store |
| Amazon Fresh | manual | list plus plain links to Amazon's public search page per item |

Instacart Developer Platform: `POST /idp/v1/products/products_link` (`Authorization: Bearer <key>`),
development host `connect.dev.instacart.tools`, production `connect.instacart.com`. Only `each` quantities
are sent (unsupported units break Instacart's matching); the measured amount travels in `display_text`.
The shopper selects the store on Instacart's page, so the hub never sees store availability there.
Availability is reported as `unknown` everywhere — an API failure is never treated as out of stock. No
adapter adds to a cart or places an order. Amazon's cart-form / Business Cart APIs were not used: the
consumer add-to-cart form could not be verified and the Cart API is Amazon Business only.

## Hub API (for n8n and scripts)

`Authorization: Bearer HUB_API_TOKEN`:

| Endpoint | Purpose |
|---|---|
| `POST /api/automation/meal-plan` | draft next week's plan (not saved to Mealie) + notification |
| `POST /api/automation/shopping` | rebuild store lists for the next 7 days |
| `POST /api/automation/alerts` | new/changed expiry and low-stock alerts (deduplicated) |
| `POST /api/automation/audit` | items worth a physical check (weekly) |
| `POST /api/automation/maintenance` | retry Mealie bookkeeping for cooked meals |
| `POST /api/automation/receipts` | receipt contract (validates, returns 501 — not implemented) |
| `GET /api/health?deep=1` | connectivity to Grocy, Mealie, GMS |
