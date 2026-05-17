import { humanContactRequestSkillDefinition } from "../humanContact/skill/definition.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { SkillSubmissionRepository, type SkillSubmissionRepositoryOptions } from "./skillSubmissionRepository.js";

const registeredSkillSubmissionDefinitions = [
  humanContactRequestSkillDefinition,
];

export const createSkillSubmissionRepository = (
  database: UsageLimitDatabasePort,
  options: SkillSubmissionRepositoryOptions = {},
): SkillSubmissionRepository => new SkillSubmissionRepository(database, registeredSkillSubmissionDefinitions, options);
