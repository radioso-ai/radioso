import { z } from "zod";

export const CHAT_MESSAGE_MAX_LENGTH = 4_000;
export const RETRIEVAL_QUERY_MAX_LENGTH = 4_000;

export const chatMessageSchema = z.string().min(1).max(CHAT_MESSAGE_MAX_LENGTH);
export const retrievalQuerySchema = z.string().min(1).max(RETRIEVAL_QUERY_MAX_LENGTH);
