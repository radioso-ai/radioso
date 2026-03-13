import OpenAI from "openai";

export class OpenAIClients {
  readonly client: OpenAI;
  readonly chatModel: string;
  readonly vectorModel: string;

  constructor(apiKey: string, chatModel: string, vectorModel: string) {
    this.client = new OpenAI({ apiKey });
    this.chatModel = chatModel;
    this.vectorModel = vectorModel;
  }
}
