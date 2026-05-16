"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_CREATION_HANDOFF_STORAGE_KEY } from "@/lib/agent-creation-handoff";
import { wizardApi } from "./api.js";
import type { WizardProgressEvent, WizardStep } from "./types.js";
import { UrlInputStep } from "./steps/url-input-step.js";
import { AnalyzingStep } from "./steps/analyzing-step.js";
import { CreatingStep } from "./steps/creating-step.js";

const extractErrorMessage = (err: unknown): string | null => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
      const inner = record.error as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
    }
    if (typeof record.message === "string") return record.message;
  }
  if (typeof err === "string") return err;
  return null;
};

interface WizardShellProps {
  agentSettingsHrefBuilder: (agentId: string) => string;
}

export function WizardShell({ agentSettingsHrefBuilder }: WizardShellProps) {
  const [step, setStep] = useState<WizardStep>("url-input");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progressEvents, setProgressEvents] = useState<WizardProgressEvent[]>([]);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const progressEventsRef = useRef<WizardProgressEvent[]>([]);

  // Abort any in-flight analysis when the shell unmounts (which happens
  // when the dialog is closed via Esc, backdrop, or the X button). Without
  // this, the pending promise can still resolve, call createFromWizard,
  // and redirect the page to an agent the user dismissed.
  useEffect(() => {
    return () => {
      analysisAbortRef.current?.abort();
      analysisAbortRef.current = null;
    };
  }, []);

  const handleUrlSubmit = useCallback(async (submittedUrl: string) => {
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setUrl(submittedUrl);
    setStep("analyzing");
    setError(null);
    setProgressEvents([]);
    progressEventsRef.current = [];
    let failureStep: WizardStep = "analyzing";
    try {
      const result = await wizardApi.analyzeWebsiteStream(submittedUrl, {
        signal: controller.signal,
        onProgress: (event) => {
          progressEventsRef.current = [...progressEventsRef.current, event];
          setProgressEvents((current) => [...current, event]);
        },
      });
      // Guard against the dialog being closed while analyzeWebsiteStream
      // was in flight — don't create an agent the user abandoned.
      if (controller.signal.aborted) {
        return;
      }
      setStep("creating");
      failureStep = "creating";
      // Re-check just before the network call: abort can fire after
      // setStep but before fetch is dispatched (microtask scheduling),
      // and there's no signal threaded into createFromWizard yet.
      if (controller.signal.aborted) {
        return;
      }
      const createResult = await wizardApi.createFromWizard({
        websiteUrl: submittedUrl,
        name: result.suggestedName,
        customInstruction: result.suggestedCustomInstruction,
        greetingInstruction: result.suggestedGreetingMessage,
        chunkingStrategy: result.suggestedChunkingStrategy.strategy,
        faviconUrl: result.faviconUrl,
      });
      // Same guard for createFromWizard — if the user closed the dialog
      // mid-create, the agent gets created server-side but we skip the
      // navigation rather than yanking them somewhere they didn't ask for.
      if (controller.signal.aborted) {
        return;
      }
      window.sessionStorage.setItem(AGENT_CREATION_HANDOFF_STORAGE_KEY, JSON.stringify({
        agentId: createResult.agentId,
        title: "Website analysis complete",
        description: `Created from ${submittedUrl}. Review the pre-filled identity settings below.`,
        items: result.pagesAnalyzed,
        createdAt: Date.now(),
      }));
      window.location.href = agentSettingsHrefBuilder(createResult.agentId);
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      const message = extractErrorMessage(err) ?? (failureStep === "creating" ? "Failed to create assistant" : "Analysis failed");
      setError(message);
      setStep(failureStep);
    } finally {
      if (analysisAbortRef.current === controller) {
        analysisAbortRef.current = null;
      }
    }
  }, [agentSettingsHrefBuilder]);

  const handleCancelAnalysis = useCallback(() => {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setProgressEvents([]);
    progressEventsRef.current = [];
    setError(null);
    setStep("url-input");
  }, []);

  const handleRetryAnalysis = useCallback(() => {
    if (url) {
      void handleUrlSubmit(url);
    } else {
      setStep("url-input");
    }
  }, [url, handleUrlSubmit]);

  return (
    <div className="mx-auto w-full max-w-[720px] py-16">
      {step === "url-input" ? (
        <UrlInputStep onSubmit={(u) => void handleUrlSubmit(u)} />
      ) : null}

      {step === "analyzing" ? (
        <AnalyzingStep
          url={url}
          error={error}
          progressEvents={progressEvents}
          onCancel={handleCancelAnalysis}
          onRetry={handleRetryAnalysis}
        />
      ) : null}

      {step === "creating" ? (
        <CreatingStep
          error={error}
          onRetry={handleRetryAnalysis}
        />
      ) : null}
    </div>
  );
}
