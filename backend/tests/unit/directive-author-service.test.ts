import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  DirectiveAuthorService,
  projectDirectiveAuthorProposalInput,
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
    updatedAt: new Date("2026-09-26T10:00:00.000Z"),
  }),
  listDirectives: vi.fn().mockResolvedValue([]),
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

  it("keeps complete caller-supplied fields verbatim without calling the coach", async () => {
    const textGenerationClient = new FakeTextClient([]);
    const { service } = createService(textGenerationClient);
    const action = "Start with a blockquote. On the next line write `PS § 12 lg 1`; then write **Decision**.";

    const result = await service.draft(workspaceId, agentId, {
      fields: {
        name: "quote-primary-source",
        condition: { kind: "always" },
        action,
        priority: 85,
        excludes: ["represent-organization"],
      },
    });

    expect(textGenerationClient.calls).toEqual([]);
    expect(result.directive).toMatchObject({
      name: "quote-primary-source",
      condition: { kind: "always" },
      action,
      priority: 85,
      excludes: ["represent-organization"],
    });
  });

  it("overrides coached fields with caller-supplied fixed fields", async () => {
    const textGenerationClient = new FakeTextClient([validDraft({
      directive: {
        name: "coach-name",
        condition: { kind: "always" },
        action: "Coach wording that must not survive.",
        tags: [],
      },
    })]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      ...draftInput(),
      fields: { action: "Use this exact action, including **formatting**." },
    });

    expect(textGenerationClient.calls).toHaveLength(1);
    expect(textGenerationClient.calls[0]?.prompt).toContain("Use this exact action, including **formatting**.");
    expect(result.directive.action).toBe("Use this exact action, including **formatting**.");
  });

  it("preserves unspecified existing fields for a structured edit without calling the coach", async () => {
    const textGenerationClient = new FakeTextClient([]);
    const { service, repository } = createService(textGenerationClient);
    repository.listDirectives.mockResolvedValue([{
      id: "33333333-3333-4333-8333-333333333333",
      agentId,
      name: "existing-rule",
      condition: { kind: "always" },
      action: "Keep this action.",
      priority: 40,
      excludes: ["represent-organization"],
      tags: [],
      surfaces: [],
      requiredCapabilities: [],
      dependsOn: [],
      routes: [],
      description: null,
      binding: null,
      lifecycle: null,
      enabled: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);

    const result = await service.draft(workspaceId, agentId, {
      directiveId: "33333333-3333-4333-8333-333333333333",
      fields: { priority: 90 },
    });

    expect(textGenerationClient.calls).toEqual([]);
    expect(result.directive).toMatchObject({
      name: "existing-rule",
      action: "Keep this action.",
      priority: 90,
      excludes: ["represent-organization"],
    });
  });

  it("coaches an intent-only edit instead of returning the inherited directive unchanged", async () => {
    const textGenerationClient = new FakeTextClient([validDraft({
      directive: {
        name: "cite-sources-first",
        condition: { kind: "always" },
        action: "Require a source citation before explaining the answer.",
        tags: [],
      },
    })]);
    const { service, repository } = createService(textGenerationClient);
    repository.listDirectives.mockResolvedValue([{
      id: "33333333-3333-4333-8333-333333333333",
      agentId,
      name: "existing-rule",
      condition: { kind: "always" },
      action: "Keep this action.",
      priority: 40,
      excludes: [],
      tags: [],
      surfaces: [],
      requiredCapabilities: [],
      dependsOn: [],
      routes: [],
      description: null,
      binding: null,
      lifecycle: null,
      enabled: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);

    const result = await service.draftForProposal(workspaceId, agentId, {
      directiveId: "33333333-3333-4333-8333-333333333333",
      ...projectDirectiveAuthorProposalInput({ intent: "Require a source citation first." }),
    });

    expect(textGenerationClient.calls).toHaveLength(1);
    expect(result.draft.directive.action).toBe("Require a source citation before explaining the answer.");
  });

  it("returns an edit fence from the directive snapshot used to expand its payload", async () => {
    const textGenerationClient = new FakeTextClient([]);
    const { service, repository } = createService(textGenerationClient);
    const directiveUpdatedAt = new Date("2026-09-26T11:00:00.000Z");
    repository.listDirectives.mockResolvedValue([{
      id: "33333333-3333-4333-8333-333333333333",
      agentId,
      name: "existing-rule",
      condition: { kind: "always" },
      action: "Keep this action.",
      priority: 40,
      excludes: ["represent-organization"],
      tags: [],
      surfaces: [],
      requiredCapabilities: [],
      dependsOn: [],
      routes: [],
      description: null,
      binding: null,
      lifecycle: null,
      enabled: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: directiveUpdatedAt,
    }]);

    const result = await service.draftForProposal(workspaceId, agentId, {
      directiveId: "33333333-3333-4333-8333-333333333333",
      fields: { priority: 90 },
    });

    expect(result.versionToken).toBe(directiveUpdatedAt.toISOString());
    expect(result.draft.directive).toMatchObject({ action: "Keep this action.", priority: 90 });
    expect(textGenerationClient.calls).toEqual([]);
  });

  it("reports a create's fence as the same agent version draftForProposal captured", async () => {
    const textGenerationClient = new FakeTextClient([]);
    const { service, repository } = createService(textGenerationClient);
    const agentUpdatedAt = new Date("2026-09-26T10:00:00.000Z");
    repository.findByIdAndWorkspaceId.mockResolvedValue({
      id: agentId,
      name: "Coachable assistant",
      customInstruction: "Help operators explain booking policies.",
      greetingInstruction: "Welcome visitors warmly.",
      updatedAt: agentUpdatedAt,
    });

    const drafted = await service.draftForProposal(workspaceId, agentId, {
      fields: { name: "quote-primary-source", condition: { kind: "always" }, action: "Quote the source." },
    });
    const fence = await service.readProposalFence(workspaceId, agentId, null);

    expect(drafted.versionToken).toBe(agentUpdatedAt.toISOString());
    expect(fence).toBe(drafted.versionToken);
  });

  it("reports an edit's fence as the same directive version draftForProposal captured", async () => {
    const textGenerationClient = new FakeTextClient([]);
    const { service, repository } = createService(textGenerationClient);
    const directiveUpdatedAt = new Date("2026-09-26T11:00:00.000Z");
    const directiveId = "33333333-3333-4333-8333-333333333333";
    repository.listDirectives.mockResolvedValue([{
      id: directiveId,
      agentId,
      name: "existing-rule",
      condition: { kind: "always" },
      action: "Keep this action.",
      priority: 40,
      excludes: [],
      tags: [],
      surfaces: [],
      requiredCapabilities: [],
      dependsOn: [],
      routes: [],
      description: null,
      binding: null,
      lifecycle: null,
      enabled: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: directiveUpdatedAt,
    }]);

    const drafted = await service.draftForProposal(workspaceId, agentId, { directiveId, fields: { priority: 90 } });
    const fence = await service.readProposalFence(workspaceId, agentId, directiveId);

    expect(drafted.versionToken).toBe(directiveUpdatedAt.toISOString());
    expect(fence).toBe(drafted.versionToken);
  });

  it("refuses a fence read for a directive id that no longer exists", async () => {
    const { service } = createService(new FakeTextClient([]));

    await expect(service.readProposalFence(workspaceId, agentId, "99999999-9999-4999-8999-999999999999"))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses an unknown replacement and lists bounded valid names", async () => {
    const { service } = createService(new FakeTextClient([]));

    await expect(service.draft(workspaceId, agentId, {
      fields: {
        name: "quote-primary-source",
        condition: { kind: "always" },
        action: "Quote the governing source first.",
        excludes: ["not-a-directive"],
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("represent-organization"),
    });
  });

  it("refuses an incomplete new structured directive without intent", async () => {
    const { service } = createService(new FakeTextClient([]));

    await expect(service.draft(workspaceId, agentId, {
      fields: { name: "quote-primary-source" },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: "A directive without intent needs condition and action.",
    });
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
