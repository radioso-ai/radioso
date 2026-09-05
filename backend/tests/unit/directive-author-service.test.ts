import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  DirectiveAuthorService,
  type DirectiveAuthorTextGenerationPort,
} from "../../src/modules/agents/services/directiveAuthorService.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const validDraft = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  directive: {
    name: "answer-more-directly",
    condition: { kind: "contextual", description: "When the user asks for a direct operational answer." },
    action: "Give the practical answer first, then add caveats only when they change the decision.",
    tags: ["routine:triage"],
  },
  diagnosis: "directive_recommended",
  rationale: "The issue is reusable answer behavior.",
  ...overrides,
});

class FakeTextClient implements DirectiveAuthorTextGenerationPort {
  readonly calls: Parameters<DirectiveAuthorTextGenerationPort["complete"]>[0][] = [];

  constructor(private readonly responses: string[]) {}

  async complete(input: Parameters<DirectiveAuthorTextGenerationPort["complete"]>[0]): Promise<string> {
    this.calls.push(input);
    return this.responses.shift() ?? "";
  }
}

const createRepository = () => ({
  findByIdAndWorkspaceId: vi.fn().mockResolvedValue({
    id: agentId,
    name: "Coachable assistant",
    customInstruction: "Help operators explain booking policies.",
    greetingInstruction: "Welcome visitors warmly.",
  }),
});

const createService = (textGenerationClient: FakeTextClient) => {
  const repository = createRepository();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const telemetryService = {
    emit: vi.fn().mockResolvedValue(null),
  };
  const service = new DirectiveAuthorService({
    repository,
    textGenerationClient,
    logger: logger as never,
    telemetryService: telemetryService,
    buildStepScopeTag: (routineId, stepId) => `step:${routineId}:${stepId}`,
  });
  return { service, repository, logger, telemetryService };
};

const draftInput = (
  overrides: Partial<Omit<Parameters<DirectiveAuthorService["draft"]>[2], "turn">> & {
    turn?: Partial<Parameters<DirectiveAuthorService["draft"]>[2]["turn"]>;
  } = {},
) => ({
  coachingText: "The assistant should answer the practical question before explaining background.",
  turn: {
    userMessage: "Can I reschedule today?",
    assistantAnswer: "Here is a long explanation of our philosophy.",
    ...overrides.turn,
  },
});

