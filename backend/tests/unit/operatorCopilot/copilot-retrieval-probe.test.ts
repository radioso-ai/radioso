import { describe, expect, it, vi } from "vitest";

import { admittedAbuseControlDecision } from "../../support/fakes.js";
import { createRetrievalProbeCopilotTools } from "../../../src/modules/operatorCopilot/tools/retrievalProbe.js";
import type { CopilotRetrievalProbePort, CopilotRetrievalProbeResult, CopilotRetrievalSearchPort } from "../../../src/modules/operatorCopilot/contracts/retrievalProbe.js";
import { RetrievalProbeService } from "../../../src/modules/operatorCopilot/services/retrievalProbeService.js";
import { context } from "./copilot-tools-test-helpers.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const probeResult = (overrides: Partial<CopilotRetrievalProbeResult> = {}): CopilotRetrievalProbeResult => ({
  agentId: AGENT_ID,
  retrievalEnabled: true,
  rewrittenQuery: { semantic: "refund window", lexical: "refund" },
  requestedDateRange: null,
  requestedDateRangeDropReason: null,
  requestedRangeLookup: { status: "not_requested", candidateCount: 0 },
  results: [{
    documentId: "11111111-1111-4111-8111-111111111111",
    chunkId: "22222222-2222-4222-8222-222222222222",
    title: "Refund policy",
    content: "Refunds are issued within 14 days.",
    score: 0.82,
    dateFrom: null,
    dateTo: null,
    datedInRequestedRange: null,
    fromRequestedRangeLookup: false,
  }],
  ...overrides,
});

const toolFor = (retrievalProbe: CopilotRetrievalProbePort) => {
  const [descriptor] = createRetrievalProbeCopilotTools({
    retrievalProbe,
    agentLookup: { listExisting: async () => [] },
  });
  return descriptor;
};

/** The runtime supplies the tool context; these tests exercise projection, not the runtime. */
const toolContext = {} as never;

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
    }, toolContext) as { probe: { agentId: string; retrievalEnabled: boolean } };

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID, query: "refund window" }));
    expect(output.probe.agentId).toBe(AGENT_ID);
  });

  it("falls back to the agent the operator is looking at", async () => {
    const probe = vi.fn(async () => probeResult({ agentId: OTHER_AGENT_ID }));
    const descriptor = toolFor({ probe });

    await descriptor.createTool(context(OTHER_AGENT_ID)).invoke({ query: "refund window" }, toolContext);

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ agentId: OTHER_AGENT_ID }));
  });

  it("refuses to probe when no agent is in scope rather than measuring workspace defaults", async () => {
    const probe = vi.fn(async () => probeResult());
    const descriptor = toolFor({ probe });

    await expect(descriptor.createTool(context(null)).invoke({ query: "refund window" }, toolContext))
      .rejects.toThrow(/agent/i);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports an agent that answers without retrieval", async () => {
    const probe = vi.fn(async () => probeResult({ retrievalEnabled: false, results: [] }));
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(AGENT_ID)).invoke({ query: "refund window" }, toolContext) as {
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
        dateFrom: null,
        dateTo: null,
        datedInRequestedRange: null,
        fromRequestedRangeLookup: false,
      })),
    }));
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(AGENT_ID)).invoke({ query: "refund window" }, toolContext) as {
      probe: { results: Array<{ content: string }> };
      omissions: Array<{ field: string; reason: string }>;
    };

    expect(output.probe.results).toHaveLength(10);
    expect(output.probe.results[0].content.length).toBeLessThanOrEqual(1_200);
    expect(output.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "results", reason: "array_length" }),
      expect.objectContaining({ field: "results.content", reason: "string_length" }),
    ]));
  });

  it("reports the resolved date range, that the requested-range lookup ran, and which results it contributed", async () => {
    const probe = vi.fn(async () => probeResult({
      requestedDateRange: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
      requestedRangeLookup: { status: "ran", candidateCount: 2 },
      results: [{
        documentId: "11111111-1111-4111-8111-111111111111",
        chunkId: "22222222-2222-4222-8222-222222222222",
        title: "January course listing",
        content: "Runs 3-6 January 2027.",
        score: 0.6,
        dateFrom: "2027-01-03",
        dateTo: "2027-01-06",
        datedInRequestedRange: true,
        fromRequestedRangeLookup: true,
      }],
    }));
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(AGENT_ID)).invoke({
      query: "which courses run from 3 to 6 January 2027",
    }, toolContext) as {
      probe: {
        requestedDateRange: { dateFrom: string; dateTo: string } | null;
        requestedRangeLookup: { status: string; candidateCount: number };
        results: Array<{ dateFrom: string | null; dateTo: string | null; datedInRequestedRange: boolean | null; fromRequestedRangeLookup: boolean }>;
      };
    };

    expect(output.probe.requestedDateRange).toEqual({ dateFrom: "2027-01-03", dateTo: "2027-01-06" });
    expect(output.probe.requestedRangeLookup).toEqual({ status: "ran", candidateCount: 2 });
    expect(output.probe.results[0]).toEqual(expect.objectContaining({
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
      datedInRequestedRange: true,
      fromRequestedRangeLookup: true,
    }));
  });

  it("reports why a model-resolved range was dropped instead of reporting none silently", async () => {
    const probe = vi.fn(async () => probeResult({
      requestedDateRange: null,
      requestedDateRangeDropReason: "too_long",
    }));
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(AGENT_ID)).invoke({
      query: "courses over the next three years",
    }, toolContext) as { probe: { requestedDateRange: unknown; requestedDateRangeDropReason: string | null } };

    expect(output.probe.requestedDateRange).toBeNull();
    expect(output.probe.requestedDateRangeDropReason).toBe("too_long");
  });

  it("reports no range, no drop reason, and that the lookup did not run for a question naming no date", async () => {
    const probe = vi.fn(async () => probeResult());
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(AGENT_ID)).invoke({
      query: "refund window",
    }, toolContext) as {
      probe: { requestedDateRange: unknown; requestedDateRangeDropReason: unknown; requestedRangeLookup: { status: string; candidateCount: number } };
    };

    expect(output.probe.requestedDateRange).toBeNull();
    expect(output.probe.requestedDateRangeDropReason).toBeNull();
    expect(output.probe.requestedRangeLookup).toEqual({ status: "not_requested", candidateCount: 0 });
  });

  it("reports the lookup as failed rather than ran when it errored", async () => {
    const probe = vi.fn(async () => probeResult({
      requestedDateRange: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
      requestedRangeLookup: { status: "failed", candidateCount: 0 },
    }));
    const descriptor = toolFor({ probe });

    const output = await descriptor.createTool(context(AGENT_ID)).invoke({
      query: "which courses run from 3 to 6 January 2027",
    }, toolContext) as { probe: { requestedRangeLookup: { status: string; candidateCount: number } } };

    expect(output.probe.requestedRangeLookup).toEqual({ status: "failed", candidateCount: 0 });
  });
});

