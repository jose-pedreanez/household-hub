import { route } from "@/lib/api";
import { storeListViews } from "@/lib/shopping/service";

export const GET = route(async () => storeListViews());
