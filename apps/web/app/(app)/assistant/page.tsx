"use client";

import { Bot, Check, Send, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, Input, PageHeader, Spinner } from "@/components/ui/primitives";
import type { AssistantReply, ProposedAction } from "@/lib/ai/assistant";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

interface Message {
  role: "user" | "assistant";
  content: string;
  actions?: Array<ProposedAction & { state?: "executed" | "rejected" | "failed" }>;
  mode?: "ai" | "rules";
  notice?: string | null;
}

const SUGGESTIONS = ["What should we cook tonight?", "What's in our freezer?", "What groceries do we need?", "Add milk to the grocery list", "Make next week's meal plan", "Replace Thursday's dinner"];

function AssistantView() {
  const initial = useSearchParams().get("q");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    const history: Message[] = [...messages, { role: "user", content: t }];
    setMessages(history);
    setInput("");
    setBusy(true);
    try {
      const r = await api<AssistantReply>("/api/assistant", { body: { messages: history.slice(-12).map(({ role, content }) => ({ role, content })) } });
      setMessages((m) => [...m, { role: "assistant", content: r.reply, actions: r.actions, mode: r.mode, notice: r.notice }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `Sorry — ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initial && !sentInitial.current) {
      sentInitial.current = true;
      void send(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  async function decide(msgIndex: number, action: ProposedAction, approve: boolean) {
    try {
      const r = await api<{ status: "executed" | "rejected" | "failed" }>(`/api/assistant/actions/${action.id}`, { body: { approve } });
      setMessages((m) => m.map((msg, i) => (i === msgIndex ? { ...msg, actions: msg.actions?.map((a) => (a.id === action.id ? { ...a, state: r.status } : a)) } : msg)));
      if (r.status === "executed") toast.success("Done");
    } catch (e) {
      toast.error((e as Error).message);
      setMessages((m) => m.map((msg, i) => (i === msgIndex ? { ...msg, actions: msg.actions?.map((a) => (a.id === action.id ? { ...a, state: "failed" } : a)) } : msg)));
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col gap-4">
      <PageHeader title="Assistant" subtitle="Answers come from your live inventory and meal plan. Changes wait for your confirmation." />
      <div className="flex flex-1 flex-col gap-3">
        {messages.length === 0 ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">Try:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="rounded-full border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] rounded-2xl px-4 py-2.5 text-sm", m.role === "user" ? "bg-primary text-primary-foreground" : "border bg-card")}>
              {m.role === "assistant" ? (
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Bot className="size-3.5" /> {m.mode === "rules" ? "Built-in assistant" : "AI assistant"}
                </div>
              ) : null}
              <p className="whitespace-pre-line">{m.content}</p>
              {m.notice ? <p className="mt-1 text-xs text-warning">{m.notice}</p> : null}
              {m.actions?.map((a) => (
                <Card key={a.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 p-2">
                  <span className="text-sm">{a.summary}</span>
                  {a.state ? (
                    <Badge variant={a.state === "executed" ? "success" : a.state === "failed" ? "danger" : "muted"}>{a.state === "executed" ? "Done" : a.state}</Badge>
                  ) : (
                    <span className="flex gap-1">
                      <Button size="sm" onClick={() => decide(i, a, true)}>
                        <Check /> Confirm
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => decide(i, a, false)}>
                        <X />
                      </Button>
                    </span>
                  )}
                </Card>
              ))}
            </div>
          </div>
        ))}
        {busy ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Checking…
          </div>
        ) : null}
        <div ref={bottom} />
      </div>
      <form
        className="sticky bottom-24 flex gap-2 md:bottom-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <Input className="h-12 shadow-sm" placeholder="Ask about food, meals or groceries" value={input} onChange={(e) => setInput(e.target.value)} />
        <Button type="submit" size="lg" disabled={busy || !input.trim()} aria-label="Send">
          <Send />
        </Button>
      </form>
    </div>
  );
}

export default function AssistantPage() {
  return (
    <Suspense>
      <AssistantView />
    </Suspense>
  );
}
