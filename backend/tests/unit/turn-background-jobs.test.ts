import { describe, expect, it } from "vitest";

import type { AgentContextVariableEnablement } from "../../src/modules/context-variables/public.js";
import { turnBackgroundJobs } from "../../src/modules/chat/services/turnBackgroundJobs.js";

const enablement = (overrides: Partial<AgentContextVariableEnablement> = {}): AgentContextVariableEnablement => ({
  id: "enablement-1",
  agentId: "agent-1",
  variableId: "variable-1",
  source: "classified",
  resolverSkillId: null,
  maxAgeSeconds: null,
  resolverTimeoutMs: null,
  surfacing: "on_reference",
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const turn = (overrides: {
  enablements?: AgentContextVariableEnablement[];
  sourceChannel?: string | null;
  source?: "customer" | "human_agent";
  sensitiveSlotKeys?: string[];
} = {}) => turnBackgroundJobs({
  workspaceId: "workspace-1",
  accountId: "account-1",
  session: {
    conversation: { id: "conversation-1", sourceChannel: overrides.sourceChannel === undefined ? "embed" : overrides.sourceChannel },
    userMessage: { role: "user", source: overrides.source ?? "customer" },
    ...(overrides.enablements ? { revisionContextVariableEnablements: overrides.enablements } : {}),
  },
  sensitiveSlotKeys: overrides.sensitiveSlotKeys ?? [],
});

const kinds = (jobs: ReturnType<typeof turnBackgroundJobs>) => jobs.map((job) => job.kind);

describe("turnBackgroundJobs", () => {
  it("always refreshes the summary, and classifies when the conversation's revision classifies an attribute", () => {
    expect(kinds(turn())).toEqual(["conversation.summary_refresh"]);
    expect(kinds(turn({ enablements: [enablement({ source: "pushed" })] }))).toEqual(["conversation.summary_refresh"]);
    expect(kinds(turn({ enablements: [enablement({ enabled: false })] }))).toEqual(["conversation.summary_refresh"]);

    const jobs = turn({ enablements: [enablement({ source: "pushed" }), enablement()] });
    expect(kinds(jobs)).toEqual(["conversation.summary_refresh", "context.classification"]);
    expect(jobs[1]).toMatchObject({ idempotencyKey: "conversation-1", payload: { workspaceId: "workspace-1", conversationId: "conversation-1" } });
  });

  it("does not classify after a turn that answered a sensitive slot, a teammate's message or an operator test", () => {
    const classified = [enablement()];
    expect(kinds(turn({ enablements: classified, sensitiveSlotKeys: ["condition"] }))).toEqual(["conversation.summary_refresh"]);
    expect(kinds(turn({ enablements: classified, source: "human_agent" }))).toEqual(["conversation.summary_refresh"]);
    expect(kinds(turn({ enablements: classified, sourceChannel: "workbench_replay" }))).toEqual(["conversation.summary_refresh"]);
  });
});
