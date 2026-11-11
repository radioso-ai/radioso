import { describe, expect, it, vi } from "vitest";

import { OperatorCopilotService } from "../../../src/modules/operatorCopilot/public.js";
import type { CopilotContextContributor } from "../../../src/modules/operatorCopilot/context/contributor.js";
import { InMemoryCopilotRepository } from "../../support/inMemoryCopilotRepository.js";

type WarnLogger = { warn: (fields: Record<string, unknown>, message: string) => void };

const serviceWith = (contextContributors: ReadonlyArray<CopilotContextContributor>, logger?: WarnLogger) => {
  const runStreaming = vi.fn((_request: { systemPrompt: string; userMessage: string }) => ({
    events: (async function* () {})(),
    result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "Done", stepsTaken: 1, toolResultTokensUsed: 0, wallTimeMs: 1 }),
  }));
  const service = new OperatorCopilotService({
    repository: new InMemoryCopilotRepository(),
    capabilityRunner: { runStreaming },
    usageLimitPolicy: { reserveAnswer: vi.fn(async () => ({ commit: vi.fn(async () => {}), release: vi.fn(async () => {}) })), reserveDocument: vi.fn(), reserveIndexedStorage: vi.fn(), reserveMonthlyIndexedContent: vi.fn() },
    auditService: { record: vi.fn(async () => {}) },
    prompt: "system",
    workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "acme" },
    currentAuthorization: { hasAllPermissions: async () => true },
    tools: [],
    contextContributors,
    ...(logger ? { logger } : {}),
  });
  const turn = async (permissions: string[] = ["workspace.summary.read"]) => {
    for await (const _event of service.runTurn({
      surface: "dashboard",
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      conversationId: null,
      message: "What should I do next?",
      pageContext: { view: "other", agentId: null, conversationId: null, selection: null, entities: [] },
      permissions: new Set(permissions),
    })) { /* drain */ }
    return runStreaming.mock.calls[0][0];
  };
  return { turn };
};

describe("Ray turn context", () => {
  it("hands each contributor the workspace, its route key, and the operator's permissions", async () => {
    const contribute = vi.fn(async () => null);
    await serviceWith([{ id: "probe", contribute }]).turn(["workspace.summary.read"]);
    expect(contribute).toHaveBeenCalledWith({ workspaceId: "workspace-1", workspaceKey: "acme", permissions: new Set(["workspace.summary.read"]) });
  });

  it("puts contributed context in the system prompt, ahead of the safety boundaries", async () => {
    const request = await serviceWith([{ id: "workspace_setup", contribute: async () => ({ id: "workspace_setup", data: { phase: "setup" } }) }]).turn();
    expect(request.systemPrompt).toContain(JSON.stringify({ workspace_setup: { phase: "setup" } }));
    expect(request.systemPrompt.indexOf("workspace_setup")).toBeLessThan(request.systemPrompt.indexOf("Deliberate safety boundaries"));
    // Context is trusted runtime data; it never rides in the operator-controlled turn input.
    expect(request.userMessage).not.toContain("workspace_setup");
  });

  it("leaves the system prompt as it was when no contributor has anything to say", async () => {
    const request = await serviceWith([{ id: "quiet", contribute: async () => null }]).turn();
    expect(request.systemPrompt).not.toContain("Workspace context");
  });

  it("still answers the operator when a contributor fails, and records which one", async () => {
    const warn = vi.fn<WarnLogger["warn"]>();
    const request = await serviceWith([{ id: "workspace_setup", contribute: async () => { throw new Error("database unavailable"); } }], { warn }).turn();
    expect(request.userMessage).toContain("What should I do next?");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ contributorId: "workspace_setup" }), "operator_copilot_context_contributor_failed");
  });
});
