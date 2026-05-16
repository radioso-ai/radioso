"use client";

import { useEffect, useState } from "react";
import { Bot, ChevronDown, RefreshCw } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { WizardAnalysisResult } from "../types.js";

interface ReviewStepProps {
  analysis: WizardAnalysisResult;
  onSubmit: (edited: {
    name: string;
    customInstruction: string;
    greetingInstruction: string;
    faviconUrl: string | null;
  }) => void;
  onBack: () => void;
  onRegenerate: () => Promise<void>;
}

export function ReviewStep({ analysis, onSubmit, onBack, onRegenerate }: ReviewStepProps) {
  const [name, setName] = useState(analysis.suggestedName);
  const [customInstruction, setCustomInstruction] = useState(analysis.suggestedCustomInstruction);
  const [greetingInstruction, setGreetingInstruction] = useState(analysis.suggestedGreetingMessage);
  const [useFavicon, setUseFavicon] = useState(Boolean(analysis.faviconUrl));
  const [pagesOpen, setPagesOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  useEffect(() => {
    setName(analysis.suggestedName);
    setCustomInstruction(analysis.suggestedCustomInstruction);
    setGreetingInstruction(analysis.suggestedGreetingMessage);
    setUseFavicon(Boolean(analysis.faviconUrl));
  }, [analysis]);

  const handleSubmit = () => {
    onSubmit({
      name: name.trim(),
      customInstruction: customInstruction.trim(),
      greetingInstruction: greetingInstruction.trim(),
      faviconUrl: useFavicon ? analysis.faviconUrl : null,
    });
  };

  const handleRegenerate = async () => {
    setIsRegenerating(true);
    setRegenerateError(null);
    try {
      await onRegenerate();
    } catch (err) {
      setRegenerateError(err instanceof Error ? err.message : "Could not regenerate instructions");
    } finally {
      setIsRegenerating(false);
    }
  };

  const avatarUrl = useFavicon ? analysis.faviconUrl : null;
  const analyzedPages = analysis.pagesAnalyzed.filter((page, index, pages) =>
    pages.findIndex((candidate) => candidate.url === page.url) === index
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-medium">Review assistant configuration</h2>
        <p className="text-sm text-muted-foreground">
          We analyzed {analysis.pagesAnalyzed.length} pages from{" "}
          <span className="font-medium">{analysis.sourceUrl}</span>.
          Review and edit the suggestions below.
        </p>
      </div>

      {analysis.faviconUrl ? (
        <div className="flex items-center gap-3">
          <Avatar className="h-11 w-11 rounded-lg border border-border">
            <AvatarImage src={analysis.faviconUrl} alt="Website icon" className="object-contain p-1" />
            <AvatarFallback className="rounded-lg">
              <Bot className="h-5 w-5" />
            </AvatarFallback>
          </Avatar>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useFavicon}
              onChange={(e) => setUseFavicon(e.target.checked)}
              className="rounded"
            />
            Use as assistant avatar
          </label>
        </div>
      ) : null}

      {analysis.screenshotUnavailableReason ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Website screenshot preview is unavailable in this environment. The assistant can still be created from the crawled page content.
        </p>
      ) : null}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="agent-name">Assistant name</Label>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Assistant"
          />
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="custom-instruction">Instructions</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleRegenerate()}
              disabled={isRegenerating}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${isRegenerating ? "animate-spin" : ""}`} />
              Regenerate
            </Button>
          </div>
          <Textarea
            id="custom-instruction"
            value={customInstruction}
            onChange={(e) => setCustomInstruction(e.target.value)}
            rows={4}
            placeholder="Describe how the assistant should behave..."
          />
          <p className="text-xs text-muted-foreground">
            {customInstruction.length}/2000 characters
          </p>
          {regenerateError ? <p className="text-xs text-destructive">{regenerateError}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="greeting">Greeting message</Label>
          <Input
            id="greeting"
            value={greetingInstruction}
            onChange={(e) => setGreetingInstruction(e.target.value)}
            placeholder="Hi! How can I help you?"
          />
        </div>
      </div>

      <Collapsible open={pagesOpen} onOpenChange={setPagesOpen} className="rounded-lg border border-border">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium">
          Pages analyzed
          <ChevronDown className={`h-4 w-4 transition-transform ${pagesOpen ? "rotate-180" : ""}`} />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border px-4 py-3">
          <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
            {analyzedPages.map((page, index) => (
              <div key={`${page.url}-${index}`} className="rounded-md bg-muted/30 px-3 py-2">
                <p className="truncate text-sm font-medium">{page.title || "Untitled page"}</p>
                <p className="truncate text-xs text-muted-foreground">{page.url}</p>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={handleSubmit} disabled={!name.trim()}>
          Create assistant
        </Button>
      </div>
      </div>

      <aside className="space-y-3">
        <p className="text-sm font-medium">Widget preview</p>
        <div className="overflow-hidden rounded-lg border border-border bg-background shadow-sm">
          <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-3">
            <Avatar className="h-9 w-9 rounded-lg">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={name || "Assistant"} className="object-contain p-1" /> : null}
              <AvatarFallback className="rounded-lg">
                <Bot className="h-4 w-4" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{name || "Assistant"}</p>
              <p className="text-xs text-muted-foreground">Website assistant</p>
            </div>
          </div>
          <div className="space-y-3 px-4 py-4">
            <div className="rounded-lg rounded-tl-sm bg-muted px-3 py-2 text-sm">
              {greetingInstruction || "Hi! How can I help you?"}
            </div>
            <div className="ml-auto max-w-[82%] rounded-lg rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
              What can you help me with?
            </div>
            <div className="rounded-lg rounded-tl-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
              I can answer using the website pages analyzed for this assistant.
            </div>
          </div>
          <div className="border-t border-border px-4 py-3">
            <div className="h-9 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              Ask a question...
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
