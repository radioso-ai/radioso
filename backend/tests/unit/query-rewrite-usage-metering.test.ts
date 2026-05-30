import { describe, expect, it } from "vitest";

import {
  ModelQueryRewriteGateway,
  ModelTriggerAnalysisGateway,
} from "../../src/modules/retrieval/services/queryRewriteGateways.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { TextGenerationClient, TextGenerationRequest } from "../../src/shared/infra/llm/providerTypes.js";
import { streamResult, textResult } from "../support/llmStubs.js";

const recordingUsageRecorder = () => {
  const events: ModelUsageEvent[] = [];
  const recorder: UsageEventRecorder = {
    async recordEmbedding() {},
    async recordModelCall(event) {
      events.push(event);
    },
  };
  return { recorder, events };
};

describe("query rewrite usage metering", () => {
  it("records actual usage for successful query rewrite calls", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const gateway = new ModelQueryRewriteGateway(new ModelInferencePipelineService({
      metadata: { capability: "rewrite", provider: "openai", model: "gpt-rewrite" },
      async complete() {
        return textResult(JSON.stringify({
          rewrittenQuery: "reset password",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.92,
        }), {
          inputTokens: 30,
          outputTokens: 12,
          totalTokens: 42,
          providerRequestId: "req-rewrite-1",
          quality: "actual",
        });
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient, recorder));

    await gateway.rewrite({
      query: "how do i reset it",
      contextMessages: [],
      usageContext: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        requestId: "request-1",
        surface: "retrieval",
        operation: "query_interpretation",
        attemptKey: "rewrite",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: "account-1",
      workspaceId: "workspace-1",
      conversationId: null,
      messageId: null,
      surface: "retrieval",
      operation: "query_interpretation",
      provider: "openai",
      model: "gpt-rewrite",
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      status: "succeeded",
      usageQuality: "actual",
      providerRequestId: "req-rewrite-1",
    });
    expect(events[0]!.idempotencyKey).toContain("request-1");
    expect(events[0]!.idempotencyKey).toContain("rewrite");
  });

  it("records estimated failed usage when the rewrite provider throws", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const gateway = new ModelQueryRewriteGateway(new ModelInferencePipelineService({
      metadata: { capability: "rewrite", provider: "openai", model: "gpt-rewrite" },
      async complete() {
        throw new Error("provider unavailable");
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient, recorder));

    await expect(gateway.rewrite({
      query: "how do i reset it",
      contextMessages: [],
      usageContext: {
        workspaceId: "workspace-1",
        requestId: "request-1",
        surface: "retrieval",
        operation: "query_interpretation",
        attemptKey: "rewrite",
      },
    })).rejects.toThrow("provider unavailable");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: "workspace-1",
      surface: "retrieval",
      operation: "query_interpretation",
      provider: "openai",
      model: "gpt-rewrite",
      status: "failed",
      usageQuality: "estimated",
      errorCode: "provider unavailable",
    });
  });

  it("records trigger analysis as a separate operation", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const gateway = new ModelTriggerAnalysisGateway(new ModelInferencePipelineService({
      metadata: { capability: "rewrite", provider: "openai", model: "gpt-rewrite" },
      async complete() {
        return textResult(JSON.stringify({
          status: "applied",
          consideredRules: [],
          matchedRuleIds: [],
          unmatchedRuleIds: [],
          matchCount: 0,
          matcherVersion: "model",
        }));
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient, recorder));

    await gateway.analyze({
      query: "latest invoices",
      activeQuery: "latest invoices",
      contextMessages: [],
      rules: [],
      usageContext: {
        workspaceId: "workspace-1",
        requestId: "request-1",
        surface: "retrieval",
        operation: "trigger_analysis",
        attemptKey: "trigger_analysis",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: "workspace-1",
      surface: "retrieval",
      operation: "trigger_analysis",
      provider: "openai",
      model: "gpt-rewrite",
      status: "succeeded",
      usageQuality: "estimated",
    });
  });
});

describe("query interpretation reasoning effort", () => {
  const usageContext = {
    workspaceId: "workspace-1",
    requestId: "request-1",
    surface: "retrieval",
    operation: "query_interpretation",
    attemptKey: "rewrite",
  } as const;

  it("requests minimal reasoning effort for query rewrites", async () => {
    const requests: TextGenerationRequest[] = [];
    const gateway = new ModelQueryRewriteGateway(new ModelInferencePipelineService({
      metadata: { capability: "rewrite", provider: "openai", model: "gpt-5-nano" },
      async complete(input) {
        requests.push(input);
        return textResult(JSON.stringify({ rewrittenQuery: "reset password", confidence: 0.9 }));
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient));

    await gateway.rewrite({ query: "how do i reset it", contextMessages: [], usageContext });

    expect(requests[0]?.reasoningEffort).toBe("minimal");
  });

  it("requests minimal reasoning effort for trigger analysis", async () => {
    const requests: TextGenerationRequest[] = [];
    const gateway = new ModelTriggerAnalysisGateway(new ModelInferencePipelineService({
      metadata: { capability: "rewrite", provider: "openai", model: "gpt-5-nano" },
      async complete(input) {
        requests.push(input);
        return textResult(JSON.stringify({
          status: "applied",
          consideredRules: [],
          matchedRuleIds: [],
          unmatchedRuleIds: [],
          matchCount: 0,
          matcherVersion: "model",
        }));
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient));

    await gateway.analyze({
      query: "latest invoices",
      activeQuery: "latest invoices",
      contextMessages: [],
      rules: [],
      usageContext: { ...usageContext, operation: "trigger_analysis", attemptKey: "trigger_analysis" },
    });

    expect(requests[0]?.reasoningEffort).toBe("minimal");
  });
});
