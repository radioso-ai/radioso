import type { ChatThreadMessage } from "@/components/dashboard/chat-message-thread";
import type { TestExecutionSideState } from "@/lib/agent-test-execution-state";
import { DEFAULT_WEBSITE_EMBED_COPY } from "@/lib/embed-widget";

/** A Test Chat message's state as the shared thread shows it. */
const THREAD_STATUS = { streaming: "streaming", completed: "complete", failed: "error" } as const satisfies Record<string, ChatThreadMessage["status"]>;

/** A Test Chat side's messages as the chat thread shows them: a spoken turn marked, a reply with its sources and cards. */
export const testChatThreadMessages = (side: TestExecutionSideState | undefined): ChatThreadMessage[] =>
  side?.messages.map((item) => ({
    id: item.id,
    role: item.role,
    content: item.content,
    persistedAssistantMessageId: item.persistedAssistantMessageId,
    ...(item.spoken ? { spokenLabel: DEFAULT_WEBSITE_EMBED_COPY.publicChatSpokenLabel } : {}),
    ...(item.imageInput ? { inputMetadata: { method: "typed" as const, imageInput: item.imageInput } } : {}),
    ...(item.citations ? { citations: item.citations, answerSegments: item.answerSegments } : {}),
    ...(item.blocks ? { blocks: item.blocks } : {}),
    status: THREAD_STATUS[item.state],
  })) ?? [];
