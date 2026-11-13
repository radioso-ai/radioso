import { randomUUID } from "node:crypto";

import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { setTraceAttributes } from "../../../../shared/observability/tracing/operations.js";
import type { ReplyImageUrls } from "../../contracts/replyBlocks.js";
import type { PreparedSession } from "../chatSessionPreparer.js";
import { buildRecordBlock, type RecordBlockDropReason } from "./recordBlockBuilder.js";
import { readRecordPresentHead, recordPresentHeadSchemaExtension } from "./recordPresentHead.js";
import { channelLabel, type PresentedReplyBlocks } from "./replyBlockTurn.js";
import { presentReplyBlocks } from "./replyBlockBuilder.js";
import { skillResultCardsFor } from "./skillResultCardsGate.js";
import { ToolRecordLedger } from "./toolRecords.js";

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

/**
 * The cards a skill-result reply is offered: the offer itself, the records as findings with their
 * handles, the same records without handles for a reply written again without cards, and whether
 * the model named cards that could not be built, after a `build`.
 */
export interface SkillResultCardsOffer extends ReplyPresentOffer {
  readonly records: { readonly withHandles: string; readonly plain: string };
  cardsLost(): boolean;
}

interface SkillResultReplyBlocksDependencies {
  imageUrls: ReplyImageUrls;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "warn">;
  /** The id a tool image is copied under; random, since the id is the image's capability. */
  newImageId?: () => string;
}

/**
 * Decides, per skill-result reply, whether to offer the model the `present` head over the
 * records the skill returned. It is offered only where the cards gate opens and the result holds
 * at least one record; otherwise the reply's prompt and options are exactly what they would be
 * without reply blocks.
 */
export class SkillResultReplyBlocks {
  constructor(private readonly deps: SkillResultReplyBlocksDependencies) {}

  offerFor(session: PreparedSession, skillName: string, outputs: Record<string, unknown> | undefined): SkillResultCardsOffer | null {
    const itemList = skillResultCardsFor(session);
    if (!itemList) {
      return null;
    }
    const ledger = ToolRecordLedger.fromOutputs(outputs);
    setTraceAttributes({ "chat.reply_blocks.record_count": ledger.size });
    if (ledger.size === 0) {
      return null;
    }
    const channel = channelLabel(session.conversation.sourceChannel);
    let lost = false;
    return {
      schemaExtension: recordPresentHeadSchemaExtension(),
      promptSection: renderPromptTemplate("chat/skill-result-present-records.md", {}),
      records: { withHandles: ledger.promptSection({ handles: true }), plain: ledger.promptSection({ handles: false }) },
      cardsLost: () => lost,
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
          // The model wrote its lead around cards none of which could be built.
          lost = head.records.length > 0;
          if (lost) {
            this.deps.logger?.warn(
              {
                event: "chat.skill_result.cards_lost",
                workspaceId: session.agent.workspaceId,
                conversationId: session.conversation.id,
                skillName,
                namedRecords: head.records.length,
                droppedCount: dropped.length,
              },
              "The reply named cards from the skill's records and none could be built",
            );
          }
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
