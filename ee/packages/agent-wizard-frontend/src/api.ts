import {
  API_BASE,
  buildError,
  getStoredActiveWorkspaceId,
  request,
} from "@/lib/api-client";
import type {
  WizardAnalysisResult,
  WizardCreateInput,
  WizardCreateResult,
  WizardInstructionSuggestion,
  WizardProgressEvent,
} from "./types.js";

const parseSseBlock = (block: string): { event: string; data: string } | null => {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { event, data: data.join("\n") };
};

export const wizardApi = {
  analyzeWebsite(url: string): Promise<WizardAnalysisResult> {
    return request<WizardAnalysisResult>("/ee/agent-wizard/analyze-website", {
      method: "POST",
      body: JSON.stringify({ url }),
    }, { withSession: true });
  },

  async analyzeWebsiteStream(
    url: string,
    input: {
      signal?: AbortSignal;
      onProgress?: (event: WizardProgressEvent) => void;
    } = {},
  ): Promise<WizardAnalysisResult> {
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-Forwarded-Prefix": "/backend",
    });
    const workspaceId = getStoredActiveWorkspaceId();
    if (workspaceId) {
      headers.set("X-Workspace-Id", workspaceId);
    }

    const response = await fetch(`${API_BASE}/ee/agent-wizard/analyze-website/stream`, {
      method: "POST",
      body: JSON.stringify({ url }),
      cache: "no-store",
      credentials: "include",
      headers,
      signal: input.signal,
    });

    if (!response.ok) {
      throw await buildError(response);
    }
    if (!response.body) {
      throw {
        error: {
          code: "stream_unavailable",
          message: "Analysis stream was unavailable.",
        },
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        const payload = JSON.parse(parsed.data) as unknown;
        if (parsed.event === "progress") {
          input.onProgress?.(payload as WizardProgressEvent);
        } else if (parsed.event === "complete") {
          return payload as WizardAnalysisResult;
        } else if (parsed.event === "error") {
          const errorPayload = payload as { code?: string; message?: string };
          throw {
            error: {
              code: errorPayload.code ?? "analysis_failed",
              message: errorPayload.message ?? "Website analysis failed",
            },
          };
        }
      }

      if (done) break;
    }

    throw {
      error: {
        code: "stream_incomplete",
        message: "Analysis stream ended before returning a result.",
      },
    };
  },

  regenerateInstructions(analysisRunId: string): Promise<WizardInstructionSuggestion> {
    return request<WizardInstructionSuggestion>("/ee/agent-wizard/regenerate-instructions", {
      method: "POST",
      body: JSON.stringify({ analysisRunId }),
    }, { withSession: true });
  },

  createFromWizard(input: WizardCreateInput): Promise<WizardCreateResult> {
    return request<WizardCreateResult>("/ee/agent-wizard/create", {
      method: "POST",
      body: JSON.stringify(input),
    }, { withSession: true });
  },
};
