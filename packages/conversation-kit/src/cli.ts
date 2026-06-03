#!/usr/bin/env node
import { createConversationKit } from "./composition.js";
import { parseCliArgs } from "./cliArgs.js";
import { createConversationKitServer } from "./server.js";

const main = async (): Promise<void> => {
  const options = parseCliArgs(process.argv.slice(2));
  const kit = createConversationKit({
    openAiApiKey: options.openAiApiKey ?? process.env.OPENAI_API_KEY,
    openAiModel: options.model ?? process.env.OPENAI_MODEL,
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
