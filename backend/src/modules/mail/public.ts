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
} from "./emailDomainProvisioner.js";
export { ResendEmailDeliveryError, ResendEmailDriver } from "./adapters/resendDriver.js";
export {
  readMailErrorClass,
  readMailProviderErrorName,
  readMailProviderStatusCode,
} from "./deliveryErrorDetails.js";
