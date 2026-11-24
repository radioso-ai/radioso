/**
 * The typed data contract a skill declares: value types and their coercion, declared outputs,
 * their projection from a response and the check against it, and the contract the model reads.
 * Pure: it knows nothing about HTTP, MCP, routines, turns or connections.
 */
export { coerceSkillValue, skillDataValueTypes } from "./values.js";
export {
  checkSkillOutputs,
  readJsonPath,
  skillOutputContractFor,
  skillOutputsSchema,
  type SkillOutputDeclarations,
} from "./outputs.js";
