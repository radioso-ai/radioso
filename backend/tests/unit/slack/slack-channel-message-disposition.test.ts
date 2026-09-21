import { describe, expect, it } from "vitest";

import { resolveChannelMessageDisposition } from "../../../src/modules/connectors/plugins/slack/slackChannelMessageDisposition.js";

const channelBinding = (respondMode: "mention" | "every_message") => ({ channelId: "CSALES", respondMode });
const defaultBinding = { channelId: null, respondMode: "mention" as const };

describe("resolveChannelMessageDisposition", () => {
  describe("thread replies", () => {
    it("answers in the thread when Radioso already owns it, whatever the respond mode", () => {
      for (const binding of [channelBinding("mention"), channelBinding("every_message"), defaultBinding]) {
        expect(resolveChannelMessageDisposition({
          ts: "2.0",
          threadTs: "1.0",
          hasOwnedThread: true,
          binding,
        })).toEqual({ kind: "answer", threadTs: "1.0" });
      }
    });

    it("stays out of threads it does not own, even when the channel answers every message", () => {
      for (const binding of [channelBinding("mention"), channelBinding("every_message"), defaultBinding]) {
        expect(resolveChannelMessageDisposition({
          ts: "2.0",
          threadTs: "1.0",
          hasOwnedThread: false,
          binding,
        })).toEqual({ kind: "skip", reason: "thread_not_owned" });
      }
    });
  });

  describe("top-level messages", () => {
    it("opens a new thread under the message when the explicit channel binding answers every message", () => {
      expect(resolveChannelMessageDisposition({
        ts: "3.0",
        threadTs: undefined,
        hasOwnedThread: false,
        binding: channelBinding("every_message"),
      })).toEqual({ kind: "answer", threadTs: "3.0" });
    });

    it("treats a message whose thread_ts equals its own ts as top-level", () => {
      expect(resolveChannelMessageDisposition({
        ts: "3.0",
        threadTs: "3.0",
        hasOwnedThread: false,
        binding: channelBinding("every_message"),
      })).toEqual({ kind: "answer", threadTs: "3.0" });
    });

    it("waits for a mention when the explicit channel binding is mention-only", () => {
      expect(resolveChannelMessageDisposition({
        ts: "3.0",
        threadTs: undefined,
        hasOwnedThread: false,
        binding: channelBinding("mention"),
      })).toEqual({ kind: "skip", reason: "mention_only" });
    });

    it("never answers un-mentioned top-level messages through the default binding", () => {
      expect(resolveChannelMessageDisposition({
        ts: "3.0",
        threadTs: undefined,
        hasOwnedThread: false,
        binding: { channelId: null, respondMode: "every_message" },
      })).toEqual({ kind: "skip", reason: "mention_only" });
    });
  });
});
