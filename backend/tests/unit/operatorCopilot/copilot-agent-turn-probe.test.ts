import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

import { enrichCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import {
  AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET,
  agentTurnProbeEnrichedOutputSchema,
  createAgentTurnProbeCopilotTools,
} from "../../../src/modules/operatorCopilot/tools/agentTurnProbe.js";
import { copilotToolAnnotationsForShape } from "../../../src/modules/operatorCopilot/toolShape.js";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userMessageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const assistantMessageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const invocationContext = (permissions: ReadonlySet<string>) => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  copilotConversationId: "copilot-conversation-1",
  permissions,
  pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] },
});

const result = (overrides: Record<string, unknown> = {}) => ({
  conversationId,
  userMessageId,
  assistantMessageId,
  agentId,
  answer: "The routine fired.",
  citations: [{
    documentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    chunkId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    title: "Support policy",
    sourceUrl: "https://docs.example.com/support?token=signed-secret#private",
    content: "private retrieved chunk",
  }],
  skillOutcome: "completed",
  answerOutcome: "routine.completed",
  activitySummary: { prompt: "private prompt", contextVariables: { apiKey: "secret" } },
  activityTrace: { retrievedChunks: [{ content: "private document content" }] },
  turnTrace: {
    version: 1,
    spine: {
      traceId: "trace-1",
      startedAt: "2026-08-21T10:00:00.000Z",
      completedAt: "2026-08-21T10:00:01.000Z",
      stages: [{
        id: "dispatch:routine",
        kind: "dispatch",
        status: "completed",
        startedAt: "2026-08-21T10:00:00.100Z",
        completedAt: "2026-08-21T10:00:00.900Z",
        inputs: { prompt: "private prompt" },
        outputs: { completion: "private completion" },
        subTrace: { retrievedChunks: [{ text: "private document content" }] },
      }],
    },
    summary: { credential: "secret" },
  },
  ...overrides,
});

const build = (testTurn = vi.fn(async () => result()), workspaceKey = "acme") => {
  const [descriptor] = createAgentTurnProbeCopilotTools({
    agentLookup: { listExisting: vi.fn(async () => [{ id: agentId, name: "Support", isDefault: true, assistantBootstrapActive: false }]) },
    agentTurnProbe: { testTurn },
  });
  const [enriched] = enrichCopilotToolCatalog([descriptor!], {
    resolveWorkspaceKey: async () => workspaceKey,
  });
  return { descriptor: descriptor!, enriched: enriched!, testTurn };
};

