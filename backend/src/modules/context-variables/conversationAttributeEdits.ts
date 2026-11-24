import { AppError, badRequest, notFound } from "../../shared/domain/errors.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { contextValueChanged } from "./contextValueChangedEvent.js";
import {
  presentConversationAttributes,
  type ConversationAttribute,
  type ConversationAttributeReadPort,
  type StoredConversationAttributeValue,
} from "./conversationAttributes.js";
import { conversationScopeLadder, type ContextValueWriter, type ContextVariable, type ConversationScopeKeys } from "./domain.js";
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

/** The conversation an edit is made on, read once: the keys of its own rungs and what its release classifies. */
export interface EditedConversation {
  readonly keys: ConversationScopeKeys;
  /** The variables the agent release the conversation runs classifies. */
  readonly classifiedVariableIds: ReadonlySet<string>;
}

/** What an edit reads around its write. */
export interface ConversationAttributeEditReads extends Pick<ConversationAttributeReadPort, "findByName" | "readMostSpecificValues"> {
  /** The conversation, null when the workspace has no such conversation. */
  readConversation(workspaceId: string, conversationId: string): Promise<EditedConversation | null>;
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

type EditOutcome = "written" | "pinned" | "cleared" | "unchanged" | "not_found" | "refused_type" | "refused_private" | "refused_option" | "failed";

/** A refusal that carries its own outcome label, so the counter never reads the message. */
class EditRefusal extends AppError {
  constructor(readonly outcome: Exclude<EditOutcome, "written" | "pinned" | "cleared" | "unchanged" | "failed">, error: AppError) {
    super(error.statusCode, error.code, error.message, error.details);
  }
}

/**
 * A teammate sets the Choice attributes they can see, and clears any attribute they can see, of
 * whatever type, so a wrong value a routine or the host saved goes without the values API. A Private
 * value is hidden from them, so they neither overwrite nor clear what they can't read; the host sets
 * it through the values API.
 */
const editableVariable = (variable: ContextVariable | null, name: string, action: AttributeEditAction): ContextVariable => {
  if (!variable) throw new EditRefusal("not_found", notFound(`No attribute is named ${name}`));
  if (variable.sensitivity === "sensitive") {
    throw new EditRefusal("refused_private", new AppError(400, "attribute_not_editable",
      `${variable.name} is Private: a teammate never sees its value, so it is set and cleared only through the values API`, { reason: "private" }));
  }
  if (action === "set" && variable.valueType !== "enum") {
    throw new EditRefusal("refused_type", new AppError(400, "attribute_not_editable",
      `${variable.name} is not a Choice: a teammate picks only a Choice's option here, and clears a value of any other type; the host sets one through the values API`, { reason: "not_choice" }));
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

/** Whether the conversation's own value already is this option, set by a teammate: a set then changes nothing. */
const heldByTeam = (current: ConversationAttribute | null, value: unknown): current is ConversationAttribute =>
  current !== null && current.scope === "conversation" && current.writtenBy.kind === "operator" && !contextValueChanged(current.value, value);

/**
 * Sets and resets a conversation's own value of an attribute for a teammate. A set writes the option
 * with the teammate as its writer, which the classifier never replaces: setting the option the AI,
 * the host or a routine chose makes it the team's without changing it, and setting the one a
 * teammate already set changes nothing. A reset deletes the conversation's value: when the
 * conversation's release classifies the attribute, it asks the AI to fill it now, since the
 * conversation may have ended. The value write records `context_value.changed` in its own
 * transaction when the value changes; the audit event comes after it and names no value. Each edit
 * is counted by action and outcome, never by attribute or value.
 */
export class ConversationAttributeEditService implements ConversationAttributeEdits {
  constructor(private readonly deps: {
    reads: ConversationAttributeEditReads;
    values: Pick<ContextVariableRepositoryPort, "upsertValue" | "deleteValue">;
    reclassification: ConversationReclassification;
    audit: AttributeEditAudit;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger?: Pick<AppLogger, "warn"> | null;
  }) {}

  set(input: Parameters<ConversationAttributeEdits["set"]>[0]): Promise<ConversationAttributeEditResult> {
    return this.counted("set", async () => {
      const { variable, conversation } = await this.target(input, "set");
      if (!validateValue(variable, input.value).ok) throw optionRefusal(variable, input.value);
      const current = await this.readAttribute(input, conversation);
      // The same option from another writer only changes who holds it; the counter tells that apart from a change.
      const pinned = current !== null && current.scope === "conversation" && !contextValueChanged(current.value, input.value);
      if (heldByTeam(current, input.value)) return { outcome: "unchanged", result: { attribute: current, classificationQueued: false } };
      const written = await this.deps.values.upsertValue(variable.id, { type: "conversation", id: input.conversationId }, input.value, operatorWriter(input.actor));
      await this.audit({ workspaceId: input.workspaceId, conversationId: input.conversationId, variableId: variable.id, action: "set", actor: input.actor });
      // The conversation's own value is the most specific rung, so what was written is what it reads.
      const attribute = written
        ? present([{ variable, value: written }], conversation)
        : await this.readAttribute(input, conversation);
      return { outcome: pinned ? "pinned" : "written", result: { attribute, classificationQueued: false } };
    });
  }

  reset(input: Parameters<ConversationAttributeEdits["reset"]>[0]): Promise<ConversationAttributeEditResult> {
    return this.counted("reset", async () => {
      const { variable, conversation } = await this.target(input, "reset");
      const cleared = await this.deps.values.deleteValue(variable.id, { type: "conversation", id: input.conversationId }, operatorWriter(input.actor));
      if (!cleared) return { outcome: "unchanged", result: { attribute: await this.readAttribute(input, conversation), classificationQueued: false } };
      await this.audit({ workspaceId: input.workspaceId, conversationId: input.conversationId, variableId: variable.id, action: "reset", actor: input.actor });
      const classificationQueued = conversation.classifiedVariableIds.has(variable.id) && await this.reclassify(input);
      return { outcome: "cleared", result: { attribute: await this.readAttribute(input, conversation), classificationQueued } };
    });
  }

  private async target(input: { workspaceId: string; conversationId: string; name: string }, action: AttributeEditAction) {
    const variable = editableVariable(await this.deps.reads.findByName(input.workspaceId, input.name), input.name, action);
    const conversation = await this.deps.reads.readConversation(input.workspaceId, input.conversationId);
    if (!conversation) throw new EditRefusal("not_found", notFound("Conversation not found"));
    return { variable, conversation };
  }

  /** The attribute as the conversation reads it now, from the conversation read at the start of the edit. */
  private async readAttribute(input: { workspaceId: string; name: string }, conversation: EditedConversation): Promise<ConversationAttribute | null> {
    const stored = await this.deps.reads.readMostSpecificValues(input.workspaceId, conversationScopeLadder(conversation.keys));
    return present(stored.filter((entry) => entry.variable.name === input.name), conversation);
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

const present = (stored: readonly StoredConversationAttributeValue[], conversation: EditedConversation): ConversationAttribute | null =>
  presentConversationAttributes(stored, conversation.classifiedVariableIds)[0] ?? null;
