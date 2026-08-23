import type { DocumentTypeDefinition } from "../contracts/documentTypeCatalog.js";
import { builtInPromptClause } from "./builtInDocumentTypes.js";

/**
 * Ceiling for the catalog section spliced into the classification prompt. It
 * bounds prompt growth on top of the document representation cap, and is
 * enforced at save time so a runtime render can never surprise the operator.
 */
export const DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET = 12_000;

/** The union of valid type keys, rendered into the JSON skeleton of the prompt. */
export const renderDocumentTypeKeyUnion = (types: readonly DocumentTypeDefinition[]): string =>
  types.map((type) => `"${type.key}"`).join(" | ");

const joinClauses = (clauses: readonly string[]): string => {
  if (clauses.length === 0) {
    return "";
  }
  if (clauses.length === 1) {
    return `Use ${clauses[0]}.`;
  }
  if (clauses.length === 2) {
    return `Use ${clauses[0]} and ${clauses[1]}.`;
  }
  return `Use ${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}.`;
};

const renderField = (field: DocumentTypeDefinition["fields"][number]): string =>
  `  - \`${field.key}\` (${field.valueType}): ${field.instruction}`;

const renderOperatorType = (type: DocumentTypeDefinition): string => {
  const header = `- \`${type.key}\` (${type.label}): ${type.description}`;
  if (type.fields.length === 0) {
    return header;
  }
  return [header, "  Fields:", ...type.fields.map(renderField)].join("\n");
};

/**
 * Renders the enabled catalog into the classification prompt section.
 *
 * Built-in entries contribute their shipped clause to a single sentence, so the
 * default catalog renders exactly the sentence the prompt has always carried.
 * Operator types are listed separately with the payload contract they use.
 */
export const renderDocumentTypeCatalogSection = (types: readonly DocumentTypeDefinition[]): string => {
  const builtIns = types.filter((type) => type.origin === "built_in");
  const operatorTypes = types.filter((type) => type.origin === "operator");

  const clauses = builtIns
    .map((type) => builtInPromptClause(type.key))
    .filter((clause): clause is string => Boolean(clause));

  const sections = [joinClauses(clauses)].filter(Boolean);

  if (operatorTypes.length > 0) {
    sections.push(
      [
        "These operator-defined types classify the same way; return the type key exactly as written:",
        ...operatorTypes.map(renderOperatorType),
      ].join("\n"),
    );
    sections.push(
      'When the matched type is operator-defined, return "fields" instead of "facts": an ordered array of {"key": string, "value": string | number | boolean} entries. Omit fields the document does not support, never repeat a key, and format date values as YYYY-MM-DD.',
    );
  }

  return sections.join("\n\n");
};
