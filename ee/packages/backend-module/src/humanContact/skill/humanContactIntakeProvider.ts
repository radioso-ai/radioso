import { createHash, randomUUID } from "node:crypto";

import type {
  ChatIntakeProvider,
  ChatIntakeReceipt,
  ChatIntakeResult,
} from "../../radiosoModuleTypes.js";
import { humanContactRequestSkillDefinition } from "./definition.js";
import { DefinitionBackedIntakePrompts, normalizeEmailField } from "./definitionBackedIntakePrompts.js";
import { buildContactStage, buildContactTrace } from "../contactActivityTrace.js";
import type { HumanContactRequestExecutor } from "../contactRequestExecutor.js";
import type { HumanContactSettingsService } from "../contactSettingsService.js";
import type {
  SkillIntakeStateRow,
} from "../humanContactTypes.js";
import {
  HUMAN_CONTACT_INTAKE_TTL_MS,
  HUMAN_CONTACT_SKILL_NAME,
  contactIntakeIdempotencyKey,
  queryRows,
} from "../humanContactTypes.js";
import type { ChatGateway, UsageLimitDatabasePort } from "../../radiosoModuleTypes.js";

type ChatIntakeInput = Parameters<ChatIntakeProvider["handle"]>[0];

const looksLikeEmailCandidate = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.includes("@") && trimmed.length <= 320 && !Array.from(trimmed).some((character) => character.trim() === "");
};

const asksAboutEmbeddedEmail = (value: string): boolean =>
  value.includes("?") || value.includes("？");

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeCollected = (value: unknown): Record<string, unknown> =>
  isObject(value) ? value : {};

export const resolveLanguageContext = (input: ChatIntakeInput, _collected?: Record<string, unknown>): string => {
  // Anchor language on the user's earliest natural-language message in this conversation.
  // We deliberately ignore `collected.message` because it is the auto-built contact-request draft
  // ("Contact request:\n...") whose English boilerplate would mislead the LLM on follow-up turns,
  // and we ignore short answer-only turns like "test@test" that carry no language signal.
  const earliestUserMessage = input.history.find((message) => message.role === "user")?.content?.trim();
  return earliestUserMessage || input.query;
};

const buildFallbackDraft = (input: ChatIntakeInput): { draftMessage: string } => {
  const currentUserMessage = [...input.history]
    .reverse()
    .find((message) => message.id === input.userMessageId || (message.role === "user" && message.content.trim() === input.query.trim()))
    ?.content
    .trim() || input.query.trim();
  const priorMessages = input.history.filter((message) =>
    message.id !== input.userMessageId && message.content.trim().length > 0
  );
  const latestPriorUserMessage = [...priorMessages]
    .reverse()
    .find((message) => message.role === "user")
    ?.content
    .trim();
  const priorUserMessages = priorMessages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const currentMessageIsEmail = Boolean(normalizeEmailField(currentUserMessage));

  if (priorMessages.length === 0) {
    const issue = currentUserMessage || "I need help with this conversation.";

    return {
      draftMessage: `Contact request:\n\n${issue}`.slice(0, 6000),
    };
  }

  const recentContext = priorMessages.slice(-6).map((message) => {
    const role = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
    return `${role}: ${message.content.trim()}`;
  }).join("\n");
  const issue = currentMessageIsEmail && priorUserMessages.length > 1
    ? priorUserMessages[priorUserMessages.length - 2]
    : latestPriorUserMessage || "I need help with this conversation.";
  const latestContactRequest = currentMessageIsEmail
    ? latestPriorUserMessage
    : currentUserMessage;

  return {
    draftMessage: [
      "Contact request:",
      `User issue:\n${issue}`,
      latestContactRequest ? `Latest contact request:\n${latestContactRequest}` : null,
      recentContext ? `Recent conversation before contact request:\n${recentContext}` : null,
    ].filter((part): part is string => Boolean(part)).join("\n\n").slice(0, 6000),
  };
};

