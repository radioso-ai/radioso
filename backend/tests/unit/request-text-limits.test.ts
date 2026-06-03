import { describe, expect, it } from "vitest";

import { retrievalAnswerSchema, retrievalSearchSchema } from "../../src/app/http/routes/retrievalRoutes.js";
import { anonymousChatSchema } from "../../src/app/http/routes/publicChatRouteSchemas.js";
import { assistantChatSchema } from "../../src/app/http/schemas/assistantChatSchemas.js";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  RETRIEVAL_QUERY_MAX_LENGTH,
} from "../../src/app/http/schemas/textInputLimits.js";

describe("request text limits", () => {
  it("rejects oversized authenticated assistant messages", () => {
    const result = assistantChatSchema.safeParse({
      message: "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1),
      stream: false,
    });

    expect(result.success).toBe(false);
  });

  it("rejects oversized public chat messages", () => {
    const result = anonymousChatSchema.safeParse({
      message: "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1),
      stream: false,
    });

    expect(result.success).toBe(false);
  });

  it("rejects oversized retrieval search and answer queries", () => {
    const query = "x".repeat(RETRIEVAL_QUERY_MAX_LENGTH + 1);

    expect(retrievalSearchSchema.safeParse({ query }).success).toBe(false);
    expect(retrievalAnswerSchema.safeParse({ query }).success).toBe(false);
  });

  it("accepts boundary-length chat messages and retrieval queries", () => {
    expect(
      assistantChatSchema.safeParse({ message: "x".repeat(CHAT_MESSAGE_MAX_LENGTH), stream: false }).success,
    ).toBe(true);
    expect(
      anonymousChatSchema.safeParse({ message: "x".repeat(CHAT_MESSAGE_MAX_LENGTH), stream: false }).success,
    ).toBe(true);
    expect(
      retrievalSearchSchema.safeParse({ query: "x".repeat(RETRIEVAL_QUERY_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      retrievalAnswerSchema.safeParse({ query: "x".repeat(RETRIEVAL_QUERY_MAX_LENGTH) }).success,
    ).toBe(true);
  });
});
