import { describe, expect, it, vi } from "vitest";

import {
  AgentRevisionRuntimeResolver,
  type AgentRevisionRuntimeReaderPort,
} from "../../src/modules/agents/runtime/agentRevisionRuntimeResolver.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";

const liveAgent = {
  id: agentId,
  workspaceId,
  name: "Live agent",
  customInstruction: "mutable instruction",
  authoredDirectives: [],
} as unknown as AgentRecord;

const revision = (id = revisionId): AgentRevision => ({
  id,
  snapshot: {
    customInstruction: "frozen instruction",
    directives: [],
    routines: [],
    contextVariableEnablements: [],
  },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date("2026-09-08T00:00:00.000Z"),
  publishedAt: new Date("2026-09-08T00:01:00.000Z"),
  publishedVersion: 1,
});

describe("AgentRevisionRuntimeResolver", () => {
  it("resolves a new turn from the current published revision without reading authored scoped rows", async () => {
    const reader: AgentRevisionRuntimeReaderPort = {
      findCurrentPublished: vi.fn(async () => revision()),
      findRevision: vi.fn(async () => null),
    };
    const resolver = new AgentRevisionRuntimeResolver(reader);

    const resolved = await resolver.resolveNew({ workspaceId, agent: liveAgent });

    expect(resolved.revisionId).toBe(revisionId);
    expect(resolved.agent.customInstruction).toBe("frozen instruction");
    expect(resolved.agent.authoredDirectives).toEqual([]);
    expect(reader.findCurrentPublished).toHaveBeenCalledWith({ workspaceId, agentId });
    expect(reader.findRevision).not.toHaveBeenCalled();
  });

  it("keeps a continuing conversation on its pinned revision after a later publication", async () => {
    const oldRevision = revision(revisionId);
    const reader: AgentRevisionRuntimeReaderPort = {
      findCurrentPublished: vi.fn(async () => revision("44444444-4444-4444-8444-444444444444")),
      findRevision: vi.fn(async () => oldRevision),
    };
    const resolver = new AgentRevisionRuntimeResolver(reader);

    const resolved = await resolver.resolvePinned({ workspaceId, agent: liveAgent, revisionId });

    expect(resolved.revisionId).toBe(revisionId);
    expect(resolved.agent.customInstruction).toBe("frozen instruction");
    expect(reader.findCurrentPublished).not.toHaveBeenCalled();
    expect(reader.findRevision).toHaveBeenCalledWith({ workspaceId, agentId, revisionId });
  });

  it("fails explicitly for unpublished agents and unavailable pinned revisions", async () => {
    const reader: AgentRevisionRuntimeReaderPort = {
      findCurrentPublished: vi.fn(async () => null),
      findRevision: vi.fn(async () => null),
    };
    const resolver = new AgentRevisionRuntimeResolver(reader);

    await expect(resolver.resolveNew({ workspaceId, agent: liveAgent })).rejects.toThrow("Agent is not published");
    await expect(resolver.resolvePinned({ workspaceId, agent: liveAgent, revisionId })).rejects.toThrow("Agent revision is unavailable");
  });

  it("rejects an unpublished candidate pin unless a trusted operator-test runner explicitly permits it", async () => {
    const candidate = { ...revision(), publishedAt: null };
    const reader: AgentRevisionRuntimeReaderPort = {
      findCurrentPublished: vi.fn(async () => null),
      findRevision: vi.fn(async () => candidate),
    };
    const resolver = new AgentRevisionRuntimeResolver(reader);

    await expect(resolver.resolvePinned({ workspaceId, agent: liveAgent, revisionId }))
      .rejects.toThrow("Agent revision is not published");
    await expect(resolver.resolvePinned({ workspaceId, agent: liveAgent, revisionId, allowCandidate: true }))
      .resolves.toMatchObject({ revisionId });
  });
});