const directSubmitIdempotencyKey = (input: {
  conversationId: string;
  email: string;
  requestText: string;
}): string => {
  const digest = createHash("sha256")
    .update(input.conversationId)
    .update("\0")
    .update(input.email.toLowerCase())
    .update("\0")
    .update(input.requestText.trim())
    .digest("hex");
  return contactIntakeIdempotencyKey(`direct:${digest}`);
};

const completedCollected = (requestId: string): Record<string, unknown> => ({
  submitted: true,
  requestId,
});

const buildContactReceipt = (input: { email: string }): ChatIntakeReceipt => ({
  fields: [
    {
      name: "email",
      displayName: "email address",
      value: input.email,
    },
  ],
});

const failedContactTrace = (reason: string) =>
  buildContactTrace([
    buildContactStage("request_submit", "request_submit", "Request submit", "failed", {
      reason,
    }),
  ], "request_submit_failed", "failed");

const submittedFallbackAnswer = "Your request was received and will be sent to the team.";
const failedFallbackAnswer = "Your request could not be submitted right now. Please try again later.";
const EXPLICIT_CONTACT_INTENT_NAME = "explicit_contact_request";

const hasHumanContactIntent = (input: ChatIntakeInput): boolean =>
  input.inputMetadata?.method === "intent_click" &&
  input.inputMetadata.intent?.skillName === HUMAN_CONTACT_SKILL_NAME;

export class HumanContactSkillIntakeProvider implements ChatIntakeProvider {
  private readonly intakePrompts: DefinitionBackedIntakePrompts;

  constructor(private readonly input: {
    database: UsageLimitDatabasePort;
    settingsService: HumanContactSettingsService;
    requestExecutor: HumanContactRequestExecutor;
    chatGateway: ChatGateway;
  }) {
    this.intakePrompts = new DefinitionBackedIntakePrompts({
      skill: humanContactRequestSkillDefinition,
      chatGateway: input.chatGateway,
    });
  }

