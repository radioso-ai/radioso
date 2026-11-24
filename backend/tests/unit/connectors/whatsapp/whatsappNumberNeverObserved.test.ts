import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const sourceRoot = new URL("../../../../src/", import.meta.url);

/** The code a WhatsApp number passes through as a person key (#1884). */
const sources = async (): Promise<string[]> => [
  ...(await readdir(new URL("modules/connectors/plugins/whatsapp/", sourceRoot)))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `modules/connectors/plugins/whatsapp/${file}`),
  "shared/domain/channelPersonKey.ts",
  "modules/connectors/services/connectorChatPort.ts",
  "modules/connectors/services/connectorImageTurns.ts",
  "modules/context-variables/contextValueSaves.ts",
  "modules/context-variables/contextVariableResolverService.ts",
  "db/repositories/contextVariableValueWrites.ts",
];

/** A log line, a metric's labels, or a span's attributes: what leaves the process for an observer. */
const OBSERVED_CALL = /\b(?:logger\.(?:trace|debug|info|warn|error|fatal)|\.setAttributes?|\.addEvent|\.inc|\.observe|\.labels)\(/gu;

/** Each observed call's arguments, read to the parenthesis that closes it. */
const observedArguments = (source: string): string[] => [...source.matchAll(OBSERVED_CALL)].map((match) => {
  const start = match.index + match[0].length;
  let depth = 1;
  let end = start;
  while (depth > 0 && end < source.length) {
    if (source[end] === "(") depth += 1;
    if (source[end] === ")") depth -= 1;
    end += 1;
  }
  return source.slice(start, end - 1);
});

/** What names a number: the sender's `wa_id` however it is held, or a person key or its id. */
const NAMES_A_NUMBER = /\bwaId\b|\bwa_id\b|personKey|channelPersonKey|scope\.id|scopeId/u;

/**
 * A tripwire over the source, for the branches the runtime guard (`whatsapp-turn.integration.test.ts`,
 * which reads what real turns let an observer see) does not drive: photos, taps and card fallbacks.
 */
describe("a WhatsApp number is never observed", () => {
  it("names no number in a log line, a metric label or a span attribute", async () => {
    const leaks: string[] = [];
    for (const file of await sources()) {
      const source = await readFile(new URL(file, sourceRoot), "utf8");
      for (const args of observedArguments(source)) {
        if (NAMES_A_NUMBER.test(args)) leaks.push(`${file}: ${args.replaceAll(/\s+/gu, " ").slice(0, 160)}`);
      }
    }

    expect(leaks).toEqual([]);
  });
});
