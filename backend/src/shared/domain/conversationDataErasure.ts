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
