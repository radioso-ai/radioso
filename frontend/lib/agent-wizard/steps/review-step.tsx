"use client";

import { useState } from "react";
import { ArrowRight, FileText, Languages, Link as LinkIcon, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { WizardAnalysisResult } from "../types";

interface ReviewStepProps {
  result: WizardAnalysisResult;
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    greetingInstruction: string;
    privacyPolicyUrl: string | null;
  }) => void;
}

const getChunkingLabel = (strategy: WizardAnalysisResult["suggestedChunkingStrategy"]["strategy"]): string => {
  if (strategy === "structured_semantic") {
    return "Structured semantic";
  }
  return "Fixed window";
};

const normalizeOptionalUrl = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export function ReviewStep({ result, onCancel, onCreate }: ReviewStepProps) {
  const [name, setName] = useState(result.suggestedName);
  const [greetingInstruction, setGreetingInstruction] = useState(result.suggestedGreetingMessage);
  const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState(result.suggestedPrivacyPolicyUrl ?? "");

  const canCreate = name.trim().length > 0 && greetingInstruction.trim().length > 0;

  return (
    <div className="space-y-8">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Review your assistant</h1>
        <p className="text-sm text-muted-foreground">
          Confirm the settings detected from <span className="font-medium text-foreground">{result.sourceUrl}</span>.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Languages className="h-4 w-4 text-muted-foreground" />
            Language
          </div>
          <p className="text-sm text-muted-foreground">{result.suggestedLocale ?? "Not detected"}</p>
        </div>
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Pages analyzed
          </div>
          <p className="text-sm text-muted-foreground">{result.pagesAnalyzed.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <MessageCircle className="h-4 w-4 text-muted-foreground" />
            Chunking
          </div>
          <p className="text-sm text-muted-foreground">{getChunkingLabel(result.suggestedChunkingStrategy.strategy)}</p>
        </div>
      </div>

      <div className="space-y-5 rounded-lg border border-border bg-muted/20 p-4">
        <div className="space-y-2">
          <Label htmlFor="wizard-review-name">Assistant name</Label>
          <Input
            id="wizard-review-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="wizard-review-greeting">Greeting</Label>
          <Textarea
            id="wizard-review-greeting"
            value={greetingInstruction}
            onChange={(event) => setGreetingInstruction(event.target.value)}
            rows={4}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="wizard-review-privacy-policy">Privacy policy URL</Label>
          <div className="relative">
            <LinkIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="wizard-review-privacy-policy"
              value={privacyPolicyUrl}
              onChange={(event) => setPrivacyPolicyUrl(event.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <div className="rounded-md bg-background px-3 py-2 text-sm text-muted-foreground">
          {result.suggestedChunkingStrategy.reasoning}
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!canCreate}
          onClick={() => onCreate({
            name: name.trim(),
            greetingInstruction: greetingInstruction.trim(),
            privacyPolicyUrl: normalizeOptionalUrl(privacyPolicyUrl),
          })}
        >
          Create assistant
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
