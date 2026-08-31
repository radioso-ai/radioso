import { describe, expect, it, vi } from "vitest";

import { createRetrievalProbeCopilotTools } from "../../../src/modules/operatorCopilot/tools/retrievalProbe.js";
import { RetrievalProbeService } from "../../../src/modules/operatorCopilot/services/retrievalProbeService.js";
import { context } from "./copilot-tools-test-helpers.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const probeResult = (overrides: Record<string, unknown> = {}) => ({
  agentId: AGENT_ID,
  retrievalEnabled: true,
  rewrittenQuery: { semantic: "refund window", lexical: "refund" },
  results: [{
    documentId: "11111111-1111-4111-8111-111111111111",
    chunkId: "22222222-2222-4222-8222-222222222222",
    title: "Refund policy",
    content: "Refunds are issued within 14 days.",
    score: 0.82,
  }],
  ...overrides,
});

const toolFor = (probe: { probe: ReturnType<typeof vi.fn> }) => {
  const [descriptor] = createRetrievalProbeCopilotTools({
    retrievalProbe: probe,
    agentLookup: { listExisting: async () => [] },
  });
  return descriptor!;
};

describe("retrieval_probe descriptor", () => {
  it("declares the retrieval query and agent read permissions it uses", () => {
    const descriptor = toolFor({ probe: vi.fn() });

    expect(descriptor.name).toBe("retrieval_probe");
    expect(descriptor.shape).toBe("probe");
    expect(descriptor.requiredPermissions).toEqual(
      expect.arrayContaining(["workspace.retrieval.query", "workspace.agents.read"]),
    );
  });

  it("measures the agent named in the input", async () => {
    const probe = vi.fn(async () => probeResult());
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(OTHER_AGENT_ID)).invoke({
      agentId: AGENT_ID,
      query: "refund window",
    }) as { probe: { agentId: string; retrievalEnabled: boolean } };

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID, query: "refund window" }));
    expect(output.probe.agentId).toBe(AGENT_ID);
  });

  it("falls back to the agent the operator is looking at", async () => {
    const probe = vi.fn(async () => probeResult({ agentId: OTHER_AGENT_ID }));
    const descriptor = toolFor({ probe });

    await descriptor.createTool(context(OTHER_AGENT_ID)).invoke({ query: "refund window" });

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ agentId: OTHER_AGENT_ID }));
  });

  it("refuses to probe when no agent is in scope rather than measuring workspace defaults", async () => {
    const probe = vi.fn(async () => probeResult());
    const descriptor = toolFor({ probe });

    await expect(descriptor.createTool(context(null)).invoke({ query: "refund window" }))
      .rejects.toThrow(/agent/i);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports an agent that answers without retrieval", async () => {
    const probe = vi.fn(async () => probeResult({ retrievalEnabled: false, results: [] }));
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(AGENT_ID)).invoke({ query: "refund window" }) as {
      probe: { retrievalEnabled: boolean; results: unknown[] };
    };

    expect(output.probe.retrievalEnabled).toBe(false);
    expect(output.probe.results).toEqual([]);
  });

  it("bounds chunk text and result count, and says what it dropped", async () => {
    const probe = vi.fn(async () => probeResult({
      results: Array.from({ length: 14 }, (_unused, index) => ({
        documentId: "11111111-1111-4111-8111-111111111111",
        chunkId: `2222222${index}-2222-4222-8222-222222222222`,
        title: "Refund policy",
        content: "x".repeat(3_000),
        score: 0.5,
      })),
    }));
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(AGENT_ID)).invoke({ query: "refund window" }) as {
      probe: { results: Array<{ content: string }> };
      omissions: Array<{ field: string; reason: string }>;
    };

    expect(output.probe.results).toHaveLength(10);
    expect(output.probe.results[0]!.content.length).toBeLessThanOrEqual(1_200);
    expect(output.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "results", reason: "array_length" }),
      expect.objectContaining({ field: "results.content", reason: "string_length" }),
    ]));
  });
});

describe("RetrievalProbeService", () => {
  const guard = () => ({
    abuseControl: { enforce: vi.fn(async () => {}) },
    audit: { record: vi.fn(async () => {}) },
    abusePolicy: { limit: 10, windowMs: 60_000 },
  });

  const input = {
    workspaceId: "workspace-1",
    accountId: "account-1",
    operatorUserId: "operator-1",
    agentId: AGENT_ID,
    query: "refund window",
  };

  it("spends the operator's expensive-operation budget before running retrieval", async () => {
    const dependencies = guard();
    const search = vi.fn(async () => ({
      agentScope: { agentId: AGENT_ID, retrievalEnabled: true },
      rewrittenQuery: { semantic: "refund window", lexical: "refund" },
      results: [],
    }));
    const service = new RetrievalProbeService({ ...dependencies, retrievalSearch: { search } } as never);

    await service.probe(input);

    expect(dependencies.abuseControl.enforce).toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID, workspaceId: "workspace-1" }));
  });

  it("refuses a result attributed to a different agent than the one probed", async () => {
    const dependencies = guard();
    const search = vi.fn(async () => ({
      agentScope: { agentId: OTHER_AGENT_ID, retrievalEnabled: true },
      rewrittenQuery: { semantic: "q", lexical: "q" },
      results: [],
    }));
    const service = new RetrievalProbeService({ ...dependencies, retrievalSearch: { search } } as never);

    await expect(service.probe(input)).rejects.toThrow(/agent/i);
  });

  it("refuses an unattributed result rather than reporting workspace defaults as the agent's", async () => {
    const dependencies = guard();
    const search = vi.fn(async () => ({
      agentScope: null,
      rewrittenQuery: { semantic: "q", lexical: "q" },
      results: [],
    }));
    const service = new RetrievalProbeService({ ...dependencies, retrievalSearch: { search } } as never);

    await expect(service.probe(input)).rejects.toThrow(/agent/i);
  });
});
