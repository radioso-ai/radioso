import { describe, expect, it } from "vitest";

import type { AgentSkillKind, AgentSkillInvocationMode, AgentSkillSpine } from "../../../src/modules/agentSkills/public.js";
import {
  RoutineInvocableSkillNamesService,
  routineNameDispatchedSkillKinds,
} from "../../../src/modules/skills/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const spine = (overrides: Pick<AgentSkillSpine, "skillName" | "kind"> & {
  enabled?: boolean;
  invocationMode?: AgentSkillInvocationMode;
}): AgentSkillSpine => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  return {
    id: `id-${overrides.skillName}`,
    agentId,
    workspaceId,
    skillName: overrides.skillName,
    kind: overrides.kind,
    invocationMode: overrides.invocationMode ?? "routine_named",
    enabled: overrides.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
};

class StubAgentSkillRepository {
  calls: Array<{ workspaceId: string; agentId: string }> = [];

  constructor(private readonly spines: readonly AgentSkillSpine[] = []) {}

  async listByAgent(requestedWorkspaceId: string, requestedAgentId: string): Promise<AgentSkillSpine[]> {
    this.calls.push({ workspaceId: requestedWorkspaceId, agentId: requestedAgentId });
    return [...this.spines];
  }
}

const build = (spines: readonly AgentSkillSpine[]) => {
  const agentSkills = new StubAgentSkillRepository(spines);
  return { agentSkills, service: new RoutineInvocableSkillNamesService({ agentSkills }) };
};

describe("RoutineInvocableSkillNamesService", () => {
  it("names the kinds whose routine resolver accepts any enabled row", () => {
    // Pinned rather than described: the set is the whole product decision, and the
    // runtime resolver chain is what it has to agree with.
    expect([...routineNameDispatchedSkillKinds].sort()).toEqual(["customer_email", "slack", "webhook"]);
  });

  it("lists enabled webhook, customer-email and Slack skills", async () => {
    const { service } = build([
      spine({ skillName: "webhook_notify_ops", kind: "webhook" }),
      spine({ skillName: "email_send_receipt", kind: "customer_email" }),
      spine({ skillName: "slack_ping_team", kind: "slack" }),
    ]);

    expect(await service.listForAgent({ workspaceId, agentId })).toEqual([
      "webhook_notify_ops",
      "email_send_receipt",
      "slack_ping_team",
    ]);
  });

  it("includes a Slack skill, which the composition closure it replaces omitted entirely", async () => {
    const { service } = build([spine({ skillName: "slack_ping_team", kind: "slack" })]);

    expect(await service.listForAgent({ workspaceId, agentId })).toEqual(["slack_ping_team"]);
  });

  it("includes a name-dispatched skill whatever its invocation mode, matching the resolver", async () => {
    // The three resolvers key off an enabled-only name list; the authoring catalog lists
    // `routine_named` only. That difference is exactly why this supplement exists.
    const { service } = build([
      spine({ skillName: "webhook_agent_pick", kind: "webhook", invocationMode: "agent_selectable" }),
      spine({ skillName: "slack_agent_pick", kind: "slack", invocationMode: "agent_selectable" }),
    ]);

    expect(await service.listForAgent({ workspaceId, agentId })).toEqual([
      "webhook_agent_pick",
      "slack_agent_pick",
    ]);
  });

  it("excludes disabled skills, which no resolver will route", async () => {
    const { service } = build([
      spine({ skillName: "webhook_off", kind: "webhook", enabled: false }),
      spine({ skillName: "slack_off", kind: "slack", enabled: false }),
    ]);

    expect(await service.listForAgent({ workspaceId, agentId })).toEqual([]);
  });

  it("excludes retrieve skills, whose runtime resolver applies the catalog's own mode filter", async () => {
    // Adding them here would widen validation past runtime: `RetrieveRoutineSkillResolver`
    // routes only `enabled && routine_named`, which is precisely what the authoring
    // catalog already offers.
    const { service } = build([
      spine({ skillName: "retrieve_docs", kind: "retrieve" }),
      spine({ skillName: "retrieve_agent_pick", kind: "retrieve", invocationMode: "agent_selectable" }),
    ]);

    expect(await service.listForAgent({ workspaceId, agentId })).toEqual([]);
  });

  it("excludes external MCP and notify skills, which have no name-keyed routine resolver", async () => {
    const { service } = build([
      spine({ skillName: "mcp_thing", kind: "external_mcp" }),
      spine({ skillName: "notify_thing", kind: "notify" }),
    ]);

    expect(await service.listForAgent({ workspaceId, agentId })).toEqual([]);
  });

  it("groups names by kind so each runtime resolver gets its own list", async () => {
    const { service } = build([
      spine({ skillName: "webhook_notify_ops", kind: "webhook" }),
      spine({ skillName: "email_send_receipt", kind: "customer_email" }),
      spine({ skillName: "slack_ping_team", kind: "slack" }),
      spine({ skillName: "retrieve_docs", kind: "retrieve" }),
    ]);

    expect(await service.listByKindForAgent({ workspaceId, agentId })).toEqual({
      webhook: ["webhook_notify_ops"],
      customer_email: ["email_send_receipt"],
      slack: ["slack_ping_team"],
    });
  });

  it("returns an empty list per kind when the agent has no skills at all", async () => {
    const { service } = build([]);

    expect(await service.listByKindForAgent({ workspaceId, agentId })).toEqual({
      webhook: [],
      customer_email: [],
      slack: [],
    });
  });

  it("reads the agent's skills scoped to the requesting workspace", async () => {
    const { service, agentSkills } = build([]);

    await service.listForAgent({ workspaceId, agentId });

    expect(agentSkills.calls).toEqual([{ workspaceId, agentId }]);
  });

  it("issues one read for both shapes rather than one per kind", async () => {
    const { service, agentSkills } = build([spine({ skillName: "webhook_notify_ops", kind: "webhook" })]);

    await service.listByKindForAgent({ workspaceId, agentId });

    expect(agentSkills.calls).toHaveLength(1);
  });

  it("keeps every dispatched kind a real agent-skill kind", () => {
    const kinds: readonly AgentSkillKind[] = routineNameDispatchedSkillKinds;

    expect(kinds).toHaveLength(3);
  });
});
