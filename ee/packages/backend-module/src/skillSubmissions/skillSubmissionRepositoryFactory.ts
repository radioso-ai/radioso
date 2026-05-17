import type { SkillDefinition, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { SkillSubmissionRepository, type SkillSubmissionRepositoryOptions } from "./skillSubmissionRepository.js";

export const createSkillSubmissionRepository = (
  database: UsageLimitDatabasePort,
  definitions: SkillDefinition[] = [],
  options: SkillSubmissionRepositoryOptions = {},
): SkillSubmissionRepository => new SkillSubmissionRepository(database, definitions, options);
