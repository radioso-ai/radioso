import { describe, expect, it } from "vitest";

import { buildConversationIntentSnapshot } from "../../src/modules/chat/services/conversationIntentSnapshot.js";

describe("conversation intent snapshot", () => {
  it("relies on rewrite continuity metadata instead of phrase matching for active subject resolution", () => {
    const snapshot = buildConversationIntentSnapshot({
      history: [
        {
          id: "msg-1",
          conversationId: "conv-1",
          workspaceId: "ws-1",
          role: "user",
          content: "Earlier question",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      latestQuery: "what about pricing",
      priorRewriteContinuityState: {
        activeSubject: "membership plans",
        relatedEntities: [],
        groundedTitles: [],
      },
      rewriteProposal: {
        rewrittenQuery: "membership plan pricing",
        turnKind: "referential_followup",
        proposedActiveSubject: undefined,
        relatedEntities: [],
        unresolved: false,
        confidence: 0.92,
      },
    });

    expect(snapshot.activeSubject).toBe("membership plans");
    expect(snapshot.activeGoal).toBe("membership plans: what about pricing");
  });

  it("falls back to the raw latest query when no rewrite metadata is available", () => {
    const snapshot = buildConversationIntentSnapshot({
      history: [],
      latestQuery: "tell me about pricing",
    });

    expect(snapshot.activeSubject).toBe("tell me about pricing");
    expect(snapshot.activeGoal).toBe("tell me about pricing");
  });
});
