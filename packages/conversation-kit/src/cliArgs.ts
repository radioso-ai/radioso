export interface ServeCliOptions {
  command: "serve";
  host?: string;
  port?: number;
  directive?: string;
  agentName?: string;
  openAiApiKey?: string;
  model?: string;
}

const readOptionValue = (args: string[], index: number, name: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing_cli_option_value:${name}`);
  }
  return value;
};

export const parseCliArgs = (args: string[]): ServeCliOptions => {
  const [commandCandidate, ...rest] = args;
  const command = commandCandidate && !commandCandidate.startsWith("--") ? commandCandidate : "serve";
  if (command !== "serve") {
    throw new Error(`unsupported_cli_command:${command}`);
  }
  const optionsArgs = commandCandidate && !commandCandidate.startsWith("--") ? rest : args;
  const options: ServeCliOptions = { command: "serve" };

  for (let index = 0; index < optionsArgs.length; index += 1) {
    const arg = optionsArgs[index];
    switch (arg) {
      case "--host":
        options.host = readOptionValue(optionsArgs, index, arg);
        index += 1;
        break;
      case "--port": {
        const parsed = Number.parseInt(readOptionValue(optionsArgs, index, arg), 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error("invalid_cli_port");
        }
        options.port = parsed;
        index += 1;
        break;
      }
      case "--directive":
        options.directive = readOptionValue(optionsArgs, index, arg);
        index += 1;
        break;
      case "--agent-name":
        options.agentName = readOptionValue(optionsArgs, index, arg);
        index += 1;
        break;
      case "--openai-api-key":
        options.openAiApiKey = readOptionValue(optionsArgs, index, arg);
        index += 1;
        break;
      case "--model":
        options.model = readOptionValue(optionsArgs, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`unsupported_cli_option:${arg}`);
    }
  }

  return options;
};
