import { z } from "zod";

import type { MessageRecord } from "../../../../db/repositories/messageRepository.js";
import { storedReplyBlockSchema } from "../../contracts/replyBlocks.js";

const storedBlocksSchema = z.array(storedReplyBlockSchema).min(1);

/** How often a picture still being copied is asked for again. */
const DEFAULT_POLL_MS = 250;

/** The served copy of a reply's picture, by its id; asking for one that is still waiting copies it. */
interface ReplyPictureLookup {
  findServable(input: { imageId: string; width: number }): Promise<unknown>;
}

interface ReplyPictureReadinessDependencies {
  messages: { findByIdAndWorkspaceId(workspaceId: string, messageId: string): Promise<MessageRecord | null> };
  pictures: ReplyPictureLookup;
  /** The width the presented cards show, the one a provider fetches. */
  width: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Whether the pictures a reply's cards show are stored, for a channel whose provider fetches each
 * picture by its address when the cards are sent (WhatsApp). A picture from a skill's result is
 * copied after the reply is written, so each is asked for at once, through the lookup the image
 * route serves by, which copies a waiting picture on demand; one still being copied is asked for
 * again until the time given runs out. It reads the pictures from the reply's stored blocks, never
 * from what a channel sends.
 */
export class ReplyPictureReadiness {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ReplyPictureReadinessDependencies) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** True when every picture is stored within `withinMs`; false when one is not, or the reply is not found. */
  async awaitStored(input: { workspaceId: string; messageId: string; withinMs: number }): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), input.withinMs);
    });
    try {
      return await Promise.race([this.poll(input), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async poll(input: { workspaceId: string; messageId: string; withinMs: number }): Promise<boolean> {
    const message = await this.deps.messages.findByIdAndWorkspaceId(input.workspaceId, input.messageId);
    const blocks = storedBlocksSchema.safeParse((message?.metadata as { blocks?: unknown } | undefined)?.blocks);
    if (!blocks.success) {
      return false;
    }
    let waiting = [...new Set(blocks.data.flatMap((block) => block.items.flatMap((item) => (item.image ? [item.image.imageId] : []))))];
    const deadline = this.now() + input.withinMs;
    const pollMs = this.deps.pollMs ?? DEFAULT_POLL_MS;
    for (;;) {
      const found = await Promise.all(waiting.map((imageId) =>
        this.deps.pictures.findServable({ imageId, width: this.deps.width }).catch(() => null)));
      waiting = waiting.filter((_imageId, index) => !found[index]);
      if (waiting.length === 0) {
        return true;
      }
      if (this.now() + pollMs >= deadline) {
        return false;
      }
      await this.sleep(pollMs);
    }
  }
}
