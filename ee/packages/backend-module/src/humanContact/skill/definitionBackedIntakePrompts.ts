import { z } from "zod";

import type { ChatGateway, SkillDefinition } from "../../radiosoModuleTypes.js";
import {
  loadPromptTemplate,
  renderPromptSection,
  renderPromptTemplate,
} from "../../shared/promptLoader.js";

const INTENT_CHECK_TEMPLATE = "humanContact/intake-intent-check.md";
const FIELD_EXTRACTION_TEMPLATE = "humanContact/intake-field-extraction.md";
const ANSWER_TEMPLATE = "humanContact/intake-answer.md";

const DEFAULT_INTAKE_PROMPT_TIMEOUT_MS = 5_000;

const emailFieldSchema = z.string().trim().email().max(320);

export const normalizeEmailField = (value: unknown): string | null => {
  const parsed = emailFieldSchema.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isChatGateway = (value: unknown): value is ChatGateway =>
  isObject(value) && typeof value.answer === "function";

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const parseIntakeStartDecision = (value: string): boolean => {
  try {
    const parsed = JSON.parse(value) as { shouldStart?: unknown };
    return parsed.shouldStart === true;
  } catch {
    return false;
  }
};

const parseExtractedFieldMap = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isObject(parsed)) {
      return {};
    }
    if (isObject(parsed.fields)) {
      return parsed.fields;
    }
    return parsed;
  } catch {
    return {};
  }
};

export class DefinitionBackedIntakePrompts {
  constructor(private readonly input: {
    skill: SkillDefinition;
    chatGateway: ChatGateway;
    timeoutMs?: number;
  }) {
    if (!isChatGateway(input.chatGateway)) {
      throw new Error(`Skill intake ${input.skill.name} requires a chat gateway.`);
    }
  }

  private get timeoutMs(): number {
    return this.input.timeoutMs ?? DEFAULT_INTAKE_PROMPT_TIMEOUT_MS;
  }

  async shouldStart(query: string): Promise<boolean> {
    try {
      const prompt = renderPromptTemplate(loadPromptTemplate(INTENT_CHECK_TEMPLATE), {
        skill_name: this.input.skill.name,
        skill_description: this.input.skill.description,
        intent_description: this.requireIntake().intent.description,
        intent_examples: JSON.stringify(this.requireIntake().intent.examples),
        user_message: query.slice(0, 1000),
      });
      const response = await withTimeout(this.input.chatGateway.answer({
        query,
        history: [],
        prompt,
      }), this.timeoutMs, `Skill intake ${this.input.skill.name} intent prompt`);
      return parseIntakeStartDecision(response);
    } catch {
      return false;
    }
  }

  async extractFields(query: string): Promise<Record<string, unknown>> {
    try {
      const fields = this.requireIntake().fields.map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
        extractionHint: field.extractionHint,
      }));
      const prompt = renderPromptTemplate(loadPromptTemplate(FIELD_EXTRACTION_TEMPLATE), {
        skill_name: this.input.skill.name,
        fields: JSON.stringify(fields),
        user_message: query.slice(0, 1000),
      });
      const response = await withTimeout(this.input.chatGateway.answer({
        query,
        history: [],
        prompt,
      }), this.timeoutMs, `Skill intake ${this.input.skill.name} extraction prompt`);
      return parseExtractedFieldMap(response);
    } catch {
      return {};
    }
  }

  async composeAnswer(input: {
    kind: "missing" | "invalid" | "submitted" | "failed";
    fieldName?: string;
    languageContext?: string | null;
    userExpectedLocale?: string | null;
  }): Promise<string> {
    const field = input.fieldName
      ? this.requireIntake().fields.find((candidate) => candidate.name === input.fieldName)
      : null;
    const fieldDisplayName = field?.displayName ?? input.fieldName ?? "field";

    const kindInstruction = renderPromptSection(ANSWER_TEMPLATE, `kind.${input.kind}`, {
      field_display_name: fieldDisplayName,
    });

    let languageInstruction: string;
    if (input.languageContext) {
      languageInstruction = renderPromptSection(ANSWER_TEMPLATE, "language.with_context", {
        anchor_message: input.languageContext.slice(0, 500),
      });
    } else if (input.userExpectedLocale) {
      languageInstruction = renderPromptSection(ANSWER_TEMPLATE, "language.with_locale", {
        user_expected_locale: input.userExpectedLocale,
      });
    } else {
      languageInstruction = renderPromptSection(ANSWER_TEMPLATE, "language.default", {});
    }

    const localeFallback = input.languageContext && input.userExpectedLocale
      ? renderPromptSection(ANSWER_TEMPLATE, "locale_fallback", {
          user_expected_locale: input.userExpectedLocale,
        })
      : "";

    const needsReceiptTag = input.kind === "submitted" || input.kind === "failed";
    const receiptInstruction = needsReceiptTag
      ? renderPromptSection(ANSWER_TEMPLATE, "receipt_block", {
          receipt_status_hint: renderPromptSection(
            ANSWER_TEMPLATE,
            `receipt.status.${input.kind}`,
            {},
          ),
          receipt_field_names_json: JSON.stringify(
            this.requireIntake().fields.map((entry) => entry.name),
          ),
          receipt_field_examples_json: JSON.stringify(
            this.requireIntake().fields.map((entry) => entry.displayName),
          ),
        })
      : "";

    const prompt = renderPromptSection(ANSWER_TEMPLATE, "prompt", {
      kind_instruction: kindInstruction,
      language_instruction: languageInstruction,
      locale_fallback: localeFallback,
      receipt_instruction: receiptInstruction,
      skill_display_name: this.input.skill.displayName,
    });

    const response = await withTimeout(this.input.chatGateway.answer({
      query: input.languageContext ?? input.kind,
      history: [],
      prompt,
    }), this.timeoutMs, `Skill intake ${this.input.skill.name} answer prompt`);
    const trimmed = response.trim();
    if (!trimmed) {
      throw new Error(`Skill intake answer generation failed for ${this.input.skill.name}.`);
    }
    return trimmed;
  }

  private requireIntake() {
    if (!this.input.skill.intake) {
      throw new Error(`Skill ${this.input.skill.name} is missing intake metadata.`);
    }
    return this.input.skill.intake;
  }
}
