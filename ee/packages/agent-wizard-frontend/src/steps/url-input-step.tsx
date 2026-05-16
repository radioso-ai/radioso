"use client";

import { useState } from "react";
import { ArrowRight, Globe, MessageCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface UrlInputStepProps {
  onSubmit: (url: string) => void;
}

const HOW_IT_WORKS = [
  {
    icon: Globe,
    title: "We read your website",
    description: "We crawl your homepage and key pages to understand what you do.",
  },
  {
    icon: Sparkles,
    title: "AI configures your assistant",
    description: "Name, tone, and instructions are tailored to your content.",
  },
  {
    icon: MessageCircle,
    title: "Start chatting",
    description: "Your assistant is ready to answer questions in minutes.",
  },
];

const normalizeUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    if (!parsed.protocol.startsWith("http")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

export function UrlInputStep({ onSubmit }: UrlInputStepProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError("Please enter a valid URL (e.g. acme.com)");
      return;
    }
    setError(null);
    onSubmit(normalized);
  };

  return (
    <div className="space-y-10">
      <div className="space-y-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Let&apos;s build your AI assistant
        </h1>
        <p className="mx-auto max-w-[520px] text-base text-muted-foreground">
          Tell us about your business and we&apos;ll create a working assistant in under a minute — no configuration required.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Globe className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="website-url"
              placeholder="acme.com"
              value={url}
              autoFocus
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleSubmit();
                }
              }}
              className="h-11 pl-9 text-base"
            />
          </div>
          <Button onClick={handleSubmit} disabled={!url.trim()} size="lg">
            Analyze website
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Enter the URL where your customers find you. We&apos;ll only read public pages.
          </p>
        )}
      </div>

      <div className="space-y-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          How it works
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {HOW_IT_WORKS.map((step, index) => {
            const Icon = step.icon;
            return (
              <div
                key={step.title}
                className="rounded-lg border border-border bg-background p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="h-4 w-4" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">
                    Step {index + 1}
                  </span>
                </div>
                <p className="text-sm font-medium leading-snug">{step.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Don&apos;t have a website?</span>{" "}
        <a
          href="../"
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Go back
        </a>{" "}
        and create your assistant manually — you can upload documents instead.
      </div>
    </div>
  );
}
