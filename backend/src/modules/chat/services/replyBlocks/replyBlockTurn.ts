import type { ReplyBlock } from "@radioso/conversation-contract";

import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { setTraceAttributes } from "../../../../shared/observability/tracing/operations.js";
import type { EvidenceImageAttacher } from "../../../retrieval/public.js";
import type { ReplyImageUrls, StoredReplyBlock } from "../../contracts/replyBlocks.js";
import type { PreparedSession } from "../chatSessionPreparer.js";
import type { GroundedAnswerEnvelope } from "../groundedAnswerEnvelope.js";
import { presentHeadSchemaExtension, readPresentHead } from "./presentHead.js";
import { buildReplyBlock, presentReplyBlocks, type ReplyBlockDropReason } from "./replyBlockBuilder.js";
import { TurnImageLedger } from "./turnImageLedger.js";

/** A reply's blocks in both forms: as the message row stores them, and as a client receives them. */
export interface PresentedReplyBlocks {
  stored: StoredReplyBlock[];
  presented: ReplyBlock[];
}

/** One grounded answer's offer of the `present` head, built from the images its evidence carries. */
export interface ReplyBlockTurn {
  /** The `present` field to merge into the answer schema. */
  readonly schemaExtension: AnswerSchemaExtension;
  /** The Result images section of the answer prompt. */
  readonly promptSection: string;
  /**
   * The blocks the model's `present` field asks for, or undefined when it asks for none or the
   * envelope declines: cards belong to an answer, never to a `no_support` or `out_of_scope` reply.
   */
  build(envelope: Pick<GroundedAnswerEnvelope, "outcome" | "extras">): PresentedReplyBlocks | undefined;
}

interface ReplyBlockTurnFactoryDependencies {
  evidenceImages: Pick<EvidenceImageAttacher, "attach">;
  imageUrls: ReplyImageUrls;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "warn">;
}

/** A conversation's source channel as a metric label: identifier-shaped values only, so the series stays bounded. */
const channelLabel = (sourceChannel: string | null | undefined): string =>
  sourceChannel && /^[a-z][a-z0-9_]{0,31}$/.test(sourceChannel) ? sourceChannel : "other";

/**
 * Decides, per grounded answer, whether to offer the model the `present` head. It is offered only
 * when the agent has pictures in answers on, the client declared it renders item lists, and the
 * evidence carries at least one stored image; otherwise the answer's prompt and schema are exactly
 * what they would be without reply blocks. A turn without the setting or the capability reads nothing.
 */
export class ReplyBlockTurnFactory {
  constructor(private readonly deps: ReplyBlockTurnFactoryDependencies) {}

  async forTurn(session: PreparedSession): Promise<ReplyBlockTurn | null> {
    const itemList = session.replyBlocks?.item_list;
    if (session.agent.answerImagesEnabled !== true || !itemList || session.retrieval.contexts.length === 0) {
      return null;
    }
    const ledger = await this.readLedger(session);
    setTraceAttributes({ "chat.reply_blocks.ledger_size": ledger?.size ?? 0 });
    if (!ledger || ledger.size === 0) {
      return null;
    }
    const channel = channelLabel(session.conversation.sourceChannel);
    return {
      schemaExtension: presentHeadSchemaExtension(),
      promptSection: renderPromptTemplate("chat/answer-present-images.md", {
        image_lines: ledger.promptLines().join("\n"),
      }),
      build: ({ outcome, extras }) => {
        const head = outcome === "answer" ? readPresentHead(extras) : null;
        if (!head) {
          return undefined;
        }
        const { block, dropped } = buildReplyBlock({ head, ledger, layouts: itemList.layouts });
        this.countDropped(dropped);
        if (!block) {
          return undefined;
        }
        this.deps.metrics?.incrementCounter("reply_blocks_emitted_total", {
          help: "Reply blocks built for grounded answers, by layout and conversation channel",
          labels: { layout: block.layout, channel },
        });
        return { stored: [block], presented: presentReplyBlocks([block], this.deps.imageUrls) };
      },
    };
  }

  /** A failed read costs the turn its pictures, never its answer. */
  private async readLedger(session: PreparedSession): Promise<TurnImageLedger | null> {
    try {
      return TurnImageLedger.fromEvidence(
        await this.deps.evidenceImages.attach(session.agent.workspaceId, session.retrieval.contexts),
      );
    } catch (error) {
      this.deps.logger?.warn(
        { err: error, workspaceId: session.agent.workspaceId, conversationId: session.conversation.id },
        "Evidence images could not be read; the answer goes without pictures",
      );
      return null;
    }
  }

  private countDropped(dropped: readonly ReplyBlockDropReason[]): void {
    for (const reason of dropped) {
      this.deps.metrics?.incrementCounter("reply_block_items_dropped_total", {
        help: "Images the model named for a reply block that did not become items, by reason",
        labels: { reason },
      });
    }
  }
}
