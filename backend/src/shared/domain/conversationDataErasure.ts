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
 * One erasure of conversation data a vendor keeps outside Radioso's database, such as a voice call's
 * recording, which the vendor deletes only when Radioso asks it to: its scopes, worked through in
 * order under one budget, and the organization they belong to, which the erasure's record names.
 * `deleted`: the organization goes with them, so the record keeps its id without pointing at it.
 */
export interface VendorHeldConversationDataErasure {
  readonly account: { readonly id: string; readonly deleted: boolean } | null;
  readonly scopes: readonly ConversationErasureScope[];
}

/**
 * Erases what vendors hold, in two steps around the deletion. `prepare` reads what is held and the
 * workspace's vendor keys while the conversations and the keys still exist, before any eraser or
 * cascade removes the rows that say where it is; `erase` asks the vendors to delete it once the
 * deletion has committed. `erase` never rejects, so a vendor that refuses or cannot be reached never
 * holds a deletion back; what is left at a vendor is the eraser's to log.
 */
export interface VendorHeldConversationDataEraser {
  prepare(erasure: VendorHeldConversationDataErasure): Promise<{ erase(): Promise<void> }>;
}
