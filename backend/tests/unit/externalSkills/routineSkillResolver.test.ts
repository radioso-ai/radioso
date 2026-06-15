import { describe, expect, it } from "vitest";

import {
  ExternalSkillRoutineSkillResolver,
  externalSkillRoutineDefinition,
} from "../../../src/modules/externalSkills/routineSkillResolver.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../../src/modules/externalSkills/executor/mcpSkillExecutor.js";

describe("ExternalSkillRoutineSkillResolver", () => {
  it("returns an external-skills execution definition for a routine skill name", () => {
    const definition = externalSkillRoutineDefinition("handoff_slack");

    expect(definition.name).toBe("handoff_slack");
    expect(definition.execution).toEqual({
      kind: "internal",
      adapter: EXTERNAL_SKILLS_ADAPTER,
      enqueue: false,
    });
  });

  it("resolves arbitrary names because the executor owns the per-agent allow-list", () => {
    const resolver = new ExternalSkillRoutineSkillResolver();

    expect(resolver.resolve("not_authored_here")?.name).toBe("not_authored_here");
  });
});
