import type {
  ConversationCoverageReactionRecorder,
} from "@radioso/conversation-contract";

/** Captures coverage diagnostics until the assistant turn has committed. */
export class DeferredCoverageReactionRecorder implements ConversationCoverageReactionRecorder {
  private reaction: Parameters<ConversationCoverageReactionRecorder["record"]>[0] | null = null;

  constructor(private readonly inner: ConversationCoverageReactionRecorder) {}

  async record(input: Parameters<ConversationCoverageReactionRecorder["record"]>[0]): Promise<void> {
    this.reaction = input;
  }

  async commit(): Promise<void> {
    const reaction = this.reaction;
    this.reaction = null;
    if (reaction) await this.inner.record(reaction);
  }
}
