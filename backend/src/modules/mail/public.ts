export {
  EmailService,
  createMailService,
  type EmailDriver,
  type EmailMessage,
  type EmailSendResult,
} from "./emailService.js";
export { ResendEmailDeliveryError, ResendEmailDriver } from "./adapters/resendDriver.js";
export {
  readMailErrorClass,
  readMailProviderErrorName,
  readMailProviderStatusCode,
} from "./deliveryErrorDetails.js";