describe("DirectiveAuthorService", () => {
  it("parses a valid directive draft from the LLM response", async () => {
    const textGenerationClient = new FakeTextClient([validDraft()]);
    const { service, repository, telemetryService } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, draftInput());

    expect(repository.findByIdAndWorkspaceId).toHaveBeenCalledWith(agentId, workspaceId);
    expect(textGenerationClient.calls).toHaveLength(1);
    expect(textGenerationClient.calls[0]?.prompt).toContain("Coachable assistant");
    expect(textGenerationClient.calls[0]?.operation).toMatchObject({
      workspaceId,
      agentId,
      surface: "agents",
      operation: "draft_directive",
      attemptKey: "primary",
    });
    expect(result.directive).toMatchObject({
      name: "answer-more-directly",
      condition: { kind: "contextual" },
      action: expect.stringContaining("practical answer"),
      tags: ["routine:triage"],
    });
    expect(result.diagnosis).toBe("directive_recommended");
    expect(telemetryService.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agents.directive_author.llm_call",
      tags: expect.objectContaining({ status: "success", diagnosis: "directive_recommended" }),
      metrics: expect.objectContaining({ durationMs: expect.any(Number) }),
    }));
  });

  it("defaults an unscoped draft to the active step tag when step context is present", async () => {
    const textGenerationClient = new FakeTextClient([validDraft({
      directive: {
        name: "confirm-before-submit",
        condition: { kind: "always" },
        action: "Confirm the collected details before moving to submission.",
      },
    })]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, draftInput({
      turn: {
        activeRoutineId: "contact",
        activeStepId: "ask_email",
      },
    }));

    expect(result.directive.tags).toEqual(["step:contact:ask_email"]);
  });

  it("keeps an explicit empty tag list global when step context is present", async () => {
    const textGenerationClient = new FakeTextClient([validDraft({
      directive: {
        name: "global-answer-style",
        condition: { kind: "always" },
        action: "Use the requested answer style for all routine steps.",
        tags: [],
      },
    })]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, draftInput({
      turn: {
        activeRoutineId: "contact",
        activeStepId: "ask_email",
      },
    }));

    expect(result.directive.tags).toEqual([]);
  });

  it("keeps and deduplicates explicit tags", async () => {
    const textGenerationClient = new FakeTextClient([validDraft({
      directive: {
        name: "step-answer-style",
        condition: { kind: "always" },
        action: "Use the requested answer style for this step.",
        tags: ["step:contact:ask_email", "step:contact:ask_email", "routine:contact"],
      },
    })]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, draftInput({
      turn: {
        activeRoutineId: "contact",
        activeStepId: "ask_email",
      },
    }));

    expect(result.directive.tags).toEqual(["step:contact:ask_email", "routine:contact"]);
  });

  it("defaults an unscoped draft to global tags without step context", async () => {
    const textGenerationClient = new FakeTextClient([validDraft({
      directive: {
        name: "brief-clarification",
        condition: { kind: "always" },
        action: "Ask one clarifying question when the requested outcome is ambiguous.",
      },
    })]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, draftInput());

    expect(result.directive.tags).toEqual([]);
  });

  it("carries an authored generation surface scope onto the draft", async () => {
    const draft = JSON.stringify({
      directive: {
        name: "no-price-suggestions",
        condition: { kind: "always" },
        action: "Never suggest a follow-up question about price.",
        tags: [],
        surfaces: ["suggested_questions"],
      },
      diagnosis: "directive_recommended",
    });
    const { service } = createService(new FakeTextClient([draft]));

    const result = await service.draft(workspaceId, agentId, draftInput());

    expect(result.directive.surfaces).toEqual(["suggested_questions"]);
  });

  it("leaves the scope absent when the draft names no surface", async () => {
    const { service } = createService(new FakeTextClient([validDraft()]));

    const result = await service.draft(workspaceId, agentId, draftInput());

    expect(result.directive.surfaces).toBeUndefined();
  });

  it("rejects a drafted surface outside the vocabulary", async () => {
    const draft = JSON.stringify({
      directive: {
        name: "bad-scope",
        condition: { kind: "always" },
        action: "Do a thing.",
        tags: [],
        surfaces: ["greeting"],
      },
      diagnosis: "directive_recommended",
    });
    const { service } = createService(new FakeTextClient([draft, draft]));

    await expect(service.draft(workspaceId, agentId, draftInput())).rejects.toThrow();
  });

  it("retries malformed model output once and returns the retried draft", async () => {
    const textGenerationClient = new FakeTextClient([
      "not json",
      validDraft({
        directive: {
          name: "retry-success",
          condition: { kind: "always" },
          action: "State the operational answer before optional context.",
          tags: [],
        },
      }),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, draftInput());

    expect(textGenerationClient.calls).toHaveLength(2);
    expect(textGenerationClient.calls[1]?.operation.attemptKey).toBe("json_retry");
    expect(result.directive.name).toBe("retry-success");
  });

  it("surfaces malformed model output as a sanitized 422-style error after retry", async () => {
    const rawCompletion = `bad completion ${randomUUID()}`;
    const textGenerationClient = new FakeTextClient(["not json", rawCompletion]);
    const { service } = createService(textGenerationClient);

    const error = await service.draft(workspaceId, agentId, draftInput()).catch((caught: unknown) => caught);

    expect(textGenerationClient.calls).toHaveLength(2);
    expect(error).toMatchObject({
      statusCode: 422,
      code: "invalid_directive_draft",
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(rawCompletion);
  });
});
