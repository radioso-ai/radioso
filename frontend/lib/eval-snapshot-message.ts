import type { EvalSnapshotMessage } from '@/lib/api-eval'
import type { ChatUserInputMetadata } from '@/lib/api-types'

/**
 * The input metadata a thread reads an Eval snapshot message by. A visitor's message with photos
 * keeps `content` as the turn text the replay runs on (readings included) and its photos in
 * `imageInput`; handing the thread the second shows the typed words and the photos, never the
 * readings. A snapshot captured before photos were kept has none, and its message shows `content`.
 */
export const snapshotInputMetadata = (message: EvalSnapshotMessage): ChatUserInputMetadata | undefined =>
  message.role === 'user' && message.imageInput ? { method: 'typed', imageInput: message.imageInput } : undefined
