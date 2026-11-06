import { route } from "@/lib/api";
import { view } from "@/lib/cooking/execute";
import { CookingJournal } from "@/lib/cooking/journal";
import { services } from "@/lib/services";

export const GET = route<{ id: string }>(async (_req, { params }) => view(new CookingJournal(services().db), (await params).id));
