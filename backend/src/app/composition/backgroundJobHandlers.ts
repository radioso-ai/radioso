import type { BackgroundJobHandlerRegistration } from "../../shared/background-jobs/index.js";

/**
 * Every background job kind's handler, the list the runtime is built over: the ones the chat and
 * Slack compositions return, and the deletion jobs whose handlers the dependency graph builds
 * beside them.
 */
export const backgroundJobHandlers = (input: {
  chat: readonly BackgroundJobHandlerRegistration[];
  slackInbound: readonly BackgroundJobHandlerRegistration[];
  voiceRecordingErasure: BackgroundJobHandlerRegistration;
  visitorImageObjectDeletion: BackgroundJobHandlerRegistration;
  workspaceStoragePurge: BackgroundJobHandlerRegistration;
}): BackgroundJobHandlerRegistration[] => [
  ...input.chat,
  ...input.slackInbound,
  // The recordings a deletion handed off, deleted at the voice vendor with the key held beside them.
  input.voiceRecordingErasure,
  // The photos an erasure or the unbound sweep handed off.
  input.visitorImageObjectDeletion,
  // A deleted workspace's stored files: handed off by its deletion, or queued by an operator.
  input.workspaceStoragePurge,
];
