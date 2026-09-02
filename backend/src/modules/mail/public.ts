export {
  EmailService,
  NoopEmailDriver,
  LogEmailDriver,
  createMailService,
  type EmailDriver,
  type EmailMessage,
  type EmailSendResult,
  type MailEnv,
} from "./emailService.js";
export { ResendEmailDeliveryError, ResendEmailDriver } from "./adapters/resendDriver.js";
export {
  readMailErrorClass,
  readMailProviderErrorName,
  readMailProviderStatusCode,
} from "./deliveryErrorDetails.js";
