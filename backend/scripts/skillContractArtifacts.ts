import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createOpenApiDocument } from "../src/app/http/openapi/document.js";

export const retrievalAnswerGeneratedContractPath = path.resolve(
  new URL("../src/modules/skills/definitions/retrieval.answer/generated.contract.json", import.meta.url).pathname,
);

const schemaNames = [
  "RetrievalAnswerRequest",
  "RetrievalSearchRequest",
  "RetrievalSettingsOverride",
] as const;

type SchemaName = (typeof schemaNames)[number];

export interface GeneratedSkillContract {
  generatedFrom: {
    openApiComponentSchemas: SchemaName[];
  };
  inputSchema: {
    $ref: string;
  };
  settingsSchema: {
    $ref: string;
  };
  schemas: Record<string, unknown>;
}

const getRequiredSchema = (
  schemas: Record<string, unknown>,
  name: SchemaName,
): unknown => {
  const schema = schemas[name];
  if (!schema) {
    throw new Error(`OpenAPI schema "${name}" is missing`);
  }
  return schema;
};

export const buildRetrievalAnswerGeneratedContract = (): GeneratedSkillContract => {
  const document = createOpenApiDocument();
  const openApiSchemas = document.components?.schemas ?? {};

  return {
    generatedFrom: {
      openApiComponentSchemas: [...schemaNames],
    },
    inputSchema: {
      $ref: "#/schemas/RetrievalAnswerRequest",
    },
    settingsSchema: {
      $ref: "#/schemas/RetrievalSettingsOverride",
    },
    schemas: {
      RetrievalAnswerRequest: getRequiredSchema(openApiSchemas, "RetrievalAnswerRequest"),
      RetrievalSearchRequest: getRequiredSchema(openApiSchemas, "RetrievalSearchRequest"),
      RetrievalSettingsOverride: getRequiredSchema(openApiSchemas, "RetrievalSettingsOverride"),
    },
  };
};

export const serializeGeneratedSkillContract = (contract: GeneratedSkillContract): string =>
  `${JSON.stringify(contract, null, 2)}\n`;

export const writeRetrievalAnswerGeneratedContract = async (): Promise<void> => {
  await mkdir(path.dirname(retrievalAnswerGeneratedContractPath), { recursive: true });
  await writeFile(
    retrievalAnswerGeneratedContractPath,
    serializeGeneratedSkillContract(buildRetrievalAnswerGeneratedContract()),
    "utf8",
  );
};

export const isRetrievalAnswerGeneratedContractCurrent = async (): Promise<boolean> => {
  const expected = serializeGeneratedSkillContract(buildRetrievalAnswerGeneratedContract());
  const actual = await readFile(retrievalAnswerGeneratedContractPath, "utf8").catch(() => "");
  return actual === expected;
};
