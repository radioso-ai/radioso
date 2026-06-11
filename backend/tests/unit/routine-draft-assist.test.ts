import { describe, expect, it, vi } from "vitest";

import {
  RoutineDraftAssistService,
  type RoutineDraftAssistTextGenerationPort,
} from "../../src/modules/routines/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const validDraft = (overrides: Record<string, unknown> = {}) => ({
  name: "support-intake",
  activation: {
    triggerDescription: "The visitor asks for support with an order.",
    gateRef: null,
    priority: 10,
  },
  slots: [{
    stableSlotId: "slot_email",
    key: "email",
    type: "email",
    required: true,
    description: "Visitor email address",
    ordinal: 0,
  }],
  steps: [
    {
      stableStepId: "collect_email",
      kind: "chat",
      instruction: "Ask for {{slot.email}}.",
      toolRef: null,
      actionType: null,
      ordinal: 0,
      metadata: { outlineLabel: "Collect email" },
    },
    {
      stableStepId: "send_contact",
      kind: "action",
      instruction: "Send the support request.",
      toolRef: null,
      actionType: "contact.send",
      ordinal: 1,
      metadata: { outlineLabel: "Send request" },
    },
  ],
  transitions: [
    {
      fromStep: "collect_email",
      toRef: "send_contact",
      guardKind: "default",
      guardText: null,
      outcomeStatus: null,
      counterLimit: null,
      ordinal: 0,
    },
    {
      fromStep: "send_contact",
      toRef: "complete",
      guardKind: "default",
      guardText: null,
      outcomeStatus: null,
      counterLimit: null,
      ordinal: 1,
    },
  ],
  terminals: [{
    stableStepId: "complete",
    kind: "complete",
    instruction: "Confirm the request is open.",
    ordinal: 0,
  }],
  ...overrides,
});

const completion = (draft: unknown) => JSON.stringify({ draft });

class FakeTextClient implements RoutineDraftAssistTextGenerationPort {
  readonly calls: Parameters<RoutineDraftAssistTextGenerationPort["complete"]>[0][] = [];

  constructor(private readonly responses: string[]) {}

  async complete(input: Parameters<RoutineDraftAssistTextGenerationPort["complete"]>[0]): Promise<string> {
    this.calls.push(input);
    return this.responses.shift() ?? "";
  }
}

const createRepository = () => ({
  findByIdAndWorkspaceId: vi.fn().mockResolvedValue({
    id: agentId,
    name: "Support assistant",
    customInstruction: "Help visitors with order support.",
    greetingInstruction: "Welcome visitors warmly.",
  }),
});

const createService = (textGenerationClient: FakeTextClient, actionCatalog = [{ type: "contact.send", kind: "action" as const }]) => {
  const repository = createRepository();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const telemetryService = {
    emit: vi.fn().mockResolvedValue(null),
  };
  const service = new RoutineDraftAssistService({
    repository,
    textGenerationClient,
    actionCatalog,
    logger: logger as never,
    telemetryService: telemetryService as never,
  });
  return { service, repository, logger, telemetryService };
};

describe("RoutineDraftAssistService", () => {
  it("returns a schema-validated draft and existing validator result without persisting", async () => {
    const textGenerationClient = new FakeTextClient([completion(validDraft())]);
    const { service, repository, logger, telemetryService } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for the visitor email, send the contact request, then confirm.",
    });

    expect(repository.findByIdAndWorkspaceId).toHaveBeenCalledWith(agentId, workspaceId);
    expect(textGenerationClient.calls).toHaveLength(1);
    expect(textGenerationClient.calls[0]?.prompt).toContain("Support assistant");
    expect(textGenerationClient.calls[0]?.prompt).toContain("contact.send");
    expect(textGenerationClient.calls[0]?.operation).toMatchObject({
      workspaceId,
      surface: "agents",
      operation: "draft_routine",
      attemptKey: "primary",
    });
    expect(result.draft).toMatchObject({
      name: "support-intake",
      steps: [
        expect.objectContaining({ stableStepId: "collect_email", kind: "chat" }),
        expect.objectContaining({ stableStepId: "send_contact", kind: "action", actionType: "contact.send" }),
      ],
    });
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
    expect(logger.info).toHaveBeenCalledWith(
      expect.not.objectContaining({
        prose: expect.any(String),
        prompt: expect.any(String),
        completion: expect.any(String),
        draft: expect.anything(),
      }),
      expect.stringContaining("routine_draft_assist"),
    );
    expect(telemetryService.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "routines.draft_assist.llm_call",
      tags: expect.objectContaining({ status: "success", attempt_key: "primary" }),
    }));
  });

  it("retries once when the model response fails the draft schema", async () => {
    const textGenerationClient = new FakeTextClient([
      JSON.stringify({ draft: { name: "missing required fields" } }),
      completion(validDraft({ name: "retry-intake" })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Collect email and send contact request.",
    });

    expect(textGenerationClient.calls).toHaveLength(2);
    expect(textGenerationClient.calls[1]?.operation.attemptKey).toBe("schema_retry");
    expect(textGenerationClient.calls[1]?.prompt).toContain("Return valid JSON only");
    expect(result.draft.name).toBe("retry-intake");
  });

  it("returns an author-facing error when schema validation fails after retry", async () => {
    const textGenerationClient = new FakeTextClient([
      "not json",
      JSON.stringify({ draft: { name: "still invalid" } }),
    ]);
    const { service, logger } = createService(textGenerationClient);

    await expect(service.draft(workspaceId, agentId, {
      prose: "Collect email and send contact request.",
    })).rejects.toMatchObject({
      statusCode: 422,
      code: "invalid_routine_draft_assist",
      message: expect.stringContaining("could not be generated as a valid routine draft"),
    });
    expect(textGenerationClient.calls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failureMode: "schema_mismatch" }),
      "routine_draft_assist_invalid_after_retry",
    );
  });

  it("returns validator diagnostics when the proposal references an action outside the permitted catalog", async () => {
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        steps: [
          validDraft().steps[0],
          {
            ...validDraft().steps[1],
            actionType: "billing.refund",
          },
        ],
      })),
    ]);
    const { service } = createService(textGenerationClient, [{ type: "contact.send", kind: "action" }]);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Refund the customer after collecting the email.",
    });

    expect(result.validation).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "unregistered_action_type",
          location: "step:send_contact",
          message: expect.stringContaining("billing.refund"),
        }),
      ],
    });
  });
});
