import { z } from "zod";
import { body, route } from "@/lib/api";
import { listNotifications, markNotificationsRead, notify } from "@/lib/alerts";
import { services } from "@/lib/services";

export const GET = route(async () => ({ notifications: listNotifications(services().db, 50) }));

const postSchema = z.union([
  z.object({ read: z.array(z.number().int()).optional(), markAllRead: z.literal(true).optional() }),
  z.object({ kind: z.string().max(40), title: z.string().max(200), body: z.string().max(4000).optional(), link: z.string().max(200).optional() }),
]);

/** Mark notifications read, or (automation) post a notification into the household feed. */
export const POST = route(async (req) => {
  const input = await body(req, postSchema);
  const db = services().db;
  if ("title" in input) {
    notify(db, input);
    return { ok: true };
  }
  markNotificationsRead(db, input.markAllRead ? undefined : input.read);
  return { ok: true };
});
