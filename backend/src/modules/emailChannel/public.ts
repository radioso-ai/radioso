export { capToSupportedMode, effectiveEngagementMode, type EngagementMode } from "./mailboxes/effectiveMode.js";
export type { MailboxPolicyChangeUnitOfWork } from "./mailboxes/mailboxPolicyChangeUnitOfWork.js";
export {
  EMAIL_MAILBOX_POLICY_REF_PREFIX,
  EmailHeldReplyChannelScope,
  emailMailboxPolicyRef,
} from "./heldReplyChannelScope.js";
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
export { EmailSendIntentRepository } from "./persistence/emailSendIntentRepository.js";
export { EmailThreadRepository } from "./persistence/emailThreadRepository.js";
export { lockThreadResolution } from "./persistence/threadResolutionLock.js";
export { SendingDomainService } from "./domains/sendingDomainService.js";
export { sendingStateOf } from "./domains/sendingState.js";
export { MAILBOX_SETTING_BOUNDS, MailboxService } from "./mailboxes/mailboxService.js";
export { EventLogReader } from "./eventLog/eventLogReader.js";
export { InboundEventActions } from "./eventLog/inboundEventActions.js";
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
export {
  EmailDeliveryFailureResolver,
  type DeliveryResolutionUnitOfWork,
} from "./operator/emailDeliveryFailureResolver.js";
export { EMAIL_SEND_ACTION_TYPE, emailSendKey, type EmailSendActionPayload } from "./outbound/emailSendAction.js";
export { EmailSendActionHandler } from "./outbound/emailSendActionHandler.js";
export { ProviderDeliveryEvents } from "./outbound/providerDeliveryEvents.js";
export { ProviderSendAttempt } from "./outbound/providerSendAttempt.js";
export { SendIntentWriter, type EmailSendScope, type EmailSendUnitOfWork } from "./outbound/sendIntentWriter.js";
export { SendReconciler } from "./outbound/sendReconciler.js";
export { CloudTasksEmailChannelDrainDispatcher } from "./infra/cloudTasksEmailChannelDrainDispatcher.js";