  async handle(input: ChatIntakeInput): Promise<ChatIntakeResult | null> {
    const settings = await this.input.settingsService.findSettings(input.workspaceId);
    if (!settings.configured) {
      return null;
    }

    await this.expireStaleOpenIntakeStates(input.workspaceId, input.conversationId);
    const existingState = await this.findOpenIntakeState(input.workspaceId, input.conversationId);
    if (existingState) {
      return this.continueIntake(existingState, input);
    }

    const requestedByIntent = hasHumanContactIntent(input);
    if (!requestedByIntent && !await this.intakePrompts.shouldStart(input.query)) {
      return null;
    }

    const email = await this.extractEmailSlot(input.query);
    const message = buildFallbackDraft(input).draftMessage;
    const collected = {
      message,
      ...(email ? { email } : {}),
    };

    if (email) {
      const submitResult = await this.input.requestExecutor.submit({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        anonymousSessionId: input.anonymousSessionId,
        email,
        message,
        triggerSource: "explicit_user_request",
        triggerReason: requestedByIntent
          ? "The configured contact intake was started from a structured user intent."
          : "The configured contact intake was started from the user message.",
        idempotencyKey: directSubmitIdempotencyKey({
          conversationId: input.conversationId,
          email,
          requestText: input.query,
        }),
        sourceChannel: input.sourceChannel,
        sourceOrigin: input.sourceOrigin,
      }).catch(async (error) => {
        const failureAnswer = await this.composeAnswerOrFallback({
          kind: "failed",
          languageContext: resolveLanguageContext(input, collected),
          userExpectedLocale: input.userExpectedLocale,
        }, failedFallbackAnswer);
        const activityTrace = failedContactTrace(error instanceof Error ? error.message : "Contact request submit failed.");
        return {
          failed: true as const,
          result: {
            skillName: HUMAN_CONTACT_SKILL_NAME,
            status: "failed" as const,
            answer: failureAnswer,
            activityTrace,
            activitySummary: activityTrace.summary!,
          },
        };
      });
      if ("failed" in submitResult) {
        return submitResult.result;
      }
      const answer = await this.composeAnswerOrFallback({
        kind: "submitted",
        languageContext: resolveLanguageContext(input, collected),
        userExpectedLocale: input.userExpectedLocale,
      }, submittedFallbackAnswer);
      let state: SkillIntakeStateRow | null = null;
      try {
        state = await this.insertIntakeState({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          status: "completed",
          collected: completedCollected(submitResult.requestId),
          missing: [],
          lastPromptedField: null,
        });
      } catch {
        state = null;
      }
      return {
        skillName: HUMAN_CONTACT_SKILL_NAME,
        status: "completed",
        stateId: state?.id,
        answer,
        activityTrace: submitResult.activityTrace,
        activitySummary: submitResult.activityTrace.summary!,
        receipt: buildContactReceipt({ email }),
      };
    }

    const answer = await this.intakePrompts.composeAnswer({
      kind: "missing",
      fieldName: "email",
      languageContext: resolveLanguageContext(input, collected),
      userExpectedLocale: input.userExpectedLocale,
    });
    const state = await this.insertIntakeState({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      status: "active",
      collected: {},
      missing: ["email"],
      lastPromptedField: "email",
    });
    const activityTrace = buildContactTrace([
      buildContactStage("availability_check", "availability_check", "Availability check", "applied", {
        outputs: { configured: true },
      }),
      buildContactStage("intake_collect", "intake_collect", "Intake collect", "applied", {
        outputs: {
          stateId: state.id,
          missing: ["email"],
        },
      }),
    ], "intake_waiting_for_email", "pending");

    return {
      skillName: HUMAN_CONTACT_SKILL_NAME,
      status: "active",
      stateId: state.id,
      answer,
      activityTrace,
      activitySummary: activityTrace.summary!,
    };
  }

