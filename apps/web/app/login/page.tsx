"use client";

import { ShoppingCart } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, ErrorNote, Input, Label } from "@/components/ui/primitives";
import { api } from "@/lib/client";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { password } });
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="password">Household password</Label>
        <Input id="password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {error ? <ErrorNote error={error} /> : null}
      <Button type="submit" size="lg" disabled={busy || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
            <ShoppingCart className="size-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Household Hub</h1>
            <p className="text-sm text-muted-foreground">Sign in to manage groceries and meals</p>
          </div>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </Card>
    </div>
  );
}
