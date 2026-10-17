/**
 * Conversation data a vendor keeps outside Radioso's database, such as a voice call's recording,
 * which the vendor deletes only when Radioso asks it to. A deletion of conversations prepares the
 * erasure while the conversations and the workspace's vendor keys still exist, and runs it once
 * the deletion has gone through. Running it never fails, so a vendor that refuses or cannot be
 * reached never holds a deletion back; what is left at a vendor is the eraser's to log.
 */
export type VendorHeldConversationDataScope =
  | { readonly kind: "conversations"; readonly workspaceId: string; readonly conversationIds: readonly string[] }
  | { readonly kind: "workspace"; readonly workspaceId: string };

export interface VendorHeldConversationDataEraser {
  prepare(scope: VendorHeldConversationDataScope): Promise<{ erase(): Promise<void> }>;
}