describe("test_agent_turn", () => {
  it("declares a dashboard-only probe with all required permissions and MCP-safe annotations", () => {
    const { descriptor } = build();

    expect(descriptor).toMatchObject({
      name: "test_agent_turn",
      shape: "probe",
      requiredPermissions: [
        "workspace.agents.read",
        "workspace.chat.use",
        "workspace.history.read",
        "workspace.agents.manage",
      ],
      contributingModule: "chat",
    });
    // The probe writes a conversation and its messages and spends a model call, so a transport
    // must not treat it as free to run unattended or to retry.
    expect(copilotToolAnnotationsForShape(descriptor.shape)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it("resolves an agent name to a stable id and forwards only the safe probe contract", async () => {
    const { enriched, testTurn } = build();
    const permissions = new Set(enriched.requiredPermissions);
    const output = await enriched.createTool(invocationContext(permissions)).invoke({
      agentName: "Support",
      message: "I need help",
      previewRoutineIds: ["11111111-1111-4111-8111-111111111111"],
      userExpectedLocale: "it-IT",
      inputMetadata: { method: "typed" },
      pageContext: { pageUrl: "https://example.com/help", pageTitle: "Help" },
      clientContextCapabilities: {
        "page.read": { available: true, mode: "metadata", supportedOperations: ["metadata"] },
      },
    }, {} as never);

    expect(testTurn).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      copilotConversationId: "copilot-conversation-1",
      agentId,
      message: "I need help",
      previewRoutineIds: ["11111111-1111-4111-8111-111111111111"],
      userExpectedLocale: "it-IT",
      inputMetadata: { method: "typed" },
      pageContext: { pageUrl: "https://example.com/help", pageTitle: "Help" },
      clientContextCapabilities: {
        "page.read": { available: true, mode: "metadata", supportedOperations: ["metadata"] },
      },
    });
    expect(output).toMatchObject({
      dashboardUrl: `/w/acme/activity?itemKind=chat&itemId=${conversationId}`,
      probe: { agentId, conversationId, userMessageId, assistantMessageId },
    });
  });

  it("rejects transport-controlled source, streaming, and identity fields", () => {
    const { descriptor } = build();
    const base = { agentId, message: "hello" };

    for (const forbidden of ["sourceChannel", "sourceOrigin", "stream", "verifiedIdentity"] as const) {
      expect(descriptor.inputSchema.safeParse({ ...base, [forbidden]: "attacker-controlled" }).success).toBe(false);
    }
  });

  it("fails closed before resolution or execution when any permission is missing", async () => {
    for (const missing of build().descriptor.requiredPermissions) {
      const { descriptor, enriched, testTurn } = build();
      const permissions = new Set(descriptor.requiredPermissions.filter((permission) => permission !== missing));
      const output = await enriched.createTool(invocationContext(permissions))
        .invoke({ agentName: "Support", message: "hello" }, {} as never);

      expect(output).toEqual({
        dashboardUrl: "/w/acme/activity",
        resolution: { status: "not_found", candidates: [] },
      });
      expect(testTurn).not.toHaveBeenCalled();
    }
  });

  it("returns only allowlisted fields and validates the final strict output", async () => {
    const { descriptor } = build();
    const output = await descriptor.createTool(invocationContext(new Set(descriptor.requiredPermissions)))
      .invoke({ agentId, message: "hello" }, {} as never);
    const serialized = JSON.stringify(output);

    expect(descriptor.outputSchema.safeParse(output).success).toBe(true);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private completion");
    expect(serialized).not.toContain("private document content");
    expect(serialized).not.toContain("private retrieved chunk");
    expect(serialized).not.toContain("secret");
    expect(output).toMatchObject({
      probe: {
        citations: [{
          documentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          chunkId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          title: "Support policy",
        }],
        trace: {
          version: 1,
          spine: { stages: [{ id: "dispatch:routine", kind: "dispatch", status: "completed" }] },
        },
      },
    });
    expect(output).toMatchObject({
      omissions: expect.arrayContaining([
        { field: "citations.sourceUrl", reason: "not_allowlisted" },
        { field: "diagnostics", reason: "not_allowlisted" },
      ]),
    });
  });

  it("hard-caps the final enriched result by serialized bytes with multibyte content and a long dashboard link", async () => {
    const malicious = {
      traceId: "x".repeat(100_000),
      stages: Array.from({ length: 2_000 }, (_, index) => ({
        id: `stage-${index}-${"x".repeat(1_000)}`,
        kind: "dispatch",
        status: "completed",
        inputs: { prompt: "secret".repeat(10_000) },
      })),
    };
    const { descriptor, enriched } = build(vi.fn(async () => result({
      answer: "🧪".repeat(200_000),
      citations: Array.from({ length: 2_000 }, () => ({
        documentId: "doc".repeat(10_000),
        chunkId: "chunk".repeat(10_000),
        title: "title".repeat(10_000),
        sourceUrl: `https://example.com/${"signed".repeat(10_000)}`,
      })),
      turnTrace: { version: 1, spine: malicious },
    })), "workspace-".repeat(1_000));

    const tool = enriched.createTool(invocationContext(new Set(descriptor.requiredPermissions)));
    const output = await tool.invoke({ agentId, message: "hello" }, {} as never);

    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(AGENT_TURN_PROBE_PAYLOAD_BYTE_BUDGET);
    expect(output).toMatchObject({ omissions: expect.arrayContaining([
      expect.objectContaining({ reason: expect.any(String) }),
    ]) });
    expect(agentTurnProbeEnrichedOutputSchema.safeParse(output).success).toBe(true);
  });
});
