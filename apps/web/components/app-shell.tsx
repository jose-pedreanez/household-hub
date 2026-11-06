"use client";

import { Bell, Bot, Boxes, CalendarDays, Home, ScanBarcode, Settings, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/scan", label: "Scan", icon: ScanBarcode, primary: true },
  { href: "/meals", label: "Meals", icon: CalendarDays },
  { href: "/shopping", label: "Shopping", icon: ShoppingCart },
];
const EXTRA = [
  { href: "/assistant", label: "Assistant", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/*
 * usePathname() needs request data on dynamic routes, so the navigation renders inside Suspense with a
 * fallback that is identical minus the active highlight; the rest of the shell stays prerenderable.
 */
function ActiveSideNav() {
  return <SideNav pathname={usePathname()} />;
}

function ActiveBottomNav() {
  return <BottomNav pathname={usePathname()} />;
}

function SideNav({ pathname }: { pathname: string | null }) {
  return (
    <nav className="flex flex-1 flex-col gap-1">
      {[...NAV, ...EXTRA].map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
            pathname && isActive(pathname, href) && "bg-secondary text-secondary-foreground",
          )}
        >
          <Icon className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function BottomNav({ pathname }: { pathname: string | null }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-card/95 pb-safe pt-1 backdrop-blur md:hidden">
      {NAV.map(({ href, label, icon: Icon, primary }) => (
        <Link
          key={href}
          href={href}
          className={cn("flex flex-col items-center gap-0.5 py-1 text-[11px] font-medium text-muted-foreground", pathname && isActive(pathname, href) && "text-primary")}
        >
          {primary ? (
            <span className="-mt-5 grid size-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg ring-4 ring-background">
              <Icon className="size-6" />
            </span>
          ) : (
            <Icon className="size-5" />
          )}
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
    }
  }, []);

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-card px-3 py-5 md:flex">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <ShoppingCart className="size-4" />
          </span>
          Household Hub
        </Link>
        <Suspense fallback={<SideNav pathname={null} />}>
          <ActiveSideNav />
        </Suspense>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/90 px-4 py-2.5 backdrop-blur md:hidden">
          <Link href="/" className="font-semibold">
            Household Hub
          </Link>
          <div className="flex items-center gap-1">
            <Link href="/assistant" className="rounded-md p-2 text-muted-foreground hover:bg-muted" aria-label="Assistant">
              <Bot className="size-5" />
            </Link>
            <Link href="/settings#notifications" className="rounded-md p-2 text-muted-foreground hover:bg-muted" aria-label="Notifications">
              <Bell className="size-5" />
            </Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-4 md:px-8 md:pb-10 md:pt-8">{children}</main>

        {/* Mobile bottom navigation */}
        <Suspense fallback={<BottomNav pathname={null} />}>
          <ActiveBottomNav />
        </Suspense>
      </div>
      <Toaster position="top-center" richColors closeButton />
    </div>
  );
}
