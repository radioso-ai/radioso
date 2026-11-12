import { randomUUID } from "node:crypto";

import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { setTraceAttributes } from "../../../../shared/observability/tracing/operations.js";
import type { ReplyImageUrls } from "../../contracts/replyBlocks.js";
import type { PreparedSession } from "../chatSessionPreparer.js";
import { buildRecordBlock, type RecordBlockDropReason } from "./recordBlockBuilder.js";
import { readRecordPresentHead, recordPresentHeadSchemaExtension } from "./recordPresentHead.js";
import { channelLabel, type PresentedReplyBlocks } from "./replyBlockTurn.js";
import { presentReplyBlocks } from "./replyBlockBuilder.js";
import type { ToolRecordLedger } from "./toolRecords.js";

/**
 * A reply's offer of the `present` head: the field to put ahead of `answer`, the rules the prompt
 * carries for it, and how the blocks are built from what the model returned. The composer that
 * writes the reply knows nothing of what is presented.
 */
export interface ReplyPresentOffer {
  readonly schemaExtension: AnswerSchemaExtension;
  /** The rules for `present`, appended to the reply prompt. */
  readonly promptSection: string;
  /** The blocks the model's `present` field asks for, or undefined when it asks for none. */
  build(extras: Record<string, unknown> | undefined): PresentedReplyBlocks | undefined;
}

interface SkillResultReplyBlocksDependencies {
  imageUrls: ReplyImageUrls;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  /** The id a tool image is copied under; random, since the id is the image's capability. */
  newImageId?: () => string;
}

/**
 * Decides, per skill-result reply, whether to offer the model the `present` head over the
 * records the skill returned. It is offered only when the client declared it renders item lists
 * and the result holds at least one record; otherwise the reply's prompt and options are exactly
 * what they would be without reply blocks.
 */
export class SkillResultReplyBlocks {
  constructor(private readonly deps: SkillResultReplyBlocksDependencies) {}

  offerFor(session: PreparedSession, skillName: string, ledger: ToolRecordLedger): ReplyPresentOffer | null {
    const itemList = session.replyBlocks?.item_list;
    setTraceAttributes({ "chat.reply_blocks.record_count": ledger.size });
    if (!itemList || ledger.size === 0) {
      return null;
    }
    const channel = channelLabel(session.conversation.sourceChannel);
    return {
      schemaExtension: recordPresentHeadSchemaExtension(),
      promptSection: renderPromptTemplate("chat/skill-result-present-records.md", {}),
      build: (extras) => {
        const head = readRecordPresentHead(extras);
        if (!head) {
          return undefined;
        }
        const { block, dropped, toolImages } = buildRecordBlock({
          head,
          ledger,
          layouts: itemList.layouts,
          skillName,
          newImageId: this.deps.newImageId ?? randomUUID,
        });
        this.countDropped(dropped);
        if (!block) {
          return undefined;
        }
        this.deps.metrics?.incrementCounter("reply_blocks_emitted_total", {
          help: "Reply blocks built for replies, by layout, conversation channel and where the items came from",
          labels: { layout: block.layout, channel, source: "skill_result" },
        });
        return {
          stored: [block],
          presented: presentReplyBlocks([block], this.deps.imageUrls),
          ...(toolImages.length > 0 ? { toolImages } : {}),
        };
      },
    };
  }

  private countDropped(dropped: readonly RecordBlockDropReason[]): void {
    for (const reason of dropped) {
      this.deps.metrics?.incrementCounter("reply_block_items_dropped_total", {
        help: "Items the model named for a reply block that did not become items, or fields left off them, by reason",
        labels: { reason },
      });
    }
  }
}
