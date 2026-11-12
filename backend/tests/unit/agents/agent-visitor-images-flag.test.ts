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
  agentDraftChange,
  parseAgentRevisionSnapshot,
  projectInternalAgentConfig,
  serializeAgentConfig,
  validateAgentInput,
} from "../../../src/modules/agents/public.js";
import { revisionTakesPhotos } from "../../../src/modules/visitorImages/public.js";
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

  it("round-trips through a revision snapshot, and is absent from one frozen without it", () => {
    expect(parseAgentRevisionSnapshot(JSON.parse(JSON.stringify({ ...release, visitorImagesEnabled: true }))).visitorImagesEnabled).toBe(true);
    expect(parseAgentRevisionSnapshot({ ...release, visitorImagesEnabled: false }).visitorImagesEnabled).toBe(false);
    expect(parseAgentRevisionSnapshot(release)).not.toHaveProperty("visitorImagesEnabled");
  });

  it("takes photos only in a revision that turns them on: one that holds no switch takes none", () => {
    expect(revisionTakesPhotos({ visitorImagesEnabled: true })).toBe(true);
    expect(revisionTakesPhotos({ visitorImagesEnabled: false })).toBe(false);
    expect(revisionTakesPhotos({})).toBe(false);
    expect(revisionTakesPhotos(null)).toBe(false);
  });

  it("makes a draft differ from its release only when one takes photos and the other does not", () => {
    expect(equalScopedAuthoringSnapshots({ ...release, visitorImagesEnabled: true }, { ...release, visitorImagesEnabled: false })).toBe(false);
    expect(equalScopedAuthoringSnapshots({ ...release, visitorImagesEnabled: true }, release)).toBe(false);
    expect(equalScopedAuthoringSnapshots({ ...release, visitorImagesEnabled: false }, release)).toBe(true);
    expect(equalScopedAuthoringSnapshots({ ...release, visitorImagesEnabled: true }, { ...release, visitorImagesEnabled: true })).toBe(true);
  });

  it("is a draft change when Ray prepares it, which visitors get once it is published", () => {
    expect(agentSettingProposalEffect("visitorImagesEnabled")).toEqual({ lifecycle: "agent_draft", reach: false });
  });

  it("is listed among a release's changes only when the release takes photos where its base did not, or the other way", () => {
    expect(describeCandidateReleaseDiff({ ...release, visitorImagesEnabled: false }, { ...release, visitorImagesEnabled: true }).changes)
      .toEqual([{ field: "visitorImagesEnabled", id: "agent", before: "false", after: "true", truncated: false }]);
    expect(describeCandidateReleaseDiff(release, { ...release, visitorImagesEnabled: true }).changes)
      .toEqual([{ field: "visitorImagesEnabled", id: "agent", before: "false", after: "true", truncated: false }]);
    expect(describeCandidateReleaseDiff(release, { ...release, visitorImagesEnabled: false }).changes).toEqual([]);
    expect(describeCandidateReleaseDiff(null, { ...release, visitorImagesEnabled: false }).changes).not.toContainEqual(expect.objectContaining({ field: "visitorImagesEnabled" }));
    expect(describeCandidateReleaseDiff(null, { ...release, visitorImagesEnabled: true }).changes)
      .toContainEqual({ field: "visitorImagesEnabled", id: "agent", before: null, after: "true", truncated: false });
  });

  it("shows in a revision's review whether publishing it turns photos on or off", () => {
    const revision = (id: string, snapshot: object) => ({ id, snapshot: { ...release, ...snapshot }, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null });

    expect(presentRevisionDetail(revision("candidate", { visitorImagesEnabled: true }), revision("published", { visitorImagesEnabled: false })).scopedChanges.visitorImagesEnabled)
      .toEqual({ before: false, after: true, changed: true });
    expect(presentRevisionDetail(revision("candidate", { visitorImagesEnabled: true }), revision("published", {})).scopedChanges.visitorImagesEnabled)
      .toEqual({ before: false, after: true, changed: true });
    expect(presentRevisionDetail(revision("candidate", { visitorImagesEnabled: false }), null).scopedChanges.visitorImagesEnabled)
      .toEqual({ before: false, after: false, changed: false });
  });
});

describe("what an agent write changes in its draft", () => {
  const draft = { customInstruction: "Be brief.", directives: [], routines: [], contextVariableEnablements: [] };

  it("writes the photo switch when it changes, and leaves a draft that takes no photos alone when it is saved off", () => {
    expect(agentDraftChange({ visitorImagesEnabled: true }, validateAgentInput({ visitorImagesEnabled: true }), draft)).toEqual({ ...draft, visitorImagesEnabled: true });
    expect(agentDraftChange({ visitorImagesEnabled: false }, validateAgentInput({ visitorImagesEnabled: false }), draft)).toBeNull();
    expect(agentDraftChange({ visitorImagesEnabled: false }, validateAgentInput({}), { ...draft, visitorImagesEnabled: true })).toEqual({ ...draft, visitorImagesEnabled: false });
  });

  it("writes the instruction whenever it is written, and nothing for a write that names neither", () => {
    expect(agentDraftChange({ customInstruction: "Be warm." }, validateAgentInput({ customInstruction: "Be warm." }), draft)).toEqual({ ...draft, customInstruction: "Be warm." });
    expect(agentDraftChange({ name: "Renamed" }, validateAgentInput({ name: "Renamed" }), draft)).toBeNull();
  });
});
