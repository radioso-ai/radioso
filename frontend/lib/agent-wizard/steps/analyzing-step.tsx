"use client";

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import type { WizardProgressEvent } from "../types";

interface AnalyzingStepProps {
  url: string;
  error: string | null;
  progressEvents: WizardProgressEvent[];
  onCancel: () => void;
  onRetry: () => void;
}

const getProgressPercent = (events: WizardProgressEvent[]): number => {
  const latest = events.at(-1);
  if (!latest) return 8;
  if (latest.step === "complete") return 100;
  if (latest.step === "generating") return 86;
  if (latest.step === "analyzing") return 72;
  if (latest.step === "crawling" && latest.page && latest.total) {
    return Math.max(12, Math.min(68, Math.round((latest.page / latest.total) * 68)));
  }
  return 16;
};

const getCurrentLabel = (events: WizardProgressEvent[]): string => {
  const latest = events.at(-1);
  if (!latest) return "Getting started";
  if (latest.step === "crawling") return "Reading your website";
  if (latest.step === "analyzing") return "Understanding your content";
  if (latest.step === "generating") return "Crafting your assistant";
  return "Almost ready";
};

const getCrawledPages = (events: WizardProgressEvent[]) => {
  const seen = new Set<string>();
  return events
    .filter((event) => event.step === "crawling" && event.url)
    .filter((event) => {
      const key = event.url ?? "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

export function AnalyzingStep({ url, error, progressEvents, onCancel, onRetry }: AnalyzingStepProps) {
  const [pagesOpen, setPagesOpen] = useState(false);
  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">Analysis failed</h2>
        <p className="text-sm text-destructive">{error}</p>
        <p className="text-sm text-muted-foreground">
          Could not analyze <span className="font-medium">{url}</span>. This may be because the site is not publicly accessible or the request timed out.
        </p>
        <button
          type="button"
          className="text-sm font-medium text-primary underline"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }

  const progressPercent = getProgressPercent(progressEvents);
  const crawledPages = getCrawledPages(progressEvents);

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Setting up your assistant
        </h1>
        <p className="text-sm text-muted-foreground">
          Working with <span className="font-medium text-foreground">{url}</span>. This usually takes 15-30 seconds.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-muted/20 px-4 py-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Spinner />
            <p className="text-sm font-medium">{getCurrentLabel(progressEvents)}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        </div>

        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">{progressPercent}% complete</p>
        </div>

        {crawledPages.length > 0 ? (
          <Collapsible open={pagesOpen} onOpenChange={setPagesOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left">
              <p className="text-xs text-muted-foreground">
                {crawledPages.length} {crawledPages.length === 1 ? "page" : "pages"} crawled
              </p>
              <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${pagesOpen ? "rotate-180" : ""}`} />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
                {crawledPages.map((page, index) => (
                  <div key={`${page.url}-${index}`} className="rounded-md border border-border bg-background px-3 py-2">
                    <p className="truncate text-sm font-medium">{page.title || "Untitled page"}</p>
                    <p className="truncate text-xs text-muted-foreground">{page.url}</p>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </div>
  );
}
