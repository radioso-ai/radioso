import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { createSkillSubmissionRepository } from "../skillSubmissions/skillSubmissionRepositoryFactory.js";
import type {
  SkillSubmissionRepository,
  SkillSubmissionRepositoryOptions,
} from "../skillSubmissions/skillSubmissionRepository.js";
import { humanContactRequestSkillDefinition } from "./skill/definition.js";

const humanContactSkillSubmissionDefinitions = [
  humanContactRequestSkillDefinition,
];

export const createHumanContactSkillSubmissionRepository = (
  database: UsageLimitDatabasePort,
  options: SkillSubmissionRepositoryOptions = {},
): SkillSubmissionRepository => createSkillSubmissionRepository(database, humanContactSkillSubmissionDefinitions, options);
