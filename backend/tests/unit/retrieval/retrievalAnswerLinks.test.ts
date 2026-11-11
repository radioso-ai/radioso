import { describe, expect, it } from "vitest";

import { RetrievalAnswerService } from "../../../src/modules/retrieval/services/retrievalAnswerService.js";

const COURSE_URL = "https://school.example/courses/breath";

/** The standalone answer behind `POST /api/v1/retrieval/answer`, MCP capability calls included. */
const serviceAnswering = (answer: string) => {
  const metricWrites: Array<{ name: string; labels?: Record<string, string> }> = [];
  const service = new RetrievalAnswerService({
    retrievalPipeline: {
      async interpret() {
        return { interpretation: { result: {} } };
      },
      async runInterpreted() {
        return {
          rewrittenQuery: "autumn courses",
          contexts: [{ chunkId: "chunk-1", documentId: "doc-1", title: "Breath", content: "Three days of breath work." }],
          systemPrompt: "Speak for the school. Questions go to info@school.example.",
          prompt: `Result 1 (Il respiro consapevole): Source: ${COURSE_URL}\nThree days of breath work.`,
          diagnostics: { rewriteStatus: "skipped", rerankStatus: "skipped" },
          trace: { traceId: "trace-1", startedAt: new Date().toISOString(), stages: [], links: [] },
          responseSettings: { citationDisplayEnabled: true },
        };
      },
    },
    chatGateway: {
      async answer() {
        return answer;
      },
    },
    metrics: {
      incrementCounter(name: string, options: { labels?: Record<string, string> }) {
        metricWrites.push({ name, labels: options.labels });
      },
    },
  } as never);
  return { service, metricWrites };
};

describe("retrieval answer links", () => {
  it("shows a link to an address the model was not sent as plain text, and keeps the rest", async () => {
    const { service, metricWrites } = serviceAnswering(
      `Join [Il respiro consapevole](${COURSE_URL})[[1]], or [Il silenzio](https://example.org/silence)[[?]]. `
        + "Write to [the office](mailto:info@school.example).",
    );

    const result = await service.answer({ workspaceId: "workspace-1", query: "Which courses run this autumn?" });

    expect(result.answer).toBe(
      `Join [Il respiro consapevole](${COURSE_URL}), or Il silenzio. Write to [the office](mailto:info@school.example).`,
    );
    expect(metricWrites.filter((write) => write.name === "retrieval_answer_links_unwrapped_total")).toEqual([
      { name: "retrieval_answer_links_unwrapped_total", labels: { reason: "not_given", surface: "retrieval" } },
    ]);
  });
});
