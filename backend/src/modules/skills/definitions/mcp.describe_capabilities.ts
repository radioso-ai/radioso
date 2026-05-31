import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const mcpDescribeCapabilitiesSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./mcp.describe_capabilities/", import.meta.url),
);