  private async continueIntake(
    state: SkillIntakeStateRow,
    input: ChatIntakeInput,
  ): Promise<ChatIntakeResult | null> {
    const collected = normalizeCollected(state.collected);
    const requestedByIntent = hasHumanContactIntent(input);
    const email = await this.extractEmailSlot(input.query);
    if (
      email &&
      !normalizeEmailField(input.query) &&
      asksAboutEmbeddedEmail(input.query) &&
      !requestedByIntent &&
      !await this.requireIntakePrompts().shouldStart(input.query)
    ) {
      await this.updateIntakeState(state.id, {
        status: "paused",
        collected,
        missing: state.missing,
        lastPromptedField: state.last_prompted_field,
      });
      return null;
    }
    if (state.status === "paused" && email && !requestedByIntent && !await this.requireIntakePrompts().shouldStart(input.query)) {
      return null;
    }

    if (!email) {
      if (state.last_prompted_field === "email" && looksLikeEmailCandidate(input.query)) {
        await this.updateIntakeState(state.id, {
          status: "active",
          collected,
          missing: ["email"],
          lastPromptedField: "email",
        });
        const answer = await this.requireIntakePrompts().composeAnswer({
          kind: "invalid",
          fieldName: "email",
          languageContext: resolveLanguageContext(input, collected),
          userExpectedLocale: input.userExpectedLocale,
        });
        const activityTrace = buildContactTrace([
          buildContactStage("intake_validate", "intake_validate", "Intake validate", "rejected", {
            reason: "Email field did not pass deterministic validation.",
            outputs: {
              missing: ["email"],
              invalid: ["email"],
            },
          }),
        ], "intake_invalid_email", "blocked");
        return {
          skillName: HUMAN_CONTACT_SKILL_NAME,
          status: "active",
          stateId: state.id,
          answer,
          activityTrace,
          activitySummary: activityTrace.summary!,
        };
      }

      if (requestedByIntent || await this.requireIntakePrompts().shouldStart(input.query)) {
        await this.updateIntakeState(state.id, {
          status: "active",
          collected,
          missing: ["email"],
          lastPromptedField: "email",
        });
        const answer = await this.requireIntakePrompts().composeAnswer({
          kind: "missing",
          fieldName: "email",
          languageContext: resolveLanguageContext(input, collected),
          userExpectedLocale: input.userExpectedLocale,
        });
        const activityTrace = buildContactTrace([
          buildContactStage("intake_collect", "intake_collect", "Intake collect", "applied", {
            reason: "The user repeated the configured contact intake intent while email was still missing.",
            outputs: {
              missing: ["email"],
            },
          }),
        ], "intake_waiting_for_email", "pending");
        return {
          skillName: HUMAN_CONTACT_SKILL_NAME,
          status: "active",
          stateId: state.id,
          answer,
          activityTrace,
          activitySummary: activityTrace.summary!,
        };
      }

      await this.updateIntakeState(state.id, {
        status: "paused",
        collected,
        missing: state.missing,
        lastPromptedField: state.last_prompted_field,
      });
      return null;
    }

    const message = typeof collected.message === "string" && collected.message.trim()
      ? collected.message.trim()
      : buildFallbackDraft(input).draftMessage;
    const nextCollected = {
      ...collected,
      email,
      message,
    };

    const submitResult = await this.input.requestExecutor.submit({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      anonymousSessionId: input.anonymousSessionId,
      email,
      message,
      triggerSource: "explicit_user_request",
      triggerReason: "The user completed a human-contact chat intake.",
      idempotencyKey: contactIntakeIdempotencyKey(state.id),
      sourceChannel: input.sourceChannel,
      sourceOrigin: input.sourceOrigin,
    }).catch(async (error) => {
      const failureAnswer = await this.composeAnswerOrFallback({
        kind: "failed",
        languageContext: resolveLanguageContext(input, nextCollected),
        userExpectedLocale: input.userExpectedLocale,
      }, failedFallbackAnswer);
      try {
        await this.updateIntakeState(state.id, {
          status: "failed",
          collected: {},
          missing: [],
          lastPromptedField: null,
        });
      } catch {
        // Submit failed already; state cleanup is best-effort so the user still gets the intake failure.
      }
      const activityTrace = failedContactTrace(error instanceof Error ? error.message : "Contact request submit failed.");
      return {
        failed: true as const,
        result: {
          skillName: HUMAN_CONTACT_SKILL_NAME,
          status: "failed" as const,
          stateId: state.id,
          answer: failureAnswer,
          activityTrace,
          activitySummary: activityTrace.summary!,
        },
      };
    });
    if ("failed" in submitResult) {
      return submitResult.result;
    }
    const answer = await this.composeAnswerOrFallback({
      kind: "submitted",
      languageContext: resolveLanguageContext(input, nextCollected),
      userExpectedLocale: input.userExpectedLocale,
    }, submittedFallbackAnswer);
    try {
      await this.updateIntakeState(state.id, {
        status: "completed",
        collected: completedCollected(submitResult.requestId),
        missing: [],
        lastPromptedField: null,
      });
    } catch {
      // The durable contact request is already queued. Do not convert that success into a failed chat turn.
    }

    return {
      skillName: HUMAN_CONTACT_SKILL_NAME,
      status: "completed",
      stateId: state.id,
      answer,
      activityTrace: submitResult.activityTrace,
      activitySummary: submitResult.activityTrace.summary!,
      receipt: buildContactReceipt({ email }),
    };
  }

  private async extractEmailSlot(query: string): Promise<string | null> {
    const direct = normalizeEmailField(query);
    if (direct) {
      return direct;
    }

    return normalizeEmailField((await this.requireIntakePrompts().extractFields(query)).email);
  }

  private requireIntakePrompts(): DefinitionBackedIntakePrompts {
    return this.intakePrompts;
  }

