import { describe, expect, it, vi, beforeEach } from "vitest";

import { detectTurnResponseLanguage } from "../../../src/modules/chat/services/turnResponseLanguage.js";
import type { ResponseLanguageDetector } from "../../../src/shared/services/responseLanguageDetector.js";
import { setTraceAttributes } from "../../../src/shared/observability/tracing/operations.js";

vi.mock("../../../src/shared/observability/tracing/operations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/shared/observability/tracing/operations.js")>();
  return { ...actual, setTraceAttributes: vi.fn() };
});

const visitorMessage = "No aspetta, arrivo il 15 novembre, non il 14.";
const request = {
  query: visitorMessage,
  history: [],
  workspaceContext: { workspaceId: "workspace-1" },
};
const logContext = { workspaceId: "workspace-1", conversationId: "conversation-1" };

const detectorReturning = (
  result: Awaited<ReturnType<ResponseLanguageDetector["detect"]>>,
): ResponseLanguageDetector => ({ detect: vi.fn(async () => result) });

const loggedPayloads = (logger: { warn: ReturnType<typeof vi.fn> }): string =>
  JSON.stringify(logger.warn.mock.calls);

describe("detectTurnResponseLanguage", () => {
  beforeEach(() => {
    vi.mocked(setTraceAttributes).mockClear();
  });

  it("returns the detected label and records it on the turn span", async () => {
    const logger = { warn: vi.fn() };

    const language = await detectTurnResponseLanguage({
      detector: detectorReturning({ responseLanguage: "Italian" }),
      request,
      logContext,
      logger,
    });

    expect(language).toBe("Italian");
    expect(setTraceAttributes).toHaveBeenCalledWith({
      "chat.response.language": "Italian",
      "chat.response.language.source": "detector",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // Routine handoff endings, routine step replies, and answers all fall back to the
  // latest user message when this resolves to undefined — that path must be visible.
  it("logs and traces a failed detection instead of silently dropping the language", async () => {
    const logger = { warn: vi.fn() };
    const detector: ResponseLanguageDetector = {
      detect: vi.fn(async () => {
        throw new TypeError(`provider rejected ${visitorMessage}`);
      }),
    };

    const language = await detectTurnResponseLanguage({ detector, request, logContext, logger });

    expect(language).toBeUndefined();
    expect(setTraceAttributes).toHaveBeenCalledWith({
      "chat.response.language.source": "detector",
      "chat.response.language.unresolved_reason": "detector_failed",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        reasonCode: "response_language_unresolved",
        unresolvedReason: "detector_failed",
        errorType: "TypeError",
      },
      expect.any(String),
    );
    // No visitor text, prompt, or error message reaches the log.
    expect(loggedPayloads(logger)).not.toContain("aspetta");
  });

  it("logs a detector output that breaks its contract", async () => {
    const logger = { warn: vi.fn() };

    const language = await detectTurnResponseLanguage({
      detector: detectorReturning({ unresolvedReason: "unparseable_output" }),
      request,
      logContext,
      logger,
    });

    expect(language).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "response_language_unresolved", unresolvedReason: "unparseable_output" }),
      expect.any(String),
    );
  });

  it("traces an honest no-label outcome without a warning", async () => {
    const logger = { warn: vi.fn() };

    const language = await detectTurnResponseLanguage({
      detector: detectorReturning({ unresolvedReason: "no_label" }),
      request,
      logContext,
      logger,
    });

    expect(language).toBeUndefined();
    expect(setTraceAttributes).toHaveBeenCalledWith({
      "chat.response.language.source": "detector",
      "chat.response.language.unresolved_reason": "no_label",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resolves to undefined when no detector is wired", async () => {
    await expect(detectTurnResponseLanguage({ detector: undefined, request, logContext })).resolves.toBeUndefined();
    expect(setTraceAttributes).not.toHaveBeenCalled();
  });
});
