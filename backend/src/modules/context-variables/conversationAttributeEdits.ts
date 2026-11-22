import { AppError, badRequest, notFound } from "../../shared/domain/errors.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { ConversationAttribute, ConversationAttributeReader } from "./conversationAttributes.js";
import type { ContextValueWriter, ContextVariable, ConversationScopeKeys } from "./domain.js";
import type { ContextVariableRepositoryPort } from "./repository.js";
import { validateValue } from "./valueValidation.js";

export const CONVERSATION_ATTRIBUTE_EDITS_TOTAL = "radioso_conversation_attribute_edits_total";

export type AttributeEditAction = "set" | "reset";

/** Where a teammate made the edit: the Inbox, Ray in the dashboard, or an operator MCP client. */
export type AttributeEditSurface = "inbox" | "ray" | "mcp";

/** The signed-in teammate who sets or resets a value; their user id is the value's writer reference. */
export interface AttributeEditActor {
  readonly accountId: string;
  readonly userId: string;
  readonly surface: AttributeEditSurface;
}

/** What an edit leaves the conversation reading. */
export interface ConversationAttributeEditResult {
  /**
   * The attribute as the conversation reads it now: the value just set, or after a reset what the
   * visitor's session or customer holds. Null when none of the conversation's rungs holds one.
   */
  readonly attribute: ConversationAttribute | null;
  /** True when a reset handed the attribute back to the AI and a run to fill it is queued. */
  readonly classificationQueued: boolean;
}

/** What an edit reads before it writes. */
export interface ConversationAttributeEditReads {
  /** The variable whose stored name is exactly `name`. */
  findByName(workspaceId: string, name: string): Promise<ContextVariable | null>;
  /** The keys of the conversation's own rungs; null when the workspace has no such conversation. */
  readConversationKeys(workspaceId: string, conversationId: string): Promise<ConversationScopeKeys | null>;
  /** The variables the agent release the conversation runs classifies. */
  readClassifiedVariableIds(workspaceId: string, conversationId: string): Promise<ReadonlySet<string>>;
}

/** Asks the AI to fill a conversation's classified attributes now, rather than after a turn that may never come. */
export interface ConversationReclassification {
  request(input: { workspaceId: string; conversationId: string }): Promise<void>;
}

/** Records an edit with no value in it: which attribute of which conversation, the action and the teammate. */
export interface AttributeEditAudit {
  record(entry: {
    workspaceId: string;
    conversationId: string;
    variableId: string;
    action: AttributeEditAction;
    actor: AttributeEditActor;
  }): Promise<void>;
}

/** A teammate's edits of one conversation's attributes, from the Inbox, Ray and operator MCP alike. */
export interface ConversationAttributeEdits {
  set(input: { workspaceId: string; conversationId: string; name: string; value: unknown; actor: AttributeEditActor }): Promise<ConversationAttributeEditResult>;
  reset(input: { workspaceId: string; conversationId: string; name: string; actor: AttributeEditActor }): Promise<ConversationAttributeEditResult>;
}

type EditOutcome = "written" | "cleared" | "unchanged" | "not_found" | "refused_type" | "refused_private" | "refused_option" | "failed";

/** A refusal that carries its own outcome label, so the counter never reads the message. */
class EditRefusal extends AppError {
  constructor(readonly outcome: Exclude<EditOutcome, "written" | "cleared" | "unchanged" | "failed">, error: AppError) {
    super(error.statusCode, error.code, error.message, error.details);
  }
}

/**
 * A teammate edits the Choice attributes they can see. A Private value is hidden from them, so they
 * neither overwrite nor clear what they can't read; the host sets it through the values API.
 */
const editableVariable = (variable: ContextVariable | null, name: string): ContextVariable => {
  if (!variable) throw new EditRefusal("not_found", notFound(`No attribute is named ${name}`));
  if (variable.sensitivity === "sensitive") {
    throw new EditRefusal("refused_private", new AppError(400, "attribute_not_editable",
      `${variable.name} is Private: a teammate never sees its value, so it is set and cleared only through the values API`, { reason: "private" }));
  }
  if (variable.valueType !== "enum") {
    throw new EditRefusal("refused_type", new AppError(400, "attribute_not_editable",
      `Only a Choice attribute is set from a conversation; ${variable.name} is not one`, { reason: "not_choice" }));
  }
  return variable;
};

const optionRefusal = (variable: ContextVariable, value: unknown): EditRefusal => {
  // Callers often pass the label they see in the Inbox; naming the keys lets them retry.
  const keys = (variable.options ?? []).filter((option) => !option.archived).map((option) => option.key).join(", ");
  const named = typeof value === "string" ? `option ${value}` : "such option";
  return new EditRefusal("refused_option", badRequest(`${variable.name} has no active ${named}; its option keys are ${keys}`));
};

const operatorWriter = (actor: AttributeEditActor): ContextValueWriter => ({ kind: "operator", ref: actor.userId });

