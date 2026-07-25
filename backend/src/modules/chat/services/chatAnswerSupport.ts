import type { ChatGatewayUsageContext } from "../contracts/chatGateway.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import { renderContextBlock } from "../../context-variables/public.js";
import { SharedAnswerInstructionBuilder } from "../../retrieval/public.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import {
  pageContextConditionFor,
  renderPageContextCondition,
  type PageContextCondition,
} from "./pageRead/pageContextCondition.js";

/**
 * Capability-agnostic answer-composition utilities shared by every terminal answer
 * skill (retrieval, social, identity, …). It knows how to build the instruction
 * block, visitor-context block, and the workspace/usage contexts a model call needs —
 * nothing about whether an answer is grounded. Skills own their own prompt and
 * generation; this just removes the boilerplate they share.
 */
export class ChatAnswerSupport {
  private readonly assistantInstructionBuilder = new SharedAnswerInstructionBuilder();

  buildChatWorkspaceContext(session: PreparedSession): LlmCapabilityResolveInput {
    return {
      workspaceId: session.agent.workspaceId,
      capabilityOverride: session.agent.chatModelOverride ?? undefined,
    };
  }

  buildChatUsageContext(
    session: PreparedSession,
    accountId: string | undefined,
    attemptKey: string,
  ): ChatGatewayUsageContext {
    return {
      accountId: accountId ?? null,
      workspaceId: session.agent.workspaceId,
      conversationId: session.conversation.id,
      messageId: session.userMessage.id,
      surface: "assistant",
      operation: "answer",
      attemptKey,
      ...session.usageAttribution,
    };
  }

  buildAnswerInstructionBlock(session: PreparedSession): string {
    const responseSettings = session.retrieval.responseSettings;
    return this.assistantInstructionBuilder.buildCombinedBlock({
      responseIdentity: session.retrieval.responseIdentity,
      customInstruction: responseSettings?.customInstruction,
      responseLanguagePolicy: responseSettings?.responseLanguagePolicy,
      responseLanguage: session.responseLanguage,
    });
  }

  /** Render the turn's renderable visitor-context fragments (page + always-surfaced variables). */
  buildContextBlock(session: PreparedSession): string {
    return renderContextBlock(session.resolvedContext?.renderFragments ?? []);
  }

  pageContextCondition(session: PreparedSession): PageContextCondition | null {
    return pageContextConditionFor(session.pageReadOutcome);
  }

  buildPromptWithContext(prompt: string, session: PreparedSession): string {
    const blocks = [
      this.buildContextBlock(session),
      renderPageContextCondition(this.pageContextCondition(session)),
    ].filter((block) => block.length > 0);
    return blocks.length > 0 ? `${prompt}\n\n${blocks.join("\n\n")}` : prompt;
  }
}
