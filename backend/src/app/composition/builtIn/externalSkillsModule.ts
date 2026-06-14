import {
  EXTERNAL_SKILLS_ADAPTER,
  McpSkillExecutor,
  type McpSkillExecutorDeps,
} from "../../../modules/externalSkills/executor/mcpSkillExecutor.js";
import type { ApplicationModule } from "../applicationModule.js";

/**
 * Registers the generic MCP skill executor under the `external-skills` internal
 * adapter. All authored external skill definitions carry an execution descriptor
 * of `{ kind: "internal", adapter: "external-skills" }`, so the skill-executor
 * registry routes them here; the executor then resolves the named binding and
 * dispatches through the unchanged `ToolSkillBridge`.
 *
 * Composition only assembles: the executor's ports (connection + skill-definition
 * lookups and the per-connection ToolService factory) are injected by the caller,
 * keeping all product rules inside `backend/src/modules/externalSkills/`.
 */
export const createExternalSkillsApplicationModule = (deps: McpSkillExecutorDeps): ApplicationModule => ({
  id: "radioso-external-skills",
  name: "Radioso External Skills (MCP)",
  register(context) {
    context.registerSkillExecutor({
      kind: "internal",
      adapter: EXTERNAL_SKILLS_ADAPTER,
      executor: new McpSkillExecutor(deps),
    });
  },
});
