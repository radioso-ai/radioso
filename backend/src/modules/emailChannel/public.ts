export { capToSupportedMode, effectiveEngagementMode, type EngagementMode } from "./mailboxes/effectiveMode.js";
export type { MailboxPolicyChangeUnitOfWork } from "./mailboxes/mailboxPolicyChangeUnitOfWork.js";
export { routeAddress, type MailboxRoute } from "./mailboxes/mailboxRouting.js";
export { generateOpaqueToken, parsePlusToken } from "./mailboxes/relayTokens.js";
export { extractCustomerText } from "./content/customerText.js";
export { EmailDomainRepository } from "./persistence/emailDomainRepository.js";
export {
  EmailInboundRepository,
  type InboundDeliveryRecord,
  type InboundEventRecord,
} from "./persistence/emailInboundRepository.js";
export { EmailMailboxRepository } from "./persistence/emailMailboxRepository.js";
export { EmailThreadRepository } from "./persistence/emailThreadRepository.js";
export { lockThreadResolution } from "./persistence/threadResolutionLock.js";
export { SendingDomainService } from "./domains/sendingDomainService.js";
export { MailboxService } from "./mailboxes/mailboxService.js";
export { EventLogReader } from "./eventLog/eventLogReader.js";
export { ConversationEmailFactsReader, type ConversationEmailFacts } from "./facts/conversationEmailFacts.js";
export { EmailChannelCopilotView } from "./copilot/emailChannelCopilotView.js";
export {
  NoopEmailChannelDrainDispatcher,
  requestDrainBestEffort,
  type EmailChannelDrainDispatcherPort,
  type EmailChannelDrainStage,
} from "./drains.js";
export { EmailChannelSweep } from "./maintenance/emailChannelSweep.js";
export { EmailCustomerReplyDeliverer } from "./operator/emailCustomerReplyDeliverer.js";
export { CloudTasksEmailChannelDrainDispatcher } from "./infra/cloudTasksEmailChannelDrainDispatcher.js";
