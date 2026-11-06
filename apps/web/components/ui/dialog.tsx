"use client";

import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

/** Modal that is a bottom sheet on phones and a centred dialog on larger screens. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <D.Content
          className={cn(
            "fixed z-50 flex max-h-[92dvh] w-full flex-col bg-card text-card-foreground shadow-xl",
            "inset-x-0 bottom-0 rounded-t-2xl",
            "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
            wide ? "sm:max-w-2xl" : "sm:max-w-lg",
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b p-4">
            <div>
              <D.Title className="text-lg font-semibold">{title}</D.Title>
              {description ? <D.Description className="mt-0.5 text-sm text-muted-foreground">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
              <X className="size-5" />
            </D.Close>
          </div>
          <div className="overflow-y-auto p-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t p-4 pb-safe">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
