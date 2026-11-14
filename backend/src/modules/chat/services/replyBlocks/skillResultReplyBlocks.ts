import { randomUUID } from "node:crypto";

import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { setTraceAttributes } from "../../../../shared/observability/tracing/operations.js";
import type { ReplyImageUrls, StoredReplyBlock } from "../../contracts/replyBlocks.js";
import type { PreparedSession } from "../chatSessionPreparer.js";
import { buttonLabelsPromptSection, withButtonLabels } from "./presentButtonLabels.js";
import { buildRecordBlock, type RecordBlockBinding, type RecordBlockDropReason } from "./recordBlockBuilder.js";
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
  /** The records the reply's text lists, kept unpresented, when it draws no cards (#1763). */
  listed?(extras: Record<string, unknown> | undefined): StoredReplyBlock | undefined;
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

  /**
   * A routine step's `binding` (#1763) decides whether its cards are picked and stores them with the
   * step's origin; the gate and the records decide whether there are cards, as for any skill result.
   */
  offerFor(
    session: PreparedSession,
    skillName: string,
    outputs: Record<string, unknown> | undefined,
    binding?: RecordBlockBinding,
  ): SkillResultCardsOffer | null {
    const itemList = skillResultCardsFor(session);
    if (!itemList && !binding) {
      return null;
    }
    const ledger = ToolRecordLedger.fromOutputs(outputs);
    setTraceAttributes({ "chat.reply_blocks.record_count": ledger.size });
    if (ledger.size === 0) {
      return null;
    }
    if (!itemList) {
      return binding ? this.listingOffer(skillName, ledger, binding) : null;
    }
    const channel = channelLabel(session.conversation.sourceChannel);
    const buttonLabels = itemList.buttonLabels === true;
    const recordsSection = renderPromptTemplate("chat/skill-result-present-records.md", {});
    let lost = false;
    return {
      schemaExtension: recordPresentHeadSchemaExtension({ buttonLabels }),
      promptSection: buttonLabels ? `${recordsSection}\n\n${buttonLabelsPromptSection()}` : recordsSection,
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
          ...(binding ? { binding } : {}),
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
          labels: { layout: block.layout, channel, source: binding ? "routine_step" : "skill_result" },
        });
        return {
          stored: [block],
          presented: withButtonLabels(presentReplyBlocks([block], this.deps.imageUrls), buttonLabels ? head.buttonLabels : undefined),
          ...(toolImages.length > 0 ? { toolImages } : {}),
        };
      },
    };
  }

  /**
   * A routine step's offer where no cards are drawn (#1763): the reply lists the records it presents
   * in its text, and the head names them, so the message keeps what it listed, unpresented, for a
   * typed answer to resolve against. Nothing is picked from it and no picture is kept.
   */
  private listingOffer(skillName: string, ledger: ToolRecordLedger, binding: RecordBlockBinding): SkillResultCardsOffer {
    return {
      schemaExtension: recordPresentHeadSchemaExtension(),
      promptSection: renderPromptTemplate("chat/skill-result-list-records.md", {}),
      records: { withHandles: ledger.promptSection({ handles: true }), plain: ledger.promptSection({ handles: false }) },
      cardsLost: () => false,
      build: () => undefined,
      listed: (extras) => {
        const head = readRecordPresentHead(extras);
        if (!head) {
          return undefined;
        }
        const { block, dropped } = buildRecordBlock({
          head: { ...head, fields: { ...head.fields, image: null } },
          ledger,
          layouts: ["list"],
          skillName,
          newImageId: this.deps.newImageId ?? randomUUID,
          binding: { selection: "none", origin: binding.origin },
        });
        this.countDropped(dropped);
        return block ?? undefined;
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
