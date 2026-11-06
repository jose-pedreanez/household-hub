import "server-only";
import { today } from "../api";
import { mappingContext } from "../context";
import { services } from "../services";
import { ScanJournal } from "./journal";
import type { ReceivingDeps } from "./receive";

export function receivingDeps(): ReceivingDeps {
  const { db, grocy } = services();
  return {
    journal: new ScanJournal(db),
    grocy,
    catalog: async () => (await mappingContext()).catalog,
    today,
  };
}
