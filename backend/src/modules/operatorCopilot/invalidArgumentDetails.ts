const MAX_REJECTION_LENGTH = 300;

/**
 * A tool's own account of why it refused the call. Unlike a schema rejection this is a sentence,
 * and some of them name a workspace object the credential already reads through other tools — it
 * stays inside the caller's own authority, not below it. Bounded here rather than only at the
 * transport, so the size of what leaves is decided where it is written.
 */
export const toolRejectionDetail = (message: string): readonly string[] =>
  [message.slice(0, MAX_REJECTION_LENGTH)];
