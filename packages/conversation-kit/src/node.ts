/**
 * The kit's Node surface: everything here wants a filesystem, so it lives on the
 * subpath a host imports once it has one.
 */
export {
  FileConversationKitAuthoringStore,
  type FileConversationKitAuthoringStoreOptions,
} from "./fileAuthoringStore.js";
