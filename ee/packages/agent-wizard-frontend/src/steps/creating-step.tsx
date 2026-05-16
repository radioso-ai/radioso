"use client";

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface CreatingStepProps {
  error: string | null;
  onRetry: () => void;
}

export function CreatingStep({ error, onRetry }: CreatingStepProps) {
  if (error) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Couldn&apos;t create your assistant</h1>
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-5 w-5" />
        </div>
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Your assistant is ready</h1>
        <p className="text-sm text-muted-foreground">
          Opening your new assistant — we&apos;ll keep crawling the rest of your site in the background.
        </p>
      </div>
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Spinner />
        <span>Taking you there now</span>
      </div>
    </div>
  );
}
