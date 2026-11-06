# Cooking and inventory consumption

Planning a meal never touches stock. Stock is deducted only when someone confirms the meal was cooked.

## Entry points

- Meals page → **Mark cooked** on a planned meal (`/cook/{slug}?entry={id}&servings={n}`).
- Home → **We cooked this** for tonight's dinner.
- Mealie recipe page → ⋮ → **Mark cooked in Household Hub** (Recipe Action link created by bootstrap;
  opens `/cook/{slug}?servings={servings}`). If the recipe is planned for yesterday/today/tomorrow, the page
  offers to record it against that plan entry.

## The plan (preview, read-only)

`POST /api/cook/preview` builds a deterministic plan (`lib/cooking/plan.ts`):

1. scale = servings prepared ÷ recipe servings (Mealie `recipeServings`, else `recipeYieldQuantity`, else 1
   with a warning);
2. per ingredient line: Mealie food → mapped Grocy product (Grocy-Mealie Sync) → recipe unit → Grocy unit
   (unit mapping) → the product's stock unit (Grocy conversions, product-specific first; exact physical
   constants only for mass↔mass and volume↔volume) → divide by edible yield where set;
3. candidates: the mapped product and all its sub-products (converted into one unit);
4. lots of all candidates in one order: earliest due date first, never-expiring last, opened before
   sealed, oldest purchase, entry id; drawn greedily; lines share one pool so two lines never over-commit
   the same lot.

| Line status | Meaning | Blocks? |
|---|---|---|
| ok | fully covered | no |
| short | not enough stock (shows how much is missing) | yes, until “use what’s there” |
| unmapped | Mealie food has no Grocy product | yes, until skipped or a product is chosen |
| mapping_unavailable | Grocy-Mealie Sync unreachable | yes |
| unconvertible | no unit conversion (e.g. cups of a solid without a density) | yes, until an amount is entered or skipped |
| not_tracked / no_quantity | free-text line / “to taste” | no, nothing consumed |
| skipped | household chose “didn’t use” | no |

Household decisions per line: didn't use, used a different amount (partial use), use what's there
(shortage), use a Mealie-defined substitute (only foods listed as substitutions in Mealie), or pick a
specific product. Extra items not in the recipe can be added. Leftover servings are recorded; eating
leftovers later deducts nothing.

## Execution and the journal

`POST /api/cook` with an idempotency key (`lib/cooking/execute.ts`):

1. Same key + same request → resume/replay (never re-deduct). Same key + different request → 422.
2. A plan entry that already has a non-reversed cooking → 409 (unique index), whatever the key.
3. The plan is rebuilt from live stock; a blocking plan is refused.
4. `cooking_occurrences` + one `cooking_lines` row per lot, inserted atomically.
5. Per line: stock-log watermark → `consume` (`stock_entry_id` = the chosen lot) → `consumed` with the
   Grocy transaction id, `failed` (rejected), or `uncertain` (timeout/5xx).
6. All lines settled → `completed`; Mealie `lastMade` + timeline event (best effort; `mealie_synced`).
   Some lines open → `partial` (or `failed` if nothing was consumed).

Recorded per occurrence: plan entry id, occurrence id, recipe id/slug, servings, leftovers, the full plan,
every line's product, amount, unit, lot, Grocy transaction id, attempts, errors, timestamps.

**Retry** (`POST /api/cook/{id}/retry`): uncertain lines are reconciled first (exactly one matching consume
for that product and lot above the watermark → adopted; none → resubmitted; several → manual review);
failed/pending lines are resubmitted; consumed lines are never touched.

**Skip a line** (`.../lines/{n}` `{action:"skip"}`): give up on a line that cannot be consumed.

**Correct a line** (`{action:"correct", amount}`): undo that line's Grocy transaction and consume the
corrected amount from the same lot as a new `correction` line. `amount: 0` just returns the stock.

**Reverse** (`POST /api/cook/{id}/reverse`): undo every consumed line in reverse order; idempotent; frees
the plan entry so it can be cooked again; adds a Mealie timeline note.

## Multiple products, one ingredient — worked example

Recipe needs 1 lb pasta (453.59 g). Stock: Trader Joe's Penne 500 g (due Dec 1), Barilla 1 lb (due Mar 1),
both sub-products of “Pasta”. The plan takes 453.59 g from the penne (earlier due date); Barilla is untouched.
With 2 lb needed it would take all 500 g of penne and 407.18 g of Barilla — two journal lines, two Grocy
transactions, each undoable on its own.
