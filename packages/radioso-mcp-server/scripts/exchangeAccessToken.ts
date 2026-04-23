import { exchangeAccessToken, parseExchangeArgs, shellEscape, usage } from "./exchangeAccessTokenCore.ts";

const main = async (): Promise<void> => {
  const args = parseExchangeArgs(process.argv.slice(2));
  const result = await exchangeAccessToken(args);
  const accessToken = result.accessToken;

  if (args.format === "token") {
    process.stdout.write(`${accessToken}\n`);
    return;
  }

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`export RADIOSO_MCP_ACCESS_TOKEN='${shellEscape(accessToken)}'\n`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n\n${usage}\n`);
  process.exit(1);
});
