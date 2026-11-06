"use client";

import { AlertTriangle, CalendarDays, ChefHat, PackageX, ScanBarcode, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, Empty, ErrorNote, Loading } from "@/components/ui/primitives";
import { DueBadge } from "@/components/due-badge";
import type { InventoryItem } from "@/lib/inventory/overview";
import type { PlannedMeal } from "@/lib/meals/service";
import { useApi } from "@/lib/client";
import { fmtAmount, weekday } from "@/lib/utils";

interface Dashboard {
  today: string;
  tonight: PlannedMeal[];
  week: PlannedMeal[];
  expiring: InventoryItem[];
  lowStock: Array<{ productId: number; name: string; missing: number | null }>;
  groceries: Array<{ retailerId: string; name: string; open: number }>;
  notifications: Array<{ id: number; title: string; body: string | null; link: string | null; createdAt: string; readAt: string | null }>;
}

function cookHref(m: PlannedMeal): string {
  return `/cook/${m.recipe!.slug}?entry=${m.id}&servings=${m.plannedServings}`;
}

export default function HomePage() {
  const { data, error, loading, reload } = useApi<Dashboard>("/api/dashboard");

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  const dinner = data.tonight[0];
  const upcoming = data.week.filter((m) => m.date >= data.today);

  return (
    <div className="grid gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{weekday(data.today)}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Tonight</h1>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/scan">
            <ScanBarcode /> Scan groceries
          </Link>
        </Button>
      </div>

      <Card className="overflow-hidden">
        {dinner?.recipe ? (
          <div className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Dinner</p>
              <p className="truncate text-xl font-semibold">{dinner.recipe.name}</p>
              <p className="text-sm text-muted-foreground">
                {fmtAmount(dinner.plannedServings)} servings{dinner.recipe.totalTime ? ` · ${dinner.recipe.totalTime}` : ""}
                {dinner.leftoverOf ? " · leftovers" : ""}
              </p>
            </div>
            {dinner.cooked ? (
              <Badge variant="success">Cooked</Badge>
            ) : dinner.leftoverOf ? (
              <Badge variant="muted">Already deducted</Badge>
            ) : (
              <Button asChild size="lg">
                <Link href={cookHref(dinner)}>
                  <ChefHat /> We cooked this
                </Link>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-muted-foreground">Nothing planned for dinner tonight.</p>
            <Button asChild variant="secondary">
              <Link href="/assistant?q=What%20should%20we%20cook%20tonight%3F">Get ideas</Link>
            </Button>
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDays className="size-4 text-muted-foreground" /> This week
            </CardTitle>
            <Link href="/meals" className="text-sm font-medium text-primary">
              Plan
            </Link>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">No meals planned for the rest of the week.</p>
            ) : (
              <ul className="divide-y">
                {upcoming.slice(0, 8).map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span className="w-24 shrink-0 text-muted-foreground">{weekday(m.date)}</span>
                    <span className="min-w-0 flex-1 truncate">{m.recipe?.name ?? m.title}</span>
                    <span className="text-xs capitalize text-muted-foreground">{m.entryType}</span>
                    {m.cooked ? <Badge variant="success">✓</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" /> Use soon
            </CardTitle>
            <Link href="/inventory?status=expiring" className="text-sm font-medium text-primary">
              All
            </Link>
          </CardHeader>
          <CardContent>
            {data.expiring.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is expiring soon.</p>
            ) : (
              <ul className="divide-y">
                {data.expiring.slice(0, 8).map((i) => (
                  <li key={i.productId} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <Link href={`/inventory/${i.productId}`} className="min-w-0 flex-1 truncate hover:underline">
                      {i.name}
                    </Link>
                    <span className="text-muted-foreground">
                      {fmtAmount(i.amount)} {i.unit}
                    </span>
                    <DueBadge status={i.dueStatus} due={i.nextDue} today={data.today} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PackageX className="size-4 text-danger" /> Low stock
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.lowStock.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everything is above its minimum.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {data.lowStock.map((l) => (
                  <li key={l.productId}>
                    <Badge variant="danger">
                      {l.name}
                      {l.missing ? ` · need ${fmtAmount(l.missing)}` : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="size-4 text-muted-foreground" /> Grocery lists
            </CardTitle>
            <Link href="/shopping" className="text-sm font-medium text-primary">
              Open
            </Link>
          </CardHeader>
          <CardContent>
            {data.groceries.every((g) => g.open === 0) ? (
              <p className="text-sm text-muted-foreground">No open items. Build lists from the meal plan on the Shopping page.</p>
            ) : (
              <ul className="grid gap-1.5 text-sm">
                {data.groceries.map((g) => (
                  <li key={g.retailerId} className="flex justify-between">
                    <span>{g.name}</span>
                    <span className="text-muted-foreground">{g.open} to buy</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {data.notifications.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent notices</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 text-sm">
              {data.notifications.map((n) => (
                <li key={n.id}>
                  {n.link ? (
                    <Link href={n.link} className="font-medium hover:underline">
                      {n.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{n.title}</span>
                  )}
                  {n.body ? <p className="line-clamp-2 whitespace-pre-line text-muted-foreground">{n.body}</p> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {data.week.length === 0 && data.expiring.length === 0 ? (
        <Empty icon={<ScanBarcode />} title="Start by scanning what you have">
          Scan groceries as you put them away, then plan meals around them.
        </Empty>
      ) : null}
    </div>
  );
}
