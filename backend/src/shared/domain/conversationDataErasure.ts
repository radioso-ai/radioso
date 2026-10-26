/**
 * Erasure of the conversation-derived rows a foreign key cannot reach.
 *
 * Most of what a conversation leaves behind cascades from its `conversations` row. What does not is
 * keyed some other way: a chat session id in a text scope, a conversation id inside a JSON payload,
 * a row that outlives its workspace by design. The module that owns such rows implements an eraser
 * for them; application composition binds every eraser to the erasure's transaction, and the erasure
 * use case runs them before it deletes the conversations themselves.
 */

/**
 * What one erasure removes: some conversations of a workspace, or a whole workspace just before it
 * is deleted. Erasers run while the conversations still exist, so an eraser can read whatever it
 * keys its rows by from them.
 */
export type ConversationErasureScope =
  | { readonly kind: "conversations"; readonly workspaceId: string; readonly conversationIds: readonly string[] }
  | { readonly kind: "workspace"; readonly workspaceId: string };

/** One module's conversation-derived rows that no foreign key reaches, bound to the erasure's transaction. */
export interface ConversationDataEraser {
  /** The owning module, named with its row count in the erasure's audit event. */
  readonly owner: string;
  /** Removes the owner's rows in `scope` and returns how many it removed. */
  erase(scope: ConversationErasureScope): Promise<number>;
}

/** A visitor's host-verified customer id, whose own data an erasure of that visitor removes. */
export interface VerifiedCustomerErasureScope {
  readonly workspaceId: string;
  readonly verifiedCustomerId: string;
}

/** One module's rows keyed by a verified customer id rather than a conversation. */
export interface VerifiedCustomerDataEraser {
  readonly owner: string;
  eraseVerifiedCustomer(scope: VerifiedCustomerErasureScope): Promise<number>;
}

/**
 * A visitor's durable key, which rows written before any conversation of theirs existed carry: a
 * call the website embed started for them whose first turn never came, say.
 */
export interface VisitorKeyErasureScope {
  readonly workspaceId: string;
  readonly visitorKey: string;
}

/** One module's rows keyed by a visitor's key rather than a conversation, which a visitor's erasure removes. */
export interface VisitorKeyDataEraser {
  readonly owner: string;
  eraseVisitorKey(scope: VisitorKeyErasureScope): Promise<number>;
}

/** What vendors hold for: some conversations, a whole workspace, or what a visitor left before any conversation. */
export type VendorHeldConversationDataScope =
  | ConversationErasureScope
  | ({ readonly kind: "visitor_key" } & VisitorKeyErasureScope);

/**
 * One erasure of conversation data a vendor keeps outside Radioso's database, such as a voice call's
 * recording, which the vendor deletes only when Radioso asks it to: its scopes, and the organization
 * they belong to, which the record of each deletion at the vendor names.
 */
export interface VendorHeldConversationDataErasure {
  readonly accountId: string;
  readonly scopes: readonly VendorHeldConversationDataScope[];
}

/**
 * Hands what vendors hold for a deletion to a durable backlog, inside the deletion's own
 * transaction, while the rows that say where it is and the workspace's vendor keys still exist.
 * The backlog outlives the workspace and the organization, keys included, so the deletion and the
 * backlog commit together or not at all, and a background job asks the vendors to delete it after
 * the commit, with retries, recording each outcome. `afterCommit` wakes that job once the
 * transaction committed; it never rejects.
 *
 * Bound to the deletion's transaction, `handOff` reads and locks the rows in scope, so a report
 * that arrives meanwhile waits for the deletion. When it cannot read them it rejects, and the
 * deletion fails whole, to be run again: a deletion never goes on without knowing what the vendors
 * hold.
 */
export interface VendorHeldConversationDataEraser {
  handOff(erasure: VendorHeldConversationDataErasure): Promise<{ afterCommit(): Promise<void> }>;
}
