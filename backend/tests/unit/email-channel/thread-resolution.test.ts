import { describe, expect, it } from "vitest";

import {
  resolveThread,
  type ThreadCandidates,
} from "../../../src/modules/connectors/plugins/email/emailThreadResolution.js";

// Identities follow the threading fixtures in tests/fixtures/email-channel/mime/.
const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const participants = new Map([
  ["conv-alice", ALICE],
  ["conv-alice-2", ALICE],
  ["conv-bob", BOB],
]);

const candidates = (overrides: Partial<ThreadCandidates> = {}): ThreadCandidates => ({
  forward: [],
  reverse: [],
  byThreadToken: null,
  participantOf: (conversationId) => {
    const participant = participants.get(conversationId);
    if (participant === undefined) throw new Error(`no participant for ${conversationId}`);
    return participant;
  },
  ...overrides,
});

describe("resolveThread", () => {
  describe("new thread", () => {
    it("opens a new thread when nothing matches", () => {
      expect(resolveThread(candidates(), ALICE)).toEqual({ kind: "new" });
    });
  });

  describe("forward match", () => {
    it("continues the conversation an indexed In-Reply-To names", () => {
      expect(resolveThread(candidates({
        forward: [{ conversationId: "conv-alice", matchedBy: "in_reply_to", source: "index" }],
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "in_reply_to", conflict: false });
    });

    it("treats an in-flight reservation exactly like the committed index", () => {
      expect(resolveThread(candidates({
        forward: [{ conversationId: "conv-alice", matchedBy: "references", source: "reservation" }],
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "references", conflict: false });
    });

    it("sees no conflict when the index and a reservation name the same conversation", () => {
      expect(resolveThread(candidates({
        forward: [
          { conversationId: "conv-alice", matchedBy: "in_reply_to", source: "reservation" },
          { conversationId: "conv-alice", matchedBy: "in_reply_to", source: "index" },
          { conversationId: "conv-alice", matchedBy: "references", source: "index" },
        ],
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "in_reply_to", conflict: false });
    });

    it("prefers In-Reply-To over References, whatever order the lookup returned them in", () => {
      expect(resolveThread(candidates({
        forward: [
          { conversationId: "conv-alice", matchedBy: "references", source: "index" },
          { conversationId: "conv-alice-2", matchedBy: "in_reply_to", source: "index" },
        ],
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice-2", matchedBy: "in_reply_to", conflict: true });
    });

    it("prefers the committed index over a reservation when they disagree, and flags the conflict", () => {
      expect(resolveThread(candidates({
        forward: [
          { conversationId: "conv-alice-2", matchedBy: "in_reply_to", source: "reservation" },
          { conversationId: "conv-alice", matchedBy: "in_reply_to", source: "index" },
        ],
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "in_reply_to", conflict: true });
    });
  });

  describe("reverse reference", () => {
    it("joins the conversation of an earlier-processed message that references this one", () => {
      // out-of-order-child.eml processed before out-of-order-parent.eml (B15 interleaving ii).
      expect(resolveThread(candidates({ reverse: [{ conversationId: "conv-alice" }] }), ALICE))
        .toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "reverse_reference", conflict: false });
    });

    it("ranks a forward match ahead of a reverse match that agrees with it", () => {
      expect(resolveThread(candidates({
        forward: [{ conversationId: "conv-alice", matchedBy: "references", source: "index" }],
        reverse: [{ conversationId: "conv-alice" }],
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "references", conflict: false });
    });
  });

  describe("thread token", () => {
    it("falls back to the plus token when no header matches", () => {
      // token-only-reply.eml carries no In-Reply-To or References.
      expect(resolveThread(candidates({ byThreadToken: "conv-alice" }), ALICE))
        .toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "thread_token", conflict: false });
    });

    it("is not consulted once a header matched, so a disagreeing token is no conflict", () => {
      expect(resolveThread(candidates({
        forward: [{ conversationId: "conv-alice", matchedBy: "in_reply_to", source: "index" }],
        byThreadToken: "conv-alice-2",
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "in_reply_to", conflict: false });
    });
  });

  describe("participant mismatch", () => {
    it("refuses to continue a header-matched conversation for a different sender", () => {
      // participant-mismatch.eml: bob references alice's outbound Message-Id.
      expect(resolveThread(candidates({
        forward: [{ conversationId: "conv-alice", matchedBy: "in_reply_to", source: "index" }],
      }), BOB)).toEqual({ kind: "participant_mismatch", conversationId: "conv-alice" });
    });

    it("refuses to continue a token-matched conversation for a different sender", () => {
      expect(resolveThread(candidates({ byThreadToken: "conv-alice" }), BOB))
        .toEqual({ kind: "participant_mismatch", conversationId: "conv-alice" });
    });

    it("refuses a reverse match for a different sender", () => {
      expect(resolveThread(candidates({ reverse: [{ conversationId: "conv-alice" }] }), BOB))
        .toEqual({ kind: "participant_mismatch", conversationId: "conv-alice" });
    });

    it("compares addresses case-insensitively", () => {
      expect(resolveThread(candidates({
        forward: [{ conversationId: "conv-alice", matchedBy: "in_reply_to", source: "index" }],
      }), "Alice@Example.TEST")).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "in_reply_to", conflict: false });
    });
  });

  describe("conflict", () => {
    it("flags matches that name different conversations", () => {
      expect(resolveThread(candidates({
        forward: [{ conversationId: "conv-alice", matchedBy: "in_reply_to", source: "index" }],
        reverse: [{ conversationId: "conv-alice-2" }],
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "in_reply_to", conflict: true });
    });

    it("continues the sender's own conversation among conflicting matches", () => {
      expect(resolveThread(candidates({
        forward: [
          { conversationId: "conv-bob", matchedBy: "in_reply_to", source: "index" },
          { conversationId: "conv-alice", matchedBy: "references", source: "index" },
        ],
      }), ALICE)).toEqual({ kind: "existing", conversationId: "conv-alice", matchedBy: "references", conflict: true });
    });

    it("reports a mismatch on the best match when no conflicting match belongs to the sender", () => {
      expect(resolveThread(candidates({
        forward: [
          { conversationId: "conv-alice", matchedBy: "references", source: "index" },
          { conversationId: "conv-alice-2", matchedBy: "in_reply_to", source: "index" },
        ],
      }), BOB)).toEqual({ kind: "participant_mismatch", conversationId: "conv-alice-2" });
    });
  });
});