  async getPublicIntakeActions(input: { workspaceId: string }) {
    const settings = await this.input.settingsService.findSettings(input.workspaceId);
    return settings.configured
      ? [{
          skillName: HUMAN_CONTACT_SKILL_NAME,
          intentName: EXPLICIT_CONTACT_INTENT_NAME,
        }]
      : [];
  }

  private async composeAnswerOrFallback(
    input: Parameters<DefinitionBackedIntakePrompts["composeAnswer"]>[0],
    fallback: string,
  ): Promise<string> {
    try {
      return await this.requireIntakePrompts().composeAnswer(input);
    } catch {
      return fallback;
    }
  }

  private async expireStaleOpenIntakeStates(workspaceId: string, conversationId: string): Promise<void> {
    await queryRows(
      this.input.database,
      `UPDATE skill_intake_states
       SET status = 'expired',
           collected = '{}'::jsonb,
           invalid = '{}'::jsonb,
           missing = ARRAY[]::text[],
           last_prompted_field = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND conversation_id = $2
         AND skill_name = $3
         AND status IN ('active', 'paused', 'awaiting_confirmation', 'awaiting_tool')
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()`,
      [workspaceId, conversationId, HUMAN_CONTACT_SKILL_NAME],
    );
  }

  private async findOpenIntakeState(
    workspaceId: string,
    conversationId: string,
  ): Promise<SkillIntakeStateRow | null> {
    const [row] = await queryRows<SkillIntakeStateRow>(
      this.input.database,
      `SELECT id::text,
              workspace_id::text,
              conversation_id::text,
              skill_name,
              status,
              collected,
              invalid,
              missing,
              expires_at,
              last_prompted_field,
              created_at,
              updated_at
       FROM skill_intake_states
       WHERE workspace_id = $1
         AND conversation_id = $2
         AND skill_name = $3
         AND status IN ('active', 'paused', 'awaiting_confirmation', 'awaiting_tool')
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY updated_at DESC
       LIMIT 1`,
      [workspaceId, conversationId, HUMAN_CONTACT_SKILL_NAME],
    );
    return row ?? null;
  }

  private async insertIntakeState(input: {
    workspaceId: string;
    conversationId: string;
    status: SkillIntakeStateRow["status"];
    collected: Record<string, unknown>;
    missing: string[];
    lastPromptedField: string | null;
  }): Promise<SkillIntakeStateRow> {
    await this.expireStaleOpenIntakeStates(input.workspaceId, input.conversationId);
    const expiresAt = new Date(Date.now() + HUMAN_CONTACT_INTAKE_TTL_MS).toISOString();
    const [row] = await queryRows<SkillIntakeStateRow>(
      this.input.database,
      `INSERT INTO skill_intake_states (
         id,
         workspace_id,
         conversation_id,
         skill_name,
         status,
         collected,
         invalid,
         missing,
         expires_at,
         last_prompted_field
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7::text[], $8, $9)
       RETURNING id::text, workspace_id::text, conversation_id::text, skill_name, status, collected, invalid, missing, expires_at, last_prompted_field, created_at, updated_at`,
      [
        randomUUID(),
        input.workspaceId,
        input.conversationId,
        HUMAN_CONTACT_SKILL_NAME,
        input.status,
        JSON.stringify(input.collected),
        input.missing,
        expiresAt,
        input.lastPromptedField,
      ],
    );
    return row;
  }

  private async updateIntakeState(
    id: string,
    input: {
      status: SkillIntakeStateRow["status"];
      collected: Record<string, unknown>;
      missing: string[];
      lastPromptedField: string | null;
    },
  ): Promise<void> {
    await queryRows(
      this.input.database,
      `UPDATE skill_intake_states
       SET status = $2,
           collected = $3::jsonb,
           missing = $4::text[],
           last_prompted_field = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [id, input.status, JSON.stringify(input.collected), input.missing, input.lastPromptedField],
    );
  }
}
