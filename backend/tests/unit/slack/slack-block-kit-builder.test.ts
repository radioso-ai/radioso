import { describe, expect, it } from "vitest";

import {
  buildDecisionMessage,
  buildOwnershipMessage,
  buildReplyModal,
  buildResolvedDecisionMessage,
} from "../../../src/modules/slack/public.js";

const readMrkdwnTexts = (blocks: Array<Record<string, unknown>>): string[] =>
  blocks.flatMap((block) => {
    if (block.type !== "section") {
      return [];
    }
    return [(block.text as { text: string }).text];
  });

const readActionBlocks = (blocks: Array<Record<string, unknown>>): Array<{ elements: Array<Record<string, unknown>> }> =>
  blocks.filter((block) => block.type === "actions") as Array<{ elements: Array<Record<string, unknown>> }>;

describe("slackBlockKitBuilder", () => {
  it("renders one decision button per option with encoded option ids", () => {
    const message = buildDecisionMessage({
      reason: "Pick the next branch",
      options: [
        { id: "ship", label: "Ship it" },
        { id: "hold", label: "Hold" },
        { id: "ask_more", label: "Ask for more detail" },
      ],
      handle: "pd_1",
      contentHash: "hash_1",
      agentId: "agent_1",
      dashboardPath: "/conversations/conv_1",
    });

    expect(JSON.stringify(message.blocks)).toContain("Pick the next branch");
    const actions = message.blocks.find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements).toHaveLength(3);
    expect(actions.elements.map((element) => element.action_id)).toEqual([
      "decision_resolve",
      "decision_resolve",
      "decision_resolve",
    ]);
    expect(actions.elements.map((element) => (element.text as { text: string }).text)).toEqual([
      "Ship it",
      "Hold",
      "Ask for more detail",
    ]);
    expect(actions.elements.map((element) => JSON.parse(element.value as string))).toEqual([
      { handle: "pd_1", optionId: "ship", contentHash: "hash_1", agentId: "agent_1" },
      { handle: "pd_1", optionId: "hold", contentHash: "hash_1", agentId: "agent_1" },
      { handle: "pd_1", optionId: "ask_more", contentHash: "hash_1", agentId: "agent_1" },
    ]);
    expect(actions.elements.every((element) => (element.value as string).length <= 2_000)).toBe(true);
  });

  it("clamps decision section text, button labels, and action elements to Slack limits", () => {
    const message = buildDecisionMessage({
      reason: "r".repeat(3_100),
      options: Array.from({ length: 30 }, (_, index) => ({
        id: `option_${index}`,
        label: `option ${index} ${"l".repeat(100)}`,
      })),
      handle: "pd_1",
      contentHash: "hash_1",
      agentId: "agent_1",
      dashboardPath: "/conversations/conv_1",
    });

    expect(readMrkdwnTexts(message.blocks).every((text) => text.length <= 3_000)).toBe(true);
    const actions = readActionBlocks(message.blocks)[0]!;
    expect(actions.elements).toHaveLength(25);
    expect(actions.elements.every((element) => (element.text as { text: string }).text.length <= 75)).toBe(true);
    expect(JSON.stringify(message.blocks)).toContain("…");
    expect(message.blocks.filter((block) => block.type === "context")).toHaveLength(2);
  });

  it("renders a resolved decision outcome with the chosen label first", () => {
    const message = buildResolvedDecisionMessage({
      reason: "Pick the next branch",
      chosenLabel: "Ship it",
      operatorName: "Dana",
      resumed: true,
    });

    const rendered = JSON.stringify(message.blocks);
    expect(rendered).toContain("Pick the next branch");
    expect(rendered).toContain("Ship it");
    expect(rendered).toContain("Dana");
    expect(rendered).not.toContain("decision_resolve");
  });

  it("clamps resolved decision text fields to Slack limits", () => {
    const message = buildResolvedDecisionMessage({
      reason: "r".repeat(3_100),
      chosenLabel: "l".repeat(3_100),
      operatorName: "Dana",
      resumed: true,
    });

    expect(readMrkdwnTexts(message.blocks).every((text) => text.length <= 3_000)).toBe(true);
    expect(JSON.stringify(message.blocks)).toContain("…");
  });

  it("renders pre-takeover ownership with only the takeover action", () => {
    const message = buildOwnershipMessage({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      state: "ai_owned",
      contextText: "Customer needs help with billing.",
      dashboardPath: "/conversations/conv_1",
    });

    expect(JSON.stringify(message.blocks)).toContain("Customer needs help with billing.");
    expect(JSON.stringify(message.blocks)).toContain("/conversations/conv_1");
    const actions = message.blocks.find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((element) => element.action_id)).toEqual(["ownership_takeover"]);
    expect(JSON.parse(actions.elements[0]!.value as string)).toEqual({
      conversationId: "conv_1",
      workspaceId: "ws_1",
    });
  });

  it("clamps ownership context text to Slack limits", () => {
    const message = buildOwnershipMessage({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      state: "ai_owned",
      contextText: "c".repeat(3_100),
      dashboardPath: "/conversations/conv_1",
    });

    expect(readMrkdwnTexts(message.blocks).every((text) => text.length <= 3_000)).toBe(true);
    expect(JSON.stringify(message.blocks)).toContain("…");
  });

  it("renders post-takeover ownership with talk and handback actions carrying the version", () => {
    const message = buildOwnershipMessage({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      state: "human_owned",
      contextText: "Customer needs help with billing.",
      dashboardPath: "/conversations/conv_1",
      ownerName: "Dana",
      version: 3,
    });

    const rendered = JSON.stringify(message.blocks);
    expect(rendered).toContain("Handled by Dana");
    const actions = message.blocks.find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((element) => element.action_id)).toEqual(["ownership_talk", "ownership_handback"]);
    expect(actions.elements.map((element) => JSON.parse(element.value as string))).toEqual([
      { conversationId: "conv_1", workspaceId: "ws_1", version: 3 },
      { conversationId: "conv_1", version: 3 },
    ]);
  });

  it("renders the ownership reply modal with callback metadata and input block", () => {
    const modal = buildReplyModal({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      version: 3,
    });

    expect(modal).toMatchObject({
      type: "modal",
      callback_id: "ownership_reply",
      private_metadata: JSON.stringify({ conversationId: "conv_1", workspaceId: "ws_1", version: 3 }),
    });
    expect(JSON.stringify(modal.blocks)).toContain("ownership_reply_message");
    expect(JSON.stringify(modal.blocks)).toContain("ownership_reply_text");
  });

  it("keeps reply modal text fields within Slack modal limits", () => {
    const modal = buildReplyModal({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      version: 3,
    });

    expect((modal.title as { text: string }).text.length).toBeLessThanOrEqual(24);
    expect((modal.submit as { text: string }).text.length).toBeLessThanOrEqual(24);
    expect((modal.close as { text: string }).text.length).toBeLessThanOrEqual(24);
    const block = (modal.blocks as Array<{ label: { text: string } }>)[0]!;
    expect(block.label.text.length).toBeLessThanOrEqual(2_000);
  });
});
