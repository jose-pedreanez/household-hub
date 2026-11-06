import "server-only";
import { getDb, type Db } from "./db";
import { env } from "./env";
import { GrocyClient } from "./grocy/client";
import { MealieClient } from "./mealie/client";
import { SqliteMetadataStore, type MetadataStore } from "./nutrition/metadata-store";
import { OpenFoodFactsClient } from "./nutrition/off";
import { GmsClient } from "./sync/gms-client";

export interface Services {
  db: Db;
  grocy: GrocyClient;
  mealie: MealieClient;
  gms: GmsClient;
  off: OpenFoodFactsClient;
  metadata: MetadataStore;
}

const globalForServices = globalThis as unknown as { __hubServices?: Services };

/** Process-wide integration clients. All credentials stay on the server. */
export function services(): Services {
  if (!globalForServices.__hubServices) {
    const e = env();
    const db = getDb();
    globalForServices.__hubServices = {
      db,
      grocy: new GrocyClient(e.GROCY_URL, e.GROCY_API_KEY),
      mealie: new MealieClient(e.MEALIE_URL, e.MEALIE_API_TOKEN),
      gms: new GmsClient(e.GMS_URL, e.GMS_AUTH_SECRET),
      off: new OpenFoodFactsClient(e.OFF_BASE_URL, e.OFF_USER_AGENT),
      metadata: new SqliteMetadataStore(db),
    };
  }
  return globalForServices.__hubServices;
}
