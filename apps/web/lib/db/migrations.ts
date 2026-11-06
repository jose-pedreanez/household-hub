/**
 * Versioned schema for the hub's own durable state.
 *
 * This database deliberately holds no inventory and no recipes: Grocy owns stock, Mealie owns recipes
 * and meal plans, Grocy-Mealie Sync owns food/product mappings. What lives here is state that none of
 * them can represent: idempotency records, transaction journals, metadata that has no native field,
 * meal-plan annotations, AI run records and notification bookkeeping.
 *
 * Migrations are append-only. Never edit a migration that has shipped; add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE idempotency_keys (
        key           TEXT PRIMARY KEY,
        scope         TEXT NOT NULL,
        request_hash  TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed')),
        response_json TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- One row per intended scan transaction (receiving a package, or consuming by scan).
      CREATE TABLE scan_transactions (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        kind                  TEXT NOT NULL CHECK (kind IN ('purchase','consume')),
        idempotency_key       TEXT NOT NULL UNIQUE,
        request_hash          TEXT NOT NULL,
        batch_id              TEXT,
        barcode               TEXT,
        grocy_product_id      INTEGER NOT NULL,
        product_name          TEXT NOT NULL,
        packages              REAL NOT NULL,
        package_amount        REAL NOT NULL,
        package_qu_id         INTEGER NOT NULL,
        stock_amount          REAL NOT NULL,
        stock_qu_id           INTEGER NOT NULL,
        location_id           INTEGER,
        shopping_location_id  INTEGER,
        best_before_date      TEXT,
        price_per_package     REAL,
        source                TEXT NOT NULL,
        status                TEXT NOT NULL CHECK (status IN ('pending','uncertain','completed','failed','undone')),
        grocy_transaction_id  TEXT,
        log_watermark         INTEGER,
        error                 TEXT,
        created_at            TEXT NOT NULL,
        submitted_at          TEXT,
        completed_at          TEXT,
        undone_at             TEXT
      );
      CREATE INDEX ix_scan_batch ON scan_transactions(batch_id);
      CREATE INDEX ix_scan_created ON scan_transactions(created_at);

      CREATE TABLE cooking_occurrences (
        id                 TEXT PRIMARY KEY,
        idempotency_key    TEXT NOT NULL UNIQUE,
        request_hash       TEXT NOT NULL,
        mealplan_entry_id  INTEGER,
        recipe_id          TEXT NOT NULL,
        recipe_slug        TEXT NOT NULL,
        recipe_name        TEXT NOT NULL,
        recipe_servings    REAL NOT NULL,
        servings           REAL NOT NULL,
        leftover_servings  REAL NOT NULL DEFAULT 0,
        status             TEXT NOT NULL CHECK (status IN ('executing','partial','completed','failed','reversing','reversed')),
        plan_json          TEXT NOT NULL,
        error              TEXT,
        mealie_synced      INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        completed_at       TEXT,
        reversed_at        TEXT
      );
      -- A meal-plan entry can be cooked once until that cooking is reversed.
      CREATE UNIQUE INDEX ux_cooking_mealplan_active
        ON cooking_occurrences(mealplan_entry_id)
        WHERE mealplan_entry_id IS NOT NULL AND status <> 'reversed';

      CREATE TABLE cooking_lines (
        occurrence_id         TEXT NOT NULL REFERENCES cooking_occurrences(id),
        line_no               INTEGER NOT NULL,
        kind                  TEXT NOT NULL CHECK (kind IN ('recipe','extra','correction')),
        corrects_line_no      INTEGER,
        ingredient_ref        TEXT,
        mealie_food_id        TEXT,
        description           TEXT NOT NULL,
        grocy_product_id      INTEGER NOT NULL,
        product_name          TEXT NOT NULL,
        amount                REAL NOT NULL,
        qu_id                 INTEGER NOT NULL,
        unit_name             TEXT NOT NULL,
        stock_entry_id        TEXT,
        best_before_date      TEXT,
        status                TEXT NOT NULL CHECK (status IN ('pending','submitting','uncertain','consumed','failed','skipped','reversed')),
        grocy_transaction_id  TEXT,
        log_watermark         INTEGER,
        attempts              INTEGER NOT NULL DEFAULT 0,
        error                 TEXT,
        submitted_at          TEXT,
        consumed_at           TEXT,
        reversed_at           TEXT,
        PRIMARY KEY (occurrence_id, line_no)
      );

      CREATE TABLE product_metadata (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        barcode           TEXT NOT NULL,
        source            TEXT NOT NULL,
        grocy_product_id  INTEGER,
        schema_version    INTEGER NOT NULL,
        verification      TEXT NOT NULL CHECK (verification IN ('unverified','user_confirmed')),
        payload_json      TEXT NOT NULL,
        fetched_at        TEXT,
        updated_at        TEXT NOT NULL,
        UNIQUE (barcode, source)
      );
      CREATE INDEX ix_product_metadata_product ON product_metadata(grocy_product_id);

      CREATE TABLE product_attributes (
        grocy_product_id  INTEGER PRIMARY KEY,
        edible_yield      REAL CHECK (edible_yield IS NULL OR (edible_yield > 0 AND edible_yield <= 1)),
        note              TEXT,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE plan_entry_annotations (
        mealplan_entry_id         INTEGER PRIMARY KEY,
        planned_servings          REAL,
        leftover_of_occurrence_id TEXT,
        note                      TEXT,
        updated_at                TEXT NOT NULL
      );

      CREATE TABLE ai_plan_runs (
        id             TEXT PRIMARY KEY,
        request_hash   TEXT NOT NULL,
        provider       TEXT NOT NULL,
        model          TEXT,
        status         TEXT NOT NULL CHECK (status IN ('ok','invalid','error')),
        raw_output     TEXT,
        result_json    TEXT,
        issues_json    TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX ix_ai_plan_runs_hash ON ai_plan_runs(request_hash, created_at);

      CREATE TABLE recipe_proposals (
        id             TEXT PRIMARY KEY,
        source_run_id  TEXT,
        name           TEXT NOT NULL,
        payload_json   TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
        mealie_slug    TEXT,
        created_at     TEXT NOT NULL,
        decided_at     TEXT
      );

      CREATE TABLE assistant_actions (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        summary       TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('proposed','executed','rejected','failed')),
        result_json   TEXT,
        created_at    TEXT NOT NULL,
        decided_at    TEXT
      );

      CREATE TABLE notifications (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        dedupe_key  TEXT,
        title       TEXT NOT NULL,
        body        TEXT,
        link        TEXT,
        created_at  TEXT NOT NULL,
        read_at     TEXT
      );
      CREATE INDEX ix_notifications_created ON notifications(created_at);

      CREATE TABLE alert_state (
        dedupe_key    TEXT PRIMARY KEY,
        fingerprint   TEXT NOT NULL,
        last_sent_at  TEXT NOT NULL
      );

      CREATE TABLE audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        actor         TEXT NOT NULL,
        action        TEXT NOT NULL,
        details_json  TEXT
      );
      CREATE INDEX ix_audit_at ON audit_log(at);
    `,
  },
];
