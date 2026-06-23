import { describe, expect, it } from "vitest";

import {
  buildDecisionMessage,
  buildResolvedDecisionMessage,
} from "../../../src/modules/slack/public.js";

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
});
