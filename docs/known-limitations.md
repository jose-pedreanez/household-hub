# Known limitations and open dependencies

## Not verified yet

- The stack is deployed and passes `scripts/smoke.sh`; bootstrap and the n8n import ran successfully on
  2026-10-22. Not yet run on the real services: `scripts/seed-demo.mjs`, the live integration suite
  (`npm run test:integration`, which exercises scan → receive → cook → deduct → reverse and the Grocy
  behaviours listed in [api-integrations.md](api-integrations.md)), backup/restore, and
  `scripts/smoke.sh --restart`.
- The 20 browser tests run against a **mock** of the upstream APIs; the integration suite is what confirms
  the real services agree.
- **HTTPS on a real phone** is untested (needs the Hyper-V firewall rule and the CA on the phone). The
  camera pipeline was verified in Chromium with a synthetic barcode video.

## By design / upstream limits

- **Mealie has no “meal cooked” event.** Completion is recorded through the hub (Meals page, home page, or
  the Mealie Recipe Action link). Mealie's own “I made this” button does not deduct stock.
- **Retailers:** Trader Joe's has no online ordering or public API; Grocery Outlet has none of its own;
  Amazon Fresh has no consumer cart API that could be verified. All three get manual lists (copy, share,
  email, print, CSV; Amazon search links). Availability is always “unknown”. Instacart shopping-list links
  are implemented but need an Instacart Developer Platform key (not available here) and the shopper picks
  the store on Instacart. Nothing ever adds to a cart or places an order.
- **Receipt ingestion** is an interface only (`POST /api/automation/receipts` validates and returns 501).
  No email account integration without credentials.
- Grocy-Mealie Sync mappings are 1:1. Several products per ingredient work through Grocy parent products;
  mapping a food directly to a brand product renames that product (GMS behaviour).
- If someone checks items on the GMS “Low stock” list inside Mealie, GMS books a purchase. The hub cannot
  prevent that; it only refuses to do it itself and says why in the UI.
- Consume-by-scan lets Grocy choose lots with its default rule; cooking chooses lots explicitly.
- Unit conversion never guesses densities. Volume↔mass needs a product-specific Grocy conversion.
- Nutrition is informational. Recipe nutrition comes from Mealie as entered; product nutrition from Open
  Food Facts as published (unverified until confirmed). No targets or restrictions are applied.
- The hub runs as a single instance (per-occurrence locking is in-process). Don't scale the hub container.
- Ubuntu 22.04 is installed in WSL (the brief mentioned 24.04); nothing depends on the difference.

## Dependencies the household must provide

| What | Why | Where |
|---|---|---|
| Docker access without sudo | everything | deployment.md |
| Hyper-V firewall rule (admin PowerShell) | phones reaching WSL | deployment.md |
| CA certificate on each phone | camera over HTTPS | deployment.md |
| n8n owner account | n8n UI | deployment.md |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` + `OPENAI_MODEL` (optional) | cloud AI planning/assistant | `.env` |
| `INSTACART_API_KEY` (optional) | Instacart list hand-off | `.env`, `config/retailers.yaml` |
| ntfy topic / email / Slack (optional) | push notifications from n8n | n8n workflow node |
| Real recipes, foods and product mappings | meaningful plans | Mealie, Grocy-Mealie Sync |
