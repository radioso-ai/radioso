import { normalizeLlmClassifierLanguageLabel } from "./llmClassifierFields.js";

/**
 * The sentence a structured-generation prompt receives through `{{output_language_instruction}}`.
 *
 * Prompt wording alone does not reliably control output language, so callers detect the language
 * in code and pass the label here. The label is normalized with the same guard the response
 * language detector uses, so a model-produced label cannot smuggle instructions into the prompt.
 * `sourceText` names the input the output should mirror when no language was detected.
 */
export const renderOutputLanguageInstruction = (
  languageLabel: string | undefined,
  sourceText = "the purpose",
): string => {
  const language = normalizeLlmClassifierLanguageLabel(languageLabel);
  return language
    ? [
        `Write every user-facing field in ${language}.`,
        "Keep identifiers such as names, keys, and ids in the format their field rules require.",
      ].join(" ")
    : [
        `Write every user-facing field in the same language as ${sourceText}.`,
        `If ${sourceText} mixes languages, use the language most of it is written in.`,
      ].join(" ");
};
