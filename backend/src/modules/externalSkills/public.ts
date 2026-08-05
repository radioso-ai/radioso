// Public entrypoint for the externalSkills module. Cross-module consumers (e.g. the skills
// capability registry) import the adapter key and the bound/exposed param schemas from here
// rather than reaching into module internals.
export { EXTERNAL_SKILLS_ADAPTER } from "./executor/mcpSkillExecutor.js";
export {
  boundParamsSchema,
  exposedParamsSchema,
  type McpAuthMethod,
} from "./domain.js";
export { ExternalSkillRoutineSkillResolver, externalSkillRoutineDefinition } from "./routineSkillResolver.js";
