import { describe, expect, it } from "vitest";

import { agentBodySchema } from "../../../src/app/http/routes/agentRoutes.js";
import { projectAgentConfigForImport } from "../../../src/modules/agentBundle/importProjection.js";
import { presentRevisionDetail } from "../../../src/app/http/routes/agentRevisionPresenters.js";
import { describeCandidateReleaseDiff } from "../../../src/modules/agents/candidateReleaseReview.js";
import { agentSettingProposalEffect } from "../../../src/modules/agents/agentInputSchema.js";
import {
  agentReviewedSettingsPatchSchema,
  equalScopedAuthoringSnapshots,
  materializeAgentFromConfig,
  parseAgentRevisionSnapshot,
  revisionVisitorImagesEnabled,
  projectInternalAgentConfig,
  serializeAgentConfig,
  validateAgentInput,
} from "../../../src/modules/agents/public.js";
import { conversationQualityAgent } from "../../fixtures/conversation-quality/agent.js";

describe("the agent's visitorImagesEnabled flag", () => {
  it("is off until an operator turns it on", () => {
    expect(validateAgentInput({}).visitorImagesEnabled).toBe(false);
    expect(validateAgentInput({ visitorImagesEnabled: true }).visitorImagesEnabled).toBe(true);
  });

  it("is a field of the agent's write body and of a reviewed settings change", () => {
    expect(agentBodySchema.parse({ visitorImagesEnabled: true })).toEqual({ visitorImagesEnabled: true });
    expect(agentReviewedSettingsPatchSchema.parse({ visitorImagesEnabled: true })).toEqual({ visitorImagesEnabled: true });
    expect(agentBodySchema.safeParse({ visitorImagesEnabled: "yes" }).success).toBe(false);
  });

  it("travels in the agent's portable config and back", () => {
    const agent = { ...conversationQualityAgent, visitorImagesEnabled: true };

    expect(serializeAgentConfig(agent).visitorImagesEnabled).toBe(true);
    const internal = projectInternalAgentConfig(agent);
    expect(internal.visitorImagesEnabled).toBe(true);
    expect(materializeAgentFromConfig(internal, { agentId: agent.id, workspaceId: agent.workspaceId }).visitorImagesEnabled).toBe(true);
  });

  it("reads a config written before the flag existed as off", () => {
    const { visitorImagesEnabled: _dropped, ...older } = projectInternalAgentConfig({ ...conversationQualityAgent, visitorImagesEnabled: true });

    expect(materializeAgentFromConfig(older as Parameters<typeof materializeAgentFromConfig>[0], {
      agentId: conversationQualityAgent.id,
      workspaceId: conversationQualityAgent.workspaceId,
    }).visitorImagesEnabled).toBe(false);
  });

  it("is carried into an imported agent", () => {
    const config = serializeAgentConfig({ ...conversationQualityAgent, visitorImagesEnabled: true });

    expect(projectAgentConfigForImport(config).input.visitorImagesEnabled).toBe(true);
  });
});

describe("the photo switch in an agent revision", () => {
  const release = { customInstruction: "Be brief.", directives: [], routines: [], contextVariableEnablements: [] };

  it("round-trips through a revision snapshot, and is absent from one frozen before it was part of a revision", () => {
    expect(parseAgentRevisionSnapshot(JSON.parse(JSON.stringify({ ...release, visitorImagesEnabled: true }))).visitorImagesEnabled).toBe(true);
    expect(parseAgentRevisionSnapshot({ ...release, visitorImagesEnabled: false }).visitorImagesEnabled).toBe(false);
    expect(parseAgentRevisionSnapshot(release)).not.toHaveProperty("visitorImagesEnabled");
  });

  it("is the revision's own value, or the agent's setting for a revision that holds none", () => {
    expect(revisionVisitorImagesEnabled({ visitorImagesEnabled: false }, true)).toBe(false);
    expect(revisionVisitorImagesEnabled({ visitorImagesEnabled: true }, false)).toBe(true);
    expect(revisionVisitorImagesEnabled({}, true)).toBe(true);
    expect(revisionVisitorImagesEnabled({}, false)).toBe(false);
  });

  it("makes a draft differ from its release when the two switches differ, and never from a release that follows the agent's setting", () => {
    expect(equalScopedAuthoringSnapshots({ ...release, visitorImagesEnabled: true }, { ...release, visitorImagesEnabled: false })).toBe(false);
    expect(equalScopedAuthoringSnapshots({ ...release, visitorImagesEnabled: true }, { ...release, visitorImagesEnabled: true })).toBe(true);
    // A release without a switch follows the agent's setting, which the draft holds.
    expect(equalScopedAuthoringSnapshots({ ...release, visitorImagesEnabled: true }, release)).toBe(true);
  });

  it("is a draft change when Ray prepares it, which visitors get once it is published", () => {
    expect(agentSettingProposalEffect("visitorImagesEnabled")).toEqual({ lifecycle: "agent_draft", reach: false });
  });

  it("is listed among a release's changes when a candidate turns it on or off", () => {
    expect(describeCandidateReleaseDiff({ ...release, visitorImagesEnabled: false }, { ...release, visitorImagesEnabled: true }).changes)
      .toEqual([{ field: "visitorImagesEnabled", id: "agent", before: "false", after: "true", truncated: false }]);
    expect(describeCandidateReleaseDiff(release, { ...release, visitorImagesEnabled: true }).changes).toEqual([]);
    expect(describeCandidateReleaseDiff(null, { ...release, visitorImagesEnabled: true }).changes)
      .toContainEqual({ field: "visitorImagesEnabled", id: "agent", before: null, after: "true", truncated: false });
  });

  it("shows in a revision's review what publishing it does to the switch", () => {
    const revision = (id: string, snapshot: object) => ({ id, snapshot: { ...release, ...snapshot }, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null });

    expect(presentRevisionDetail(revision("candidate", { visitorImagesEnabled: true }), revision("published", { visitorImagesEnabled: false })).scopedChanges.visitorImagesEnabled)
      .toEqual({ before: false, after: true, changed: true });
    expect(presentRevisionDetail(revision("candidate", { visitorImagesEnabled: true }), revision("published", {})).scopedChanges.visitorImagesEnabled)
      .toEqual({ before: null, after: true, changed: false });
    expect(presentRevisionDetail(revision("candidate", { visitorImagesEnabled: true }), null).scopedChanges.visitorImagesEnabled)
      .toEqual({ before: null, after: true, changed: true });
  });
});
