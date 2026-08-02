/**
 * The kit's Node-only surface. Everything here needs a filesystem, so it is kept out of
 * the root entry point to leave that entry runnable on runtimes without one.
 */
export {
  FileConversationKitAuthoringStore,
  type FileConversationKitAuthoringStoreOptions,
} from "./fileAuthoringStore.js";
