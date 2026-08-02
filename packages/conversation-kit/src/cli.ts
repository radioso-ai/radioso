#!/usr/bin/env node
import type { ConversationModelGateway } from "@radioso/conversation-contract";

import { createConversationKit } from "./composition.js";
import { parseCliArgs } from "./cliArgs.js";
import { createConversationKitServer } from "./server.js";

/**
 * The OpenAI gateway sits behind its own entry point, and `@radioso/conversation-nlp` is
 * an optional peer, so a host that brings its own gateway never installs the OpenAI SDK.
 * Load it only when the CLI is actually given a key, and turn an absent install into an
 * instruction rather than a module-resolution stack trace.
 */
const createOpenAIGateway = async (
  apiKey: string,
  model: string | undefined,
): Promise<ConversationModelGateway> => {
  const openai = await import("./openai.js").catch(() => {
    throw new Error(
      "conversation_kit_openai_unavailable: install @radioso/conversation-nlp to serve with an OpenAI key, "
      + "or host the kit yourself and pass your own modelGateway.",
    );
  });
  return openai.createOpenAIModelGateway({ apiKey, model });
};

const main = async (): Promise<void> => {
  const options = parseCliArgs(process.argv.slice(2));
  const apiKey = options.openAiApiKey ?? process.env.OPENAI_API_KEY;
  const model = options.model ?? process.env.OPENAI_MODEL;
  const kit = createConversationKit({
    modelGateway: apiKey ? await createOpenAIGateway(apiKey, model) : undefined,
    agent: {
      id: "agent_cli",
      name: options.agentName ?? "Conversation Kit",
    },
    directives: options.directive
      ? [{
        name: "cli-directive",
        condition: { kind: "always" },
        action: options.directive,
      }]
      : [],
  });
  const server = createConversationKitServer({ kit });
  const address = await server.listen({ host: options.host, port: options.port });
  process.stdout.write(`@radioso/conversation-kit listening at ${address.url}\n`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