/**
 * Sets and resets a conversation's own value of an attribute for a teammate. A set writes the option
 * with the teammate as its writer, which the classifier never replaces. A reset deletes the
 * conversation's value: when the conversation's release classifies the attribute, it asks the AI to
 * fill it now, since the conversation may have ended. The value write records `context_value.changed`
 * in its own transaction; the audit event comes after it and names no value. Each edit is counted by
 * action and outcome, never by attribute or value.
 */
export class ConversationAttributeEditService implements ConversationAttributeEdits {
  constructor(private readonly deps: {
    reads: ConversationAttributeEditReads;
    attributes: ConversationAttributeReader;
    values: Pick<ContextVariableRepositoryPort, "upsertValue" | "deleteValue">;
    reclassification: ConversationReclassification;
    audit: AttributeEditAudit;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger?: Pick<AppLogger, "warn"> | null;
  }) {}

  set(input: Parameters<ConversationAttributeEdits["set"]>[0]): Promise<ConversationAttributeEditResult> {
    return this.counted("set", async () => {
      const { variable, keys } = await this.target(input);
      if (!validateValue(variable, input.value).ok) throw optionRefusal(variable, input.value);
      await this.deps.values.upsertValue(variable.id, { type: "conversation", id: input.conversationId }, input.value, operatorWriter(input.actor));
      await this.audit({ workspaceId: input.workspaceId, conversationId: input.conversationId, variableId: variable.id, action: "set", actor: input.actor });
      return { outcome: "written", result: { attribute: await this.readBack(input, keys), classificationQueued: false } };
    });
  }

  reset(input: Parameters<ConversationAttributeEdits["reset"]>[0]): Promise<ConversationAttributeEditResult> {
    return this.counted("reset", async () => {
      const { variable, keys } = await this.target(input);
      const cleared = await this.deps.values.deleteValue(variable.id, { type: "conversation", id: input.conversationId }, operatorWriter(input.actor));
      if (!cleared) return { outcome: "unchanged", result: { attribute: await this.readBack(input, keys), classificationQueued: false } };
      await this.audit({ workspaceId: input.workspaceId, conversationId: input.conversationId, variableId: variable.id, action: "reset", actor: input.actor });
      const classified = await this.deps.reads.readClassifiedVariableIds(input.workspaceId, input.conversationId);
      const classificationQueued = classified.has(variable.id) && await this.reclassify(input);
      return { outcome: "cleared", result: { attribute: await this.readBack(input, keys), classificationQueued } };
    });
  }

  private async target(input: { workspaceId: string; conversationId: string; name: string }) {
    const variable = editableVariable(await this.deps.reads.findByName(input.workspaceId, input.name), input.name);
    const keys = await this.deps.reads.readConversationKeys(input.workspaceId, input.conversationId);
    if (!keys) throw new EditRefusal("not_found", notFound("Conversation not found"));
    return { variable, keys };
  }

  private async readBack(input: { workspaceId: string; name: string }, keys: ConversationScopeKeys): Promise<ConversationAttribute | null> {
    return (await this.deps.attributes.read(input.workspaceId, keys)).find((attribute) => attribute.name === input.name) ?? null;
  }

  private async reclassify(input: { workspaceId: string; conversationId: string }): Promise<boolean> {
    try {
      await this.deps.reclassification.request({ workspaceId: input.workspaceId, conversationId: input.conversationId });
      return true;
    } catch (error) {
      // The reset has committed; the AI fills the attribute after the conversation's next turn instead.
      this.deps.logger?.warn(
        { event: "conversation_attribute_reclassification_failed", workspaceId: input.workspaceId, conversationId: input.conversationId, err: error },
        "Reset a conversation's attribute but could not queue the AI to fill it",
      );
      return false;
    }
  }

  private async audit(entry: Parameters<AttributeEditAudit["record"]>[0]): Promise<void> {
    const { workspaceId, conversationId, variableId, action } = entry;
    try {
      await this.deps.audit.record(entry);
    } catch (error) {
      // The edit has committed, and a retry would edit again: a lost audit row is logged, not thrown.
      this.deps.logger?.warn(
        { event: "conversation_attribute_edit_audit_failed", workspaceId, conversationId, variableId, action, err: error },
        "Edited a conversation's attribute but could not audit it",
      );
    }
  }

  private async counted(
    action: AttributeEditAction,
    edit: () => Promise<{ outcome: EditOutcome; result: ConversationAttributeEditResult }>,
  ): Promise<ConversationAttributeEditResult> {
    try {
      const { outcome, result } = await edit();
      this.count(action, outcome);
      return result;
    } catch (error) {
      if (error instanceof EditRefusal) this.count(action, error.outcome);
      else this.count(action, error instanceof AppError && error.statusCode === 404 ? "not_found" : "failed");
      throw error;
    }
  }

  private count(action: AttributeEditAction, outcome: EditOutcome): void {
    this.deps.metrics?.incrementCounter(CONVERSATION_ATTRIBUTE_EDITS_TOTAL, {
      help: "A teammate's sets and resets of a conversation's attribute, by action and outcome.",
      labels: { action, outcome },
    });
  }
}
