import { describe, expect, it } from "vitest";

import { agentSkillKinds, type AgentSkillKind } from "../../../src/modules/agentSkills/public.js";
import { createDefaultSkillCapabilityRegistry } from "../../../src/modules/skills/capabilityRegistry.js";
import { createRoutineSkillResolverChain } from "../../../src/modules/routines/public.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../../src/modules/externalSkills/public.js";

/**
 * Regression guard for the class of bug fixed alongside this test: authoring-time
 * availability (`SkillAuthoringCatalogService`) and runtime resolvability (the
 * resolver chain `createRoutineSkillResolverChain` wires) are two independently
 * maintained lists. `notify` diverged silently — cataloged for authoring, unresolved
 * at runtime, so every notify routine tool step failed closed through the
 * external-MCP tail.
 *
 * `chainFor` calls the real production factory (`routineSkillResolverChain.ts`),
 * the same one `createRoutineTurnProvider.forTurn` calls in `turnProvider.ts` — not
 * a hand-built copy of it. That means this test now also catches
 * `createRoutineSkillResolverChain` wiring a resolver in the wrong place or
 * dropping one, not just a kind newly added to the catalog with no resolver
 * anywhere. The integration test in
 * `tests/integration/notify/notify-skill-routine-dispatch.test.ts` still exercises
 * the real production classes end to end for the notify case specifically.
 */
const chainFor = (kindToName: Partial<Record<AgentSkillKind, string>>) =>
  createRoutineSkillResolverChain({
    webhookSkillNames: kindToName.webhook ? [kindToName.webhook] : [],
    emailSkillNames: kindToName.customer_email ? [kindToName.customer_email] : [],
    slackSkillNames: kindToName.slack ? [kindToName.slack] : [],
    retrieveSkills: kindToName.retrieve
      ? [{ skillName: kindToName.retrieve, enabled: true, invocationMode: "routine_named" }]
      : [],
    notifySkills: kindToName.notify
      ? [{ skillName: kindToName.notify, enabled: true, invocationMode: "routine_named" }]
      : [],
  });

describe("routine authoring/runtime resolver parity", () => {
  const capabilities = createDefaultSkillCapabilityRegistry();

  // Mirrors the filter `SkillAuthoringCatalogService.agentSkillDescriptors` applies
  // (skillAuthoringCatalog.ts): every agent-skill kind except external_mcp, whose
  // capability declares routine_named support, is offered to routine authors.
  const catalogOfferedKinds = agentSkillKinds.filter((kind) => {
    if (kind === "external_mcp") return false;
    return capabilities.getByStoredKind(kind)?.supportedInvocationModes.includes("routine_named") ?? false;
  });

  it("offers every non-external_mcp agent-skill kind whose capability supports routine_named", () => {
    // Pinned so a newly added kind shows up in the diff instead of silently
    // joining the parametrized cases below with no reviewer noticing.
    expect([...catalogOfferedKinds].sort()).toEqual(["customer_email", "notify", "retrieve", "slack", "webhook"]);
  });

  it.each(catalogOfferedKinds.map((kind) => [kind] as const))(
    "resolves a catalog-offered %s skill to something other than the external-MCP tail",
    (kind) => {
      const skillName = `${kind}_test_skill`;
      const chain = chainFor({ [kind]: skillName });

      const resolved = chain.resolve(skillName);

      expect(resolved).not.toBeNull();
      expect(resolved?.execution?.kind).toBe("internal");
      if (resolved?.execution?.kind === "internal") {
        expect(resolved.execution.adapter).not.toBe(EXTERNAL_SKILLS_ADAPTER);
      }
    },
  );

  it("resolves external_mcp through the tail by design (the one intentional exception)", () => {
    expect(catalogOfferedKinds).not.toContain("external_mcp");

    const chain = chainFor({});
    const resolved = chain.resolve("any_external_mcp_skill_name");

    expect(resolved?.execution).toMatchObject({ kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER });
  });
});
