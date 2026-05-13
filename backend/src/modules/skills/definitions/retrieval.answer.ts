import { readFileSync } from "node:fs";

import { skillDefinitionSchema, type SkillDefinition } from "../domain.js";

interface GeneratedSkillContract {
  schemas?: Record<string, unknown>;
}

const definitionRootUrl = new URL("./retrieval.answer/", import.meta.url);

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

const readGeneratedContractJson = (url: URL, skillName: string): unknown => {
  try {
    return readJson(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Generated contract for skill "${skillName}" is missing or invalid at ${url.pathname}. ` +
        `Run \`pnpm run generate:skills\` from backend/. Original error: ${message}`,
    );
  }
};

const validateGeneratedContractReferences = (definition: SkillDefinition): void => {
  const references = definition.schemaReferences;
  const generatedContract = definition.generatedContract;
  if (!references || !generatedContract) {
    return;
  }

  const contract = readGeneratedContractJson(
    new URL(generatedContract.path, definitionRootUrl),
    definition.name,
  ) as GeneratedSkillContract;
  const schemas = contract.schemas ?? {};
  const missingRefs = [
    references.inputSchemaRef,
    references.settingsSchemaRef,
  ].filter((ref): ref is string => Boolean(ref && !schemas[ref]));

  if (missingRefs.length > 0) {
    throw new Error(
      `Skill "${definition.name}" references missing generated contract schema(s): ${missingRefs.join(", ")}`,
    );
  }
};

const loadRetrievalAnswerSkillDefinition = (): SkillDefinition => {
  const parsed = skillDefinitionSchema.parse(readJson(new URL("skill.json", definitionRootUrl))) as SkillDefinition;
  validateGeneratedContractReferences(parsed);
  return parsed;
};

export const retrievalAnswerSkillDefinition: SkillDefinition = loadRetrievalAnswerSkillDefinition();
