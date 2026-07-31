/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_CREATION_HANDOFF_STORAGE_KEY } from "@/lib/agent-wizard/handoff";
import { wizardApi } from "@/lib/agent-wizard/api";
import { WizardShell } from "@/lib/agent-wizard/wizard-shell";
import type { WizardAnalysisResult, WizardCreateResult } from "@/lib/agent-wizard/types";

vi.mock("@/lib/agent-wizard/api", () => ({
  wizardApi: {
    analyzeWebsiteStream: vi.fn(),
    createFromWizard: vi.fn(),
  },
}));

const wizardApiMock = vi.mocked(wizardApi);

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const analysisResult: WizardAnalysisResult = {
  suggestedName: "Acme Helper",
  suggestedCustomInstruction: "Answer from Acme content.",
  suggestedGreetingMessage: "Hello from Acme.",
  suggestedLocale: "de",
  suggestedPrivacyPolicyUrl: "https://example.com/privacy",
  suggestedContactEmail: "support@example.com",
  suggestedChunkingStrategy: {
    strategy: "structured_semantic",
    reasoning: "The site has structured product and policy pages.",
  },
  screenshotBase64: null,
  screenshotUnavailableReason: null,
  faviconUrl: "https://example.com/favicon.ico",
  pagesAnalyzed: [
    { url: "https://example.com/", title: "Home" },
    { url: "https://example.com/privacy", title: "Privacy" },
  ],
  sourceUrl: "https://example.com/",
};

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

const waitFor = async (assertion: () => void) => {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }

  throw lastError;
};

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
};

const renderShell = () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<WizardShell agentSettingsHrefBuilder={(agentId) => `#/agents/${agentId}/identity`} />);
  });

  return { container, root };
};

const buttonByName = (name: RegExp): HTMLButtonElement => {
  const match = Array.from(document.querySelectorAll("button")).find((button) => name.test(button.textContent ?? ""));
  if (!match) {
    throw new Error(`Button not found: ${name}`);
  }
  return match;
};

const inputById = (id: string): HTMLInputElement => {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return input;
};

const textareaById = (id: string): HTMLTextAreaElement => {
  const textarea = document.getElementById(id);
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error(`Textarea not found: ${id}`);
  }
  return textarea;
};

const changeValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  act(() => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("agent wizard shell", () => {
  let mounted: { container: HTMLDivElement; root: Root } | null;

  beforeEach(() => {
    mounted = null;
    wizardApiMock.analyzeWebsiteStream.mockReset();
    wizardApiMock.createFromWizard.mockReset();
    window.sessionStorage.clear();
    window.location.hash = "";
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted?.root.unmount();
      });
      mounted.container.remove();
    }
    vi.clearAllMocks();
  });

  it("moves from analysis to review, then creates with reviewed settings", async () => {
    wizardApiMock.analyzeWebsiteStream.mockResolvedValue(analysisResult);
    wizardApiMock.createFromWizard.mockResolvedValue({ agentId: "agent-1", crawlJobId: null });
    mounted = renderShell();

    changeValue(inputById("website-url"), "example.com");
    act(() => {
      buttonByName(/Analyze website/i).click();
    });

    await waitFor(() => {
      expect(wizardApiMock.createFromWizard).not.toHaveBeenCalled();
      expect(inputById("wizard-review-name").value).toBe("Acme Helper");
    });

    changeValue(inputById("wizard-review-name"), "Acme Support");
    changeValue(textareaById("wizard-review-greeting"), "Welcome to Acme.");
    changeValue(inputById("wizard-review-privacy-policy"), "https://example.com/legal/privacy");

    act(() => {
      buttonByName(/Create assistant/i).click();
    });

    await waitFor(() => {
      expect(wizardApiMock.createFromWizard).toHaveBeenCalledWith({
        websiteUrl: "https://example.com/",
        name: "Acme Support",
        customInstruction: "Answer from Acme content.",
        greetingInstruction: "Welcome to Acme.",
        chunkingStrategy: "structured_semantic",
        faviconUrl: "https://example.com/favicon.ico",
        assistantDefaultLocale: "de",
        privacyPolicyUrl: "https://example.com/legal/privacy",
        contactEmail: "support@example.com",
      });
      expect(window.location.hash).toBe("#/agents/agent-1/identity");
    });

    const handoff = JSON.parse(window.sessionStorage.getItem(AGENT_CREATION_HANDOFF_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(handoff.detectedLocale).toBe("de");
    expect(handoff.detectedPrivacyPolicyUrl).toBe("https://example.com/legal/privacy");
  });

  it("aborts in-flight analysis when cancelled", async () => {
    const deferred = createDeferred<WizardAnalysisResult>();
    let capturedSignal: AbortSignal | undefined;
    wizardApiMock.analyzeWebsiteStream.mockImplementation((_url, input) => {
      capturedSignal = input?.signal;
      return deferred.promise;
    });
    mounted = renderShell();

    changeValue(inputById("website-url"), "example.com");
    act(() => {
      buttonByName(/Analyze website/i).click();
    });

    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });

    act(() => {
      buttonByName(/Cancel/i).click();
    });

    expect(capturedSignal?.aborted).toBe(true);

    await act(async () => {
      deferred.resolve(analysisResult);
      await flush();
    });

    expect(wizardApiMock.createFromWizard).not.toHaveBeenCalled();
  });

  it("suppresses redirect when unmounted during create", async () => {
    const createDeferredResult = createDeferred<WizardCreateResult>();
    wizardApiMock.analyzeWebsiteStream.mockResolvedValue(analysisResult);
    wizardApiMock.createFromWizard.mockReturnValue(createDeferredResult.promise);
    mounted = renderShell();

    changeValue(inputById("website-url"), "example.com");
    act(() => {
      buttonByName(/Analyze website/i).click();
    });

    await waitFor(() => {
      expect(inputById("wizard-review-name").value).toBe("Acme Helper");
    });

    act(() => {
      buttonByName(/Create assistant/i).click();
    });

    await waitFor(() => {
      expect(wizardApiMock.createFromWizard).toHaveBeenCalled();
    });

    act(() => {
      mounted?.root.unmount();
    });
    mounted.container.remove();
    mounted = null;

    await act(async () => {
      createDeferredResult.resolve({ agentId: "agent-2", crawlJobId: null });
      await flush();
    });

    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem(AGENT_CREATION_HANDOFF_STORAGE_KEY)).toBeNull();
  });
});
