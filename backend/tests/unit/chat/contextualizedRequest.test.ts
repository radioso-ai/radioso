import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
import { buildContextualizedRequest } from "../../../src/modules/chat/services/contextualizedRequest.js";

const message = (role: MessageRecord["role"], content: string, metadata?: Record<string, unknown>): MessageRecord => ({
  id: `${role}-${content}`,
  conversationId: "conv_1",
  workspaceId: "ws_1",
  role,
  content,
  ...(metadata ? { metadata } : {}),
  createdAt: new Date("2026-10-25T00:00:00.000Z"),
});

describe("buildContextualizedRequest", () => {
  it("frames the request with recent history, a turn whose routine held a sensitive value withheld (#1543)", () => {
    const sensitive = { sensitiveSlotKeys: ["injury"] };
    const request = buildContextualizedRequest({
      history: [
        message("user", "I want to book yoga"),
        message("user", "I tore my ACL", sensitive),
        message("assistant", "Noted, a torn ACL. Which day?", sensitive),
      ],
      effectiveQuery: "Do you have parking?",
    }, "Do you have parking?");

    expect(request).toBe("user: I want to book yoga\nuser: [redacted]\nassistant: [redacted]\nuser: Do you have parking?");
  });
});
