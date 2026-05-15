import { z } from "zod";

import type { ChatGateway, SkillDefinition } from "../../radiosoModuleTypes.js";

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
      const response = await withTimeout(this.input.chatGateway.answer({
        query,
        history: [],
        prompt: [
          "Decide whether the user's message should start the configured skill intake.",
          "The user's message may be in any language. Match the user's meaning, not English keywords.",
          "Return compact JSON only: {\"shouldStart\": boolean}.",
          `Skill name: ${this.input.skill.name}`,
          `Skill description: ${this.input.skill.description}`,
          `Intent description: ${this.requireIntake().intent.description}`,
          `Intent examples: ${JSON.stringify(this.requireIntake().intent.examples)}`,
          `User message: ${query.slice(0, 1000)}`,
        ].join("\n"),
      }), this.timeoutMs, `Skill intake ${this.input.skill.name} intent prompt`);
      return parseIntakeStartDecision(response);
    } catch {
      return false;
    }
  }

  async extractFields(query: string): Promise<Record<string, unknown>> {
    try {
      const response = await withTimeout(this.input.chatGateway.answer({
        query,
        history: [],
        prompt: [
          "Extract any available field values from the user message for this skill intake.",
          "The user's message may be in any language. Extract by field meaning and format.",
          "Return compact JSON only: {\"fields\": {}}. Do not invent values.",
          `Skill name: ${this.input.skill.name}`,
          `Fields: ${JSON.stringify(this.requireIntake().fields.map((field) => ({
            name: field.name,
            type: field.type,
            required: field.required,
            extractionHint: field.extractionHint,
          })))}`,
          `User message: ${query.slice(0, 1000)}`,
        ].join("\n"),
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
    const instruction = input.kind === "missing"
      ? `Ask the user for the missing field "${fieldDisplayName}". Ask only for that one field.`
      : input.kind === "invalid"
        ? `Tell the user that the "${fieldDisplayName}" value did not pass validation and ask them to send a valid value. Ask only for that one field.`
        : input.kind === "failed"
          ? "Tell the user that the request could not be submitted right now and they can try again later."
          : "Tell the user that the request was received and will be sent to the team.";
    const response = await withTimeout(this.input.chatGateway.answer({
      query: input.languageContext ?? input.kind,
      history: [],
      prompt: [
        instruction,
        "Use one concise sentence.",
        input.userExpectedLocale
          ? `Reply in locale ${input.userExpectedLocale}.`
          : input.languageContext
            ? "Reply in the same language as the language context."
            : "Reply in the same language as the user's most recent message when possible.",
        input.languageContext
          ? `Language context: ${input.languageContext.slice(0, 1000)}`
          : null,
      ].filter((line): line is string => Boolean(line)).join("\n"),
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
