import { describe, expect, it } from "vitest";

import { RETRIEVAL_ANSWER_ADAPTER, skillActsOutsideConversation } from "../../src/modules/retrieval/public.js";
import { CUSTOMER_EMAIL_SKILLS_ADAPTER } from "../../src/modules/customerEmail/public.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../src/modules/externalSkills/public.js";
import { NOTIFY_SKILLS_ADAPTER } from "../../src/modules/notify/public.js";
import { SLACK_SKILLS_ADAPTER } from "../../src/modules/slackSkills/public.js";
import { WEBHOOK_SKILLS_ADAPTER } from "../../src/modules/webhookSkills/public.js";

const internal = (adapter: string) => ({ kind: "internal" as const, adapter, enqueue: false });

describe("skillActsOutsideConversation", () => {
  it("knows a retrieval skill reading through the internal retrieval adapter stays inside the conversation", () => {
    expect(skillActsOutsideConversation({ retrieval: true, execution: internal(RETRIEVAL_ANSWER_ADAPTER) })).toBe(false);
  });

  it.each([
    ["webhook", WEBHOOK_SKILLS_ADAPTER],
    ["customer email", CUSTOMER_EMAIL_SKILLS_ADAPTER],
    ["Slack", SLACK_SKILLS_ADAPTER],
    ["notify", NOTIFY_SKILLS_ADAPTER],
    ["external MCP", EXTERNAL_SKILLS_ADAPTER],
  ])("treats a %s skill as acting outside the conversation", (_label, adapter) => {
    expect(skillActsOutsideConversation({ retrieval: false, execution: internal(adapter) })).toBe(true);
  });

  it("treats a non-retrieval skill configured onto the retrieval adapter as acting outside it", () => {
    expect(skillActsOutsideConversation({ retrieval: false, execution: internal(RETRIEVAL_ANSWER_ADAPTER) })).toBe(true);
  });

  it("treats a retrieval skill on any other execution, or none, as acting outside it", () => {
    expect(skillActsOutsideConversation({ retrieval: true, execution: internal(WEBHOOK_SKILLS_ADAPTER) })).toBe(true);
    expect(skillActsOutsideConversation({ retrieval: true, execution: undefined })).toBe(true);
    expect(skillActsOutsideConversation({
      retrieval: true,
      execution: { kind: "http", endpoint: "https://example.com/hook" } as never,
    })).toBe(true);
  });
});
