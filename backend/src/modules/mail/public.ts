export {
  EmailService,
  createMailService,
  type EmailDriver,
  type EmailMessage,
  type EmailSendResult,
  type OutboundThreadingHeaders,
  type SentEmailStatus,
} from "./emailService.js";
export { EmailLookupError, EmailSendError } from "./emailSendErrors.js";
export {
  EmailHeaderValueError,
  formatMailbox,
  headerSafeAddress,
  parseRfcMessageId,
  rfcMessageId,
  type HeaderSafeAddress,
  type RfcMessageId,
} from "./emailHeaderValues.js";
export {
  InboundFetchError,
  type DeliveryStatusFacts,
  type InboundEmailMessage,
  type InboundEmailReceiver,
  type InboundEnvelope,
  type InboundVerification,
  type VerifiedInboundEvent,
} from "./inboundEmailReceiver.js";
export {
  normalizeInboundMime,
  readInboundMimeContent,
  type InboundProviderFacts,
} from "./inboundMimeNormalizer.js";
export type {
  DnsRecordView,
  DomainReadiness,
  EmailDomainProvisioner,
  ProviderDomain,
} from "./emailDomainProvisioner.js";
// Provider adapters, for composition to select: Resend's account, or the local spool for development and tests.
export { ResendApiClient } from "./adapters/resendApi.js";
export { ResendEmailDeliveryError, ResendEmailDriver } from "./adapters/resendDriver.js";
export { ResendEmailDomainProvisioner } from "./adapters/resendDomainProvisioner.js";
export { ResendInboundEmailReceiver } from "./adapters/resendInboundReceiver.js";
export { LocalEmailDomainProvisioner } from "./adapters/localDomainProvisioner.js";
export { LocalEmailDriver } from "./adapters/localEmailDriver.js";
export { LocalInboundEmailReceiver } from "./adapters/localInboundReceiver.js";
export { LOCAL_EMAIL_SPOOL_DIR } from "./adapters/localSpool.js";
export {
  readMailErrorClass,
  readMailProviderErrorName,
  readMailProviderStatusCode,
} from "./deliveryErrorDetails.js";
