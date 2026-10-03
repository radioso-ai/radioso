import { AppError } from "../../../shared/domain/errors.js";
import type { CustomerChannelReplyDeliverer, CustomerReplyRoute } from "../../customerReplyDelivery/public.js";

/**
 * Where a teammate's reply on an email conversation goes. This slice sends no email, so routing
 * refuses before the reply is written: a reply is never recorded as sent while the customer never
 * receives it. The sending slice replaces the refusal with an `email.send` route.
 */
export class EmailCustomerReplyDeliverer implements CustomerChannelReplyDeliverer {
  async route(): Promise<CustomerReplyRoute | null> {
    throw new AppError(409, "email_sending_not_available", "Replies to email conversations cannot be sent yet.");
  }
}
