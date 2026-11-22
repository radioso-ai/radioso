import { badRequest } from "../../shared/domain/errors.js";
import type {
  ContextValueWriter,
  ContextVariable,
  ContextVariableScopeType,
  ContextVariableValue,
  ContextVariableValueType,
} from "./domain.js";

/**
 * The rungs of a conversation's ladder that hold facts about it: its own, its chat session's and
 * its verified customer's, most specific first. An agent or workspace value is a default every
 * conversation of the agent or workspace shares, so a conversation's attributes leave it out.
 */
const CONVERSATION_ATTRIBUTE_SCOPES = ["conversation", "session", "customer"] as const satisfies readonly ContextVariableScopeType[];
type ConversationAttributeScope = typeof CONVERSATION_ATTRIBUTE_SCOPES[number];

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
  readonly scope: ConversationAttributeScope;
  readonly writtenBy: ContextValueWriter;
  readonly updatedAt: Date;
}

/** A stored value on one of a conversation's own rungs, with the definition it is a value of. */
export interface StoredConversationAttributeValue {
  readonly variable: ContextVariable;
  readonly value: ContextVariableValue;
}

/** A filter on a conversation-scope Choice value, as a caller names it. */
export interface ConversationAttributeFilterInput {
  readonly name: string;
  readonly option: string;
}

/** A filter on a conversation-scope Choice value, resolved to the stored value it matches. */
export interface ConversationAttributeFilter {
  readonly variableId: string;
  readonly key: string;
}

/** The reads a conversation's attributes and an attribute filter need. */
export interface ConversationAttributeReadPort {
  /**
   * Every value stored for the conversation, its chat session or its verified customer, each with
   * its definition. None when the workspace has no such conversation.
   */
  readConversationValues(input: { workspaceId: string; conversationId: string }): Promise<StoredConversationAttributeValue[]>;
  findByName(workspaceId: string, name: string): Promise<ContextVariable | null>;
}

/** What an operator surface reads of a conversation's attributes, and how it resolves a filter on one. */
export interface ConversationAttributeReader {
  read(workspaceId: string, conversationId: string): Promise<ConversationAttribute[]>;
  resolveFilter(workspaceId: string, filter: ConversationAttributeFilterInput): Promise<ConversationAttributeFilter>;
}

const isAttributeScope = (scope: ContextVariableScopeType): scope is ConversationAttributeScope =>
  (CONVERSATION_ATTRIBUTE_SCOPES as readonly ContextVariableScopeType[]).includes(scope);

const presentValue = ({ variable, value }: StoredConversationAttributeValue, scope: ConversationAttributeScope): ConversationAttribute => {
  const facts = { name: variable.name, valueType: variable.valueType, scope, writtenBy: value.writtenBy, updatedAt: value.lastModified };
  if (variable.sensitivity === "sensitive") return { ...facts, value: null, redacted: true };
  const option = variable.valueType === "enum" ? variable.options?.find((candidate) => candidate.key === value.data) : undefined;
  return {
    ...facts,
    value: value.data,
    ...(option ? { option: { label: option.label, archived: option.archived } } : {}),
    redacted: false,
  };
};

/** Each attribute's most specific value among the conversation's own rungs, in name order. */
const presentConversationAttributes = (stored: readonly StoredConversationAttributeValue[]): ConversationAttribute[] => {
  const mostSpecific = new Map<string, { entry: StoredConversationAttributeValue; scope: ConversationAttributeScope }>();
  for (const entry of stored) {
    const scope = entry.value.scope.type;
    if (!isAttributeScope(scope)) continue;
    const held = mostSpecific.get(entry.variable.id);
    if (!held || CONVERSATION_ATTRIBUTE_SCOPES.indexOf(scope) < CONVERSATION_ATTRIBUTE_SCOPES.indexOf(held.scope)) {
      mostSpecific.set(entry.variable.id, { entry, scope });
    }
  }
  return [...mostSpecific.values()]
    .map(({ entry, scope }) => presentValue(entry, scope))
    .sort((left, right) => left.name.localeCompare(right.name));
};

/**
 * A filter matches the conversation-scope values of a Choice attribute that is not Private, so it
 * never reveals a Private value. An archived option still names the values stored under it.
 */
const resolveAttributeFilter = (
  variable: ContextVariable | null,
  filter: ConversationAttributeFilterInput,
): ConversationAttributeFilter => {
  if (!variable) throw badRequest(`No attribute is named ${filter.name}`);
  if (variable.valueType !== "enum") throw badRequest(`Only a Choice attribute filters conversations; ${variable.name} is not one`);
  if (variable.sensitivity === "sensitive") throw badRequest("A Private attribute does not filter conversations");
  if (!variable.options?.some((option) => option.key === filter.option)) {
    throw badRequest(`${variable.name} has no option ${filter.option}`);
  }
  return { variableId: variable.id, key: filter.option };
};

export class ConversationAttributeService implements ConversationAttributeReader {
  constructor(private readonly reads: ConversationAttributeReadPort) {}

  async read(workspaceId: string, conversationId: string): Promise<ConversationAttribute[]> {
    return presentConversationAttributes(await this.reads.readConversationValues({ workspaceId, conversationId }));
  }

  async resolveFilter(workspaceId: string, filter: ConversationAttributeFilterInput): Promise<ConversationAttributeFilter> {
    return resolveAttributeFilter(await this.reads.findByName(workspaceId, filter.name), filter);
  }
}
