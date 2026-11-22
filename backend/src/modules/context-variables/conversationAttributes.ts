import { badRequest } from "../../shared/domain/errors.js";
import {
  CONVERSATION_SCOPE_TYPES,
  conversationScopeLadder,
  type ContextValueWriter,
  type ContextVariable,
  type ContextVariableScopeType,
  type ContextVariableValue,
  type ContextVariableValueType,
  type ConversationScope,
  type ConversationScopeKeys,
  type ConversationScopeType,
} from "./domain.js";

/**
 * The option a filter names to find the conversations that hold no value of the attribute. No
 * option key can be it: a key starts with a letter.
 */
export const ATTRIBUTE_FILTER_NOT_SET = "_not_set";

/**
 * One attribute of a conversation as a teammate reads it: the value it resolves to from the
 * conversation's own rungs, where that value is kept, and who set it. A Private value is redacted:
 * its value and its option are left out, and who set it and when remain.
 */
export interface ConversationAttribute {
  readonly name: string;
  readonly valueType: ContextVariableValueType;
  /** The stored value, as the values API returns it; an enum value is its option's key. Null when redacted. */
  readonly value: unknown;
  /** The option an enum value names, archived or not. Absent for other types, a redacted value, and a key no option has. */
  readonly option?: { readonly label: string; readonly archived: boolean };
  readonly redacted: boolean;
  /** The rung the value is kept on: the conversation's own, the visitor's chat session's or the verified customer's. */
  readonly scope: ConversationScopeType;
  readonly writtenBy: ContextValueWriter;
  readonly updatedAt: Date;
  /**
   * Whether the AI fills the attribute on this conversation: the agent release the conversation runs
   * classifies it. A teammate's reset hands such an attribute back to the AI.
   */
  readonly classified: boolean;
}

/** A stored value on one of a conversation's own rungs, with the definition it is a value of. */
export interface StoredConversationAttributeValue {
  readonly variable: ContextVariable;
  readonly value: ContextVariableValue;
}

/**
 * A filter on a conversation-scope Choice value, as a caller names it: the attribute's name as it is
 * stored, and an option key or {@link ATTRIBUTE_FILTER_NOT_SET}.
 */
export interface ConversationAttributeFilterInput {
  readonly name: string;
  readonly option: string;
}

/**
 * A filter on a conversation-scope Choice value, resolved: the conversations whose own value of the
 * variable is `key`, or, when `key` is null, the conversations that hold none.
 */
export interface ConversationAttributeFilter {
  readonly variableId: string;
  readonly key: string | null;
}

/** The reads a conversation's attributes and an attribute filter need. */
export interface ConversationAttributeReadPort {
  /** Each variable's most specific value on these rungs of one conversation's ladder, with its definition. */
  readMostSpecificValues(workspaceId: string, scopes: readonly ConversationScope[]): Promise<StoredConversationAttributeValue[]>;
  /** The variable whose stored name is exactly `name`. */
  findByName(workspaceId: string, name: string): Promise<ContextVariable | null>;
  /** The variables the agent release a conversation runs classifies; none for a conversation that is gone or runs none. */
  readClassifiedVariableIds(workspaceId: string, conversationId: string): Promise<ReadonlySet<string>>;
}

/** What an operator surface reads of a conversation's attributes, and how it resolves a filter on one. */
export interface ConversationAttributeReader {
  /** The attributes of the conversation these keys name: the conversation's id, its chat session's and its verified customer's. */
  read(workspaceId: string, keys: ConversationScopeKeys): Promise<ConversationAttribute[]>;
  resolveFilter(workspaceId: string, filter: ConversationAttributeFilterInput): Promise<ConversationAttributeFilter>;
}

const isConversationScope = (scope: ContextVariableScopeType): scope is ConversationScopeType =>
  (CONVERSATION_SCOPE_TYPES as readonly ContextVariableScopeType[]).includes(scope);

const presentValue = (
  { variable, value }: StoredConversationAttributeValue,
  scope: ConversationScopeType,
  classified: ReadonlySet<string>,
): ConversationAttribute => {
  const facts = {
    name: variable.name,
    valueType: variable.valueType,
    scope,
    writtenBy: value.writtenBy,
    updatedAt: value.lastModified,
    classified: classified.has(variable.id),
  };
  if (variable.sensitivity === "sensitive") return { ...facts, value: null, redacted: true };
  const option = variable.valueType === "enum" ? variable.options?.find((candidate) => candidate.key === value.data) : undefined;
  return {
    ...facts,
    value: value.data,
    ...(option ? { option: { label: option.label, archived: option.archived } } : {}),
    redacted: false,
  };
};

/** Each attribute's most specific value, as the read port hands it, in name order. */
const presentConversationAttributes = (
  stored: readonly StoredConversationAttributeValue[],
  classified: ReadonlySet<string>,
): ConversationAttribute[] =>
  stored
    .flatMap((entry) => {
      const scope = entry.value.scope.type;
      return isConversationScope(scope) ? [presentValue(entry, scope, classified)] : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));

/**
 * A filter matches the conversation-scope values of a Choice attribute that is not Private, so it
 * never reveals a Private value. An archived option still names the values stored under it, and Not
 * set names the conversations that hold no value of the attribute.
 */
const resolveAttributeFilter = (
  variable: ContextVariable | null,
  filter: ConversationAttributeFilterInput,
): ConversationAttributeFilter => {
  if (!variable) throw badRequest(`No attribute is named ${filter.name}`);
  if (variable.valueType !== "enum") throw badRequest(`Only a Choice attribute filters conversations; ${variable.name} is not one`);
  if (variable.sensitivity === "sensitive") throw badRequest("A Private attribute does not filter conversations");
  if (filter.option === ATTRIBUTE_FILTER_NOT_SET) return { variableId: variable.id, key: null };
  const options = variable.options ?? [];
  if (!options.some((option) => option.key === filter.option)) {
    // Callers often pass the label they see in the Inbox; naming the keys lets them retry.
    const keys = [...options.map((option) => option.key), ATTRIBUTE_FILTER_NOT_SET].join(", ");
    throw badRequest(`${variable.name} has no option ${filter.option}; its option keys are ${keys}`);
  }
  return { variableId: variable.id, key: filter.option };
};

export class ConversationAttributeService implements ConversationAttributeReader {
  constructor(private readonly reads: ConversationAttributeReadPort) {}

  async read(workspaceId: string, keys: ConversationScopeKeys): Promise<ConversationAttribute[]> {
    const scopes = conversationScopeLadder(keys);
    if (scopes.length === 0) return [];
    const stored = await this.reads.readMostSpecificValues(workspaceId, scopes);
    // Most conversations hold no value: the release is read only when there is one to mark.
    if (stored.length === 0) return [];
    const classified = keys.conversationId
      ? await this.reads.readClassifiedVariableIds(workspaceId, keys.conversationId)
      : new Set<string>();
    return presentConversationAttributes(stored, classified);
  }

  async resolveFilter(workspaceId: string, filter: ConversationAttributeFilterInput): Promise<ConversationAttributeFilter> {
    return resolveAttributeFilter(await this.reads.findByName(workspaceId, filter.name), filter);
  }
}
