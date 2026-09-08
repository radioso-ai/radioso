import { describe, expect, it, vi } from "vitest";

import {
  RoutineDraftAssistService,
  type RoutineDraftAssistActionCatalogEntry,
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

const createService = (
  textGenerationClient: FakeTextClient,
  actionCatalog: RoutineDraftAssistActionCatalogEntry[] = [{ type: "contact.send", kind: "action" }],
  skillAuthoringCatalog?: ConstructorParameters<typeof RoutineDraftAssistService>[0]["skillAuthoringCatalog"],
) => {
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
    ...(skillAuthoringCatalog ? { skillAuthoringCatalog } : {}),
    logger: logger as never,
    telemetryService: telemetryService,
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
      agentId,
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

  it("permits retrieval.context tool steps from the prose composer catalog", async () => {
    const draft = validDraft({
      steps: [
        {
          stableStepId: "retrieve_context",
          kind: "tool",
          instruction: "Retrieve workspace context for the latest user question.",
          toolRef: "retrieval.context",
          actionType: null,
          ordinal: 0,
          metadata: { outlineLabel: "Retrieve context" },
        },
        {
          stableStepId: "answer_question",
          kind: "chat",
          instruction: "Answer the user's latest question using the retrieved context, then ask if they want contact.",
          toolRef: null,
          actionType: null,
          ordinal: 1,
          metadata: { outlineLabel: "Answer and qualify" },
        },
      ],
      transitions: [
        {
          fromStep: "retrieve_context",
          toRef: "answer_question",
          guardKind: "default",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 0,
        },
        {
          fromStep: "answer_question",
          toRef: "complete",
          guardKind: "default",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 1,
        },
      ],
      slots: [],
    });
    const textGenerationClient = new FakeTextClient([completion(draft)]);
    const { service } = createService(textGenerationClient, [{
      type: "retrieval.context",
      kind: "tool",
      label: "Retrieval context",
      description: "Retrieve chunks for a routine reply.",
      outcomeStatuses: ["context_ready", "no_context"],
    }]);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Use retrieval context, answer the question, then ask if they want contact.",
    });

    expect(textGenerationClient.calls[0]?.prompt).toContain('"type": "retrieval.context"');
    expect(textGenerationClient.calls[0]?.prompt).toContain('"kind": "tool"');
    expect(result.draft.steps[0]).toMatchObject({
      kind: "tool",
      toolRef: "retrieval.context",
    });
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
  });

  it("permits agent skill catalog tool steps and treats @skill mentions as skills, not slots", async () => {
    const draft = validDraft({
      slots: [],
      steps: [{
        stableStepId: "refund_customer",
        kind: "tool",
        instruction: "Issue the refund with the agent refund skill.",
        toolRef: "refund_customer",
        actionType: null,
        ordinal: 0,
        metadata: { outlineLabel: "Refund customer" },
      }],
      transitions: [{
        fromStep: "refund_customer",
        toRef: "complete",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      }],
    });
    const textGenerationClient = new FakeTextClient([completion(draft)]);
    const skillAuthoringCatalog = {
      listForAgent: vi.fn().mockResolvedValue([{
        skillName: "refund_customer",
        displayName: "Refund customer",
        category: "external_mcp",
        description: "Issue a customer refund.",
        inputs: [],
        outcomes: [{ name: "completed", displayName: "Completed", status: "completed" }],
        hasDataOutputs: false,
      }]),
    };
    const { service } = createService(textGenerationClient, [{ type: "contact.send", kind: "action" }], skillAuthoringCatalog);

    const result = await service.draft(workspaceId, agentId, {
      prose: "When a refund is approved, use @refund_customer and then confirm completion.",
    });

    expect(skillAuthoringCatalog.listForAgent).toHaveBeenCalledWith({ workspaceId, agentId });
    expect(textGenerationClient.calls[0]?.prompt).toContain('"type": "refund_customer"');
    expect(textGenerationClient.calls[0]?.prompt).toContain('"kind": "tool"');
    expect(textGenerationClient.calls[0]?.prompt).toContain("treat it as that action/tool skill instead of a slot");
    expect(result.draft.slots).toHaveLength(0);
    expect(result.draft.steps[0]).toMatchObject({
      kind: "tool",
      toolRef: "refund_customer",
    });
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
  });

  it("normalizes bare brace slot references from declared slots before validation", async () => {
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        steps: [{
          ...validDraft().steps[0],
          instruction: "Ask for {{ email }} and confirm {{email}}.",
        }, validDraft().steps[1]],
      })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for the visitor email, send the contact request, then confirm.",
    });

    expect(result.draft.steps[0]?.instruction).toBe("Ask for {{slot.email}} and confirm {{slot.email}}.");
    expect(result.validation.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "declared_unused_slot",
      location: "slot:email",
    }));
  });

  it("normalizes at-mention slot references from declared slots before validation", async () => {
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        steps: [{
          ...validDraft().steps[0],
          instruction: "Ask for @email before sending.",
        }, validDraft().steps[1]],
      })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for the visitor email, send the contact request, then confirm.",
    });

    expect(result.draft.steps[0]?.instruction).toBe("Ask for {{slot.email}} before sending.");
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
  });

  it("uses @identifier procedure hints to repair undeclared recorded slots", async () => {
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        slots: [],
        steps: [{
          ...validDraft().steps[0],
          instruction: "Ask for their email and record it as @prospect_email.",
        }, {
          ...validDraft().steps[1],
          instruction: "Send the support request for @prospect_email.",
        }],
        terminals: [{
          ...validDraft().terminals[0],
          instruction: "Confirm @prospect_email is captured.",
        }],
      })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask them for their email and record it as @prospect_email, then summarize it.",
    });

    expect(textGenerationClient.calls[0]?.prompt).toContain('"prospect_email"');
    expect(result.draft.slots).toEqual([
      expect.objectContaining({ key: "prospect_email", required: true }),
    ]);
    expect(result.draft.steps[0]?.instruction).toBe(
      "Ask for their email and record it as {{slot.prospect_email}}.",
    );
    expect(result.draft.terminals[0]?.instruction).toBe(
      "Confirm {{slot.prospect_email}} is captured.",
    );
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
  });

  it("normalizes mixed declared slot references across prose fields", async () => {
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        steps: [{
          ...validDraft().steps[0],
          instruction: "Ask for {{email}}.",
        }, validDraft().steps[1]],
        transitions: [
          {
            ...validDraft().transitions[0],
            guardKind: "llm",
            guardText: "Continue when @email is available.",
          },
          validDraft().transitions[1],
        ],
        terminals: [{
          ...validDraft().terminals[0],
          instruction: "Confirm {{ email }} is on the request.",
        }],
      })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for the visitor email, send the contact request, then confirm.",
    });

    expect(result.draft.steps[0]?.instruction).toBe("Ask for {{slot.email}}.");
    expect(result.draft.transitions[0]?.guardText).toBe("Continue when {{slot.email}} is available.");
    expect(result.draft.terminals[0]?.instruction).toBe("Confirm {{slot.email}} is on the request.");
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
  });

  it("leaves non-declared slot-like references untouched", async () => {
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        steps: [{
          ...validDraft().steps[0],
          instruction: "Ask for {{product}} and @email.",
        }, validDraft().steps[1]],
      })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for the visitor email and product, send the contact request, then confirm.",
    });

    expect(result.draft.steps[0]?.instruction).toBe("Ask for {{product}} and {{slot.email}}.");
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
  });

  it("runs one validation retry and returns it when diagnostics improve", async () => {
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        name: "needs-terminal-path",
        transitions: [validDraft().transitions[0]],
      })),
      completion(validDraft({ name: "fixed-terminal-path" })),
    ]);
    const { service, telemetryService } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for email, send the contact request, then confirm.",
    });

    expect(textGenerationClient.calls).toHaveLength(2);
    expect(textGenerationClient.calls[1]?.operation.attemptKey).toBe("validation_retry");
    expect(textGenerationClient.calls[1]?.prompt).toContain("missing terminal: no terminal is reachable from the first step.");
    expect(result.draft.name).toBe("fixed-terminal-path");
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
    expect(telemetryService.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "routines.draft_assist.llm_call",
      tags: expect.objectContaining({
        attempt_key: "validation_retry",
        failure_mode: "none",
      }),
    }));
  });

  it("keeps the original proposal when the validation retry is worse", async () => {
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        name: "one-diagnostic",
        transitions: [validDraft().transitions[0]],
      })),
      completion(validDraft({
        name: "two-diagnostics",
        steps: [
          validDraft().steps[0],
          {
            ...validDraft().steps[1],
            actionType: "billing.refund",
          },
        ],
        transitions: [validDraft().transitions[0]],
      })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for email, send the contact request, then confirm.",
    });

    expect(textGenerationClient.calls).toHaveLength(2);
    expect(result.draft.name).toBe("one-diagnostic");
    expect(result.validation.diagnostics).toHaveLength(2);
    expect(result.validation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_action_follow_up" }),
      expect.objectContaining({ code: "missing_terminal" }),
    ]));
  });

  it("keeps the original proposal when the validation retry has the same diagnostic count", async () => {
    const originalInstruction = "Collect {{slot.email}} for the support request.";
    const retryInstruction = "Ask only for the account email.";
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        name: "original-one-diagnostic",
        steps: [
          {
            ...validDraft().steps[0],
            instruction: originalInstruction,
          },
          {
            ...validDraft().steps[1],
            actionType: "billing.refund",
          },
        ],
      })),
      completion(validDraft({
        name: "retry-one-diagnostic",
        steps: [
          {
            ...validDraft().steps[0],
            instruction: retryInstruction,
          },
          validDraft().steps[1],
        ],
      })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for email, send the contact request, then confirm.",
    });

    expect(textGenerationClient.calls).toHaveLength(2);
    expect(result.draft.name).toBe("original-one-diagnostic");
    expect(result.draft.steps[0]?.instruction).toBe(originalInstruction);
    expect(result.draft.steps[0]?.instruction).not.toBe(retryInstruction);
    expect(result.validation.diagnostics).toHaveLength(1);
    expect(result.validation.diagnostics[0]).toEqual(expect.objectContaining({
      code: "unregistered_action_type",
    }));
  });

  it("treats normalization overflow as schema mismatch and uses the schema retry", async () => {
    const nearLimitInstruction = `${"x".repeat(3986)} @email @email`;
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        steps: [{
          ...validDraft().steps[0],
          instruction: nearLimitInstruction,
        }, validDraft().steps[1]],
      })),
      completion(validDraft({ name: "normalized-retry" })),
    ]);
    const { service, logger } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for the visitor email, send the contact request, then confirm.",
    });

    expect(nearLimitInstruction).toHaveLength(4000);
    expect(textGenerationClient.calls).toHaveLength(2);
    expect(textGenerationClient.calls[1]?.operation.attemptKey).toBe("schema_retry");
    expect(result.draft.name).toBe("normalized-retry");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failureMode: "schema_mismatch", attemptKey: "primary" }),
      "routine_draft_assist_schema_mismatch",
    );
  });

  it("returns normalized drafts that remain under schema limits", async () => {
    const underLimitInstruction = `${"x".repeat(3980)} @email`;
    const textGenerationClient = new FakeTextClient([
      completion(validDraft({
        steps: [{
          ...validDraft().steps[0],
          instruction: underLimitInstruction,
        }, validDraft().steps[1]],
      })),
    ]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for the visitor email, send the contact request, then confirm.",
    });

    expect(textGenerationClient.calls).toHaveLength(1);
    expect(result.draft.steps[0]?.instruction).toBe(`${"x".repeat(3980)} {{slot.email}}`);
    expect(result.draft.steps[0]?.instruction).toHaveLength(3995);
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
  });

  it("does not run a validation retry for an already-valid draft", async () => {
    const textGenerationClient = new FakeTextClient([completion(validDraft())]);
    const { service } = createService(textGenerationClient);

    const result = await service.draft(workspaceId, agentId, {
      prose: "Ask for email, send the contact request, then confirm.",
    });

    expect(textGenerationClient.calls).toHaveLength(1);
    expect(result.validation).toEqual({ ok: true, diagnostics: [] });
  });
});
