import { describe, expect, it } from "vitest";

import { createExternalSkillsApplicationModule } from "../../../src/app/composition/builtIn/externalSkillsModule.js";
import {
  EXTERNAL_SKILLS_ADAPTER,
  type McpSkillExecutorDeps,
} from "../../../src/modules/externalSkills/executor/mcpSkillExecutor.js";

const fakeDeps: McpSkillExecutorDeps = {
  skills: { findEnabledByName: async () => null },
  connections: { findById: async () => null },
  toolServices: {
    create: () => ({ listTools: async () => [], callTool: async () => ({ status: "completed" as const }) }),
  },
};

describe("createExternalSkillsApplicationModule", () => {
  it("registers the MCP skill executor under the external-skills internal adapter", () => {
    const registrations: Array<{ kind: string; adapter?: string; executor: { dispatch: unknown } }> = [];
    const module = createExternalSkillsApplicationModule(fakeDeps);

    expect(module.id).toBe("radioso-external-skills");

    module.register({
      registerSkillExecutor: (registration) => registrations.push(registration),
    } as never);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER });
    expect(typeof registrations[0]?.executor.dispatch).toBe("function");
  });
});
