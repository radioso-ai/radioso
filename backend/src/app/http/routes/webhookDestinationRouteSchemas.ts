import { z } from "zod";

import {
  webhookDestinationCreateSchema,
  webhookDestinationIdSchema,
} from "../../../modules/webhooks/public.js";

export const webhookDestinationBodySchema = webhookDestinationCreateSchema;

export const webhookDestinationIdParamSchema = z.object({
  id: webhookDestinationIdSchema,
});
