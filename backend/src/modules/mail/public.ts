export {
  EmailService,
  createMailService,
  type EmailDriver,
  type EmailMessage,
  type EmailSendResult,
} from "./emailService.js";
export {
  InboundFetchError,
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