describe("RetrievalProbeService", () => {
  const guard = () => ({
    abuseControl: { enforce: vi.fn(async () => admittedAbuseControlDecision()) },
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

  const searchResult = (
    overrides: Partial<Awaited<ReturnType<CopilotRetrievalSearchPort["search"]>>> = {},
  ): Awaited<ReturnType<CopilotRetrievalSearchPort["search"]>> => ({
    agentScope: { agentId: AGENT_ID, retrievalEnabled: true },
    rewrittenQuery: { semantic: "refund window", lexical: "refund" },
    requestedDateRange: null,
    requestedDateRangeDropReason: null,
    requestedRangeLookup: { status: "not_requested", candidateCount: 0 },
    results: [],
    ...overrides,
  });

  it("spends the operator's expensive-operation budget before running retrieval", async () => {
    const dependencies = guard();
    const search = vi.fn(async () => searchResult());
    const service = new RetrievalProbeService({ ...dependencies, retrievalSearch: { search } });

    await service.probe(input);

    expect(dependencies.abuseControl.enforce).toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID, workspaceId: "workspace-1" }));
  });

  it("refuses a result attributed to a different agent than the one probed", async () => {
    const dependencies = guard();
    const search = vi.fn(async () => searchResult({ agentScope: { agentId: OTHER_AGENT_ID, retrievalEnabled: true } }));
    const service = new RetrievalProbeService({ ...dependencies, retrievalSearch: { search } });

    await expect(service.probe(input)).rejects.toThrow(/agent/i);
  });

  it("refuses an unattributed result rather than reporting workspace defaults as the agent's", async () => {
    const dependencies = guard();
    const search = vi.fn(async () => searchResult({ agentScope: null }));
    const service = new RetrievalProbeService({ ...dependencies, retrievalSearch: { search } });

    await expect(service.probe(input)).rejects.toThrow(/agent/i);
  });

  it("passes the resolved date range, drop reason, and requested-range lookup summary through unchanged", async () => {
    const dependencies = guard();
    const search = vi.fn(async () => searchResult({
      requestedDateRange: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
      requestedRangeLookup: { status: "ran", candidateCount: 4 },
    }));
    const service = new RetrievalProbeService({ ...dependencies, retrievalSearch: { search } });

    const result = await service.probe(input);

    expect(result.requestedDateRange).toEqual({ dateFrom: "2027-01-03", dateTo: "2027-01-06" });
    expect(result.requestedRangeLookup).toEqual({ status: "ran", candidateCount: 4 });
  });
});
