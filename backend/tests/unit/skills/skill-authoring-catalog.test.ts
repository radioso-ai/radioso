import { describe, expect, it } from "vitest";

import { SkillAuthoringCatalogService } from "../../../src/modules/skills/skillAuthoringCatalog.js";
import type { SkillAvailability } from "../../../src/modules/skills/public.js";
import type { SkillCatalogDescriptorSource } from "../../../src/modules/skills/authoringDescriptor.js";

type TestCatalogEntry = SkillCatalogDescriptorSource & { availability?: SkillAvailability };

const catalogEntry = (overrides: Partial<TestCatalogEntry> = {}): TestCatalogEntry => ({
  name: "retrieval.context",
  displayName: "Retrieval context",
  description: "Retrieve chunks for a routine reply.",
  owner: "retrieval",
  intake: {
    enabled: true,
    supportedCallers: ["assistant"],
    intent: { description: "answer", examples: [] },
    fields: [
      {
        name: "query",
        displayName: "Query",
        type: "string",
        required: true,
        extractionHint: "The question.",
      },
    ],
    confirmation: "none",
    interruptionPolicy: "cancel_on_topic_change",
  },
  outcomes: [{ name: "grounded", displayName: "Grounded", status: "completed" }],
  ...overrides,
});

describe("SkillAuthoringCatalogService", () => {
  it("assembles available system catalog entries and enabled external skills for an agent", async () => {
    const catalog = new SkillAuthoringCatalogService({
      skillCatalog: {
        async list(context) {
          expect(context).toEqual({
            workspaceId: "workspace_1",
            accountId: "account_1",
            userId: "user_1",
          });
          return {
            skills: [
              catalogEntry(),
              catalogEntry({
                name: "retrieval.search",
                displayName: "Search",
                description: "Not routine-dispatchable.",
                owner: "retrieval",
              }),
              catalogEntry({
                name: "documents.ingest",
                displayName: "Ingest",
                description: "Unavailable.",
                owner: "documents",
                availability: { state: "forbidden", reason: "capability_denied" },
              }),
            ],
          };
        },
      },
      externalSkills: {
        async list(agentId) {
          expect(agentId).toBe("agent_1");
          return [
            {
              skillName: "post_slack",
              displayName: "Post Slack",
              exposedParams: { message: { description: "Message body." } },
              declaredOutcomes: ["sent"],
              outcomeMap: null,
              enabled: true,
            },
            {
              skillName: "disabled_tool",
              exposedParams: {} as Record<string, { description?: string }>,
              declaredOutcomes: null,
              outcomeMap: null,
              enabled: false,
            },
          ];
        },
      },
    });

    const descriptors = await catalog.listForAgent({
      workspaceId: "workspace_1",
      agentId: "agent_1",
      accountId: "account_1",
      userId: "user_1",
    });

    expect(descriptors.map((descriptor) => descriptor.skillName)).toEqual([
      "retrieval.context",
      "post_slack",
    ]);
    expect(descriptors.find((descriptor) => descriptor.skillName === "retrieval.context")?.category).toBe("retrieval");
    expect(descriptors.find((descriptor) => descriptor.skillName === "post_slack")?.category).toBe("external_mcp");
    expect(descriptors.find((descriptor) => descriptor.skillName === "post_slack")?.inputs).toEqual([
      { key: "message", type: "text", required: false, description: "Message body." },
    ]);
  });

  it("gets a descriptor by skill name from the assembled catalog", async () => {
    const catalog = new SkillAuthoringCatalogService({
      skillCatalog: {
        async list() {
          return { skills: [catalogEntry()] };
        },
      },
      externalSkills: {
        async list() {
          return [{
            skillName: "post_slack",
            exposedParams: {},
            declaredOutcomes: null,
            outcomeMap: null,
            enabled: true,
          }];
        },
      },
    });

    await expect(catalog.getForAgent({ workspaceId: "workspace_1", agentId: "agent_1" }, "post_slack"))
      .resolves.toMatchObject({ skillName: "post_slack" });
    await expect(catalog.getForAgent({ workspaceId: "workspace_1", agentId: "agent_1" }, "missing"))
      .resolves.toBeNull();
  });

  it("still returns system skills when the external-skill source fails", async () => {
    const warnings: unknown[] = [];
    const catalog = new SkillAuthoringCatalogService({
      skillCatalog: {
        async list() {
          return { skills: [catalogEntry()] };
        },
      },
      externalSkills: {
        async list() {
          throw new Error('relation "external_skill_details" does not exist');
        },
      },
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    });

    const descriptors = await catalog.listForAgent({ workspaceId: "workspace_1", agentId: "agent_1" });
    expect(descriptors.map((descriptor) => descriptor.skillName)).toEqual(["retrieval.context"]);
    expect(warnings.length).toBe(1);
  });

  it("still returns external skills when the system catalog source fails", async () => {
    const catalog = new SkillAuthoringCatalogService({
      skillCatalog: {
        async list() {
          throw new Error("catalog unavailable");
        },
      },
      externalSkills: {
        async list() {
          return [{ skillName: "post_slack", exposedParams: {}, declaredOutcomes: null, outcomeMap: null, enabled: true }];
        },
      },
      logger: { warn: () => {} },
    });

    const descriptors = await catalog.listForAgent({ workspaceId: "workspace_1", agentId: "agent_1" });
    expect(descriptors.map((descriptor) => descriptor.skillName)).toEqual(["post_slack"]);
  });
});
