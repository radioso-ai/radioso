import OpenAI from "openai";

export const createOpenAIClient = (input: { apiKey: string; baseURL?: string }): OpenAI =>
  new OpenAI({
    apiKey: input.apiKey,
    baseURL: input.baseURL,
  });
