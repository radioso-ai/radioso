import { createHash } from "node:crypto";

import { createClient } from "redis";

import type {
  AbuseControlBatchConsumption,
  AbuseControlConsumption,
  AbuseControlConsumptionInput,
  AbuseControlEntry,
  AbuseControlRepositoryPort,
} from "../contracts/abuseControl.js";

const ENTRY_TTL_MS = 24 * 60 * 60 * 1_000;
const KEY_PREFIX = "radioso:abuse-control:v1";

const findScript = String.raw`
local values = redis.call('HMGET', KEYS[1],
  'attempt_count', 'previous_attempt_count', 'window_started_at_ms',
  'blocked_until_ms', 'created_at_ms', 'updated_at_ms')
if not values[1] then
  return ''
end
return cjson.encode({
  attemptCount = tonumber(values[1]),
  previousAttemptCount = tonumber(values[2]),
  windowStartedAtMs = tonumber(values[3]),
  blockedUntilMs = tonumber(values[4]),
  createdAtMs = tonumber(values[5]),
  updatedAtMs = tonumber(values[6])
})
`;

const saveScript = String.raw`
local redisTime = redis.call('TIME')
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local createdAtMs = tonumber(redis.call('HGET', KEYS[1], 'created_at_ms')) or nowMs
local previousAttemptCount = tonumber(redis.call('HGET', KEYS[1], 'previous_attempt_count')) or 0
local blockedUntilMs = tonumber(ARGV[3])
redis.call('HSET', KEYS[1],
  'attempt_count', ARGV[1],
  'previous_attempt_count', previousAttemptCount,
  'window_started_at_ms', ARGV[2],
  'blocked_until_ms', blockedUntilMs,
  'created_at_ms', createdAtMs,
  'updated_at_ms', nowMs)
redis.call('PEXPIREAT', KEYS[1], math.max(nowMs + tonumber(ARGV[4]), blockedUntilMs))
return cjson.encode({
  attemptCount = tonumber(ARGV[1]),
  previousAttemptCount = previousAttemptCount,
  windowStartedAtMs = tonumber(ARGV[2]),
  blockedUntilMs = blockedUntilMs,
  createdAtMs = createdAtMs,
  updatedAtMs = nowMs
})
`;

/**
 * One script owns both single and batch consumption. Batch rejection leaves every key untouched,
 * matching the Postgres transaction; single rejection persists its block. Redis serializes the
 * script, so concurrent replicas cannot observe the same remaining slot.
 */
const consumeScript = String.raw`
local count = #KEYS
local rollbackOnReject = ARGV[1] == '1'
local staged = {}
local ordered = {}
local rejectedIndex = 0

local function loadState(key)
  if staged[key] then
    return staged[key]
  end
  local values = redis.call('HMGET', key,
    'attempt_count', 'previous_attempt_count', 'window_started_at_ms',
    'blocked_until_ms', 'created_at_ms', 'updated_at_ms')
  if not values[1] then
    return nil
  end
  local state = {
    attemptCount = tonumber(values[1]),
    previousAttemptCount = tonumber(values[2]),
    windowStartedAtMs = tonumber(values[3]),
    blockedUntilMs = tonumber(values[4]),
    createdAtMs = tonumber(values[5]),
    updatedAtMs = tonumber(values[6])
  }
  staged[key] = state
  return state
end

for index = 1, count do
  local argumentOffset = 2 + (index - 1) * 4
  local limit = tonumber(ARGV[argumentOffset])
  local windowMs = tonumber(ARGV[argumentOffset + 1])
  local blockMs = tonumber(ARGV[argumentOffset + 2])
  local nowMs = tonumber(ARGV[argumentOffset + 3])
  local key = KEYS[index]
  local existing = loadState(key)
  local activeBlock = existing and existing.blockedUntilMs > nowMs
  local elapsedMs = existing and (nowMs - existing.windowStartedAtMs) or 0
  local activeWindow = existing and elapsedMs < windowMs
  local held = activeBlock or activeWindow
  local attemptCount
  if activeBlock then
    attemptCount = existing.attemptCount
  elseif activeWindow then
    attemptCount = existing.attemptCount + 1
  else
    attemptCount = 1
  end
  local previousAttemptCount
  if held then
    previousAttemptCount = existing and existing.previousAttemptCount or 0
  elseif existing and elapsedMs < 2 * windowMs then
    previousAttemptCount = existing.attemptCount
  else
    previousAttemptCount = 0
  end
  local windowStartedAtMs = held and existing.windowStartedAtMs or nowMs
  local overlap = math.max(0, 1 - ((nowMs - windowStartedAtMs) / windowMs))
  local weightedAttemptCount = previousAttemptCount * overlap + attemptCount
  local blockedUntilMs
  if activeBlock then
    blockedUntilMs = existing.blockedUntilMs
  elseif weightedAttemptCount > limit then
    blockedUntilMs = nowMs + blockMs
  else
    blockedUntilMs = 0
  end
  local state = {
    attemptCount = attemptCount,
    previousAttemptCount = previousAttemptCount,
    windowStartedAtMs = windowStartedAtMs,
    blockedUntilMs = blockedUntilMs,
    createdAtMs = existing and existing.createdAtMs or nowMs,
    updatedAtMs = nowMs,
    weightedAttemptCount = weightedAttemptCount,
    blocked = blockedUntilMs > nowMs,
    expiresAtMs = math.max(nowMs + tonumber(ARGV[2 + count * 4]), blockedUntilMs)
  }
  staged[key] = state
  ordered[index] = state
  if state.blocked then
    rejectedIndex = index
    break
  end
end

if rejectedIndex == 0 or not rollbackOnReject then
  local writeThrough = rejectedIndex == 0 and count or rejectedIndex
  local written = {}
  for index = 1, writeThrough do
    local key = KEYS[index]
    if not written[key] then
      local state = staged[key]
      redis.call('HSET', key,
        'attempt_count', state.attemptCount,
        'previous_attempt_count', state.previousAttemptCount,
        'window_started_at_ms', state.windowStartedAtMs,
        'blocked_until_ms', state.blockedUntilMs,
        'created_at_ms', state.createdAtMs,
        'updated_at_ms', state.updatedAtMs)
      redis.call('PEXPIREAT', key, state.expiresAtMs)
      written[key] = true
    end
  end
end

return cjson.encode({ entries = ordered, rejectedIndex = rejectedIndex })
`;

interface StoredEntryReply {
  attemptCount: number;
  previousAttemptCount: number;
  windowStartedAtMs: number;
  blockedUntilMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

interface ConsumptionReply extends StoredEntryReply {
  blocked: boolean;
  weightedAttemptCount: number;
}

interface ConsumeScriptReply {
  entries: ConsumptionReply[];
  rejectedIndex: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStoredEntryReply = (value: unknown): value is StoredEntryReply => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredEntryReply>;
  return isFiniteNumber(entry.attemptCount)
    && isFiniteNumber(entry.previousAttemptCount)
    && isFiniteNumber(entry.windowStartedAtMs)
    && isFiniteNumber(entry.blockedUntilMs)
    && isFiniteNumber(entry.createdAtMs)
    && isFiniteNumber(entry.updatedAtMs);
};

const parseStoredEntryReply = (reply: unknown): StoredEntryReply => {
  if (typeof reply !== "string") throw new Error("Redis abuse-control script returned a non-text entry");
  const parsed: unknown = JSON.parse(reply);
  if (!isStoredEntryReply(parsed)) throw new Error("Redis abuse-control script returned an invalid entry");
  return parsed;
};

const parseConsumeReply = (reply: unknown): ConsumeScriptReply => {
  if (typeof reply !== "string") throw new Error("Redis abuse-control script returned a non-text result");
  const parsed: unknown = JSON.parse(reply);
  if (!parsed || typeof parsed !== "object") throw new Error("Redis abuse-control script returned an invalid result");
  const candidate = parsed as Partial<ConsumeScriptReply>;
  if (!Number.isInteger(candidate.rejectedIndex) || !Array.isArray(candidate.entries)) {
    throw new Error("Redis abuse-control script returned an invalid result");
  }
  if (!candidate.entries.every((entry) =>
    isStoredEntryReply(entry)
    && typeof (entry as Partial<ConsumptionReply>).blocked === "boolean"
    && isFiniteNumber((entry as Partial<ConsumptionReply>).weightedAttemptCount)
  )) {
    throw new Error("Redis abuse-control script returned invalid consumption entries");
  }
  return candidate as ConsumeScriptReply;
};

const entryKey = (scope: string, subjectKey: string): string => {
  const digest = createHash("sha256").update(scope).update("\0").update(subjectKey).digest("hex");
  return `${KEY_PREFIX}:${digest}`;
};

const mapEntry = (scope: string, subjectKey: string, reply: StoredEntryReply): AbuseControlEntry => ({
  scope,
  subjectKey,
  attemptCount: reply.attemptCount,
  previousAttemptCount: reply.previousAttemptCount,
  windowStartedAt: new Date(reply.windowStartedAtMs),
  blockedUntil: reply.blockedUntilMs > 0 ? new Date(reply.blockedUntilMs) : null,
  createdAt: new Date(reply.createdAtMs),
  updatedAt: new Date(reply.updatedAtMs),
});

export class RedisAbuseControlRepository implements AbuseControlRepositoryPort {
  private readonly client;
  private connectPromise: Promise<unknown> | undefined;

  constructor(private readonly input: { redisUrl: string; commandTimeoutMs: number }) {
    this.client = createClient({
      url: input.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 128,
      socket: {
        connectTimeout: input.commandTimeoutMs,
        reconnectStrategy: false,
      },
    });
    this.client.on("error", () => undefined);
  }

  async find(scope: string, subjectKey: string): Promise<AbuseControlEntry | null> {
    const reply = await this.eval(findScript, [entryKey(scope, subjectKey)], []);
    if (reply === "") return null;
    return mapEntry(scope, subjectKey, parseStoredEntryReply(reply));
  }

  async save(input: {
    scope: string;
    subjectKey: string;
    attemptCount: number;
    windowStartedAt: Date;
    blockedUntil: Date | null;
  }): Promise<AbuseControlEntry> {
    const reply = await this.eval(saveScript, [entryKey(input.scope, input.subjectKey)], [
      String(input.attemptCount),
      String(input.windowStartedAt.getTime()),
      String(input.blockedUntil?.getTime() ?? 0),
      String(ENTRY_TTL_MS),
    ]);
    return mapEntry(input.scope, input.subjectKey, parseStoredEntryReply(reply));
  }

  async consume(input: AbuseControlConsumptionInput): Promise<AbuseControlConsumption> {
    const reply = await this.consumeInputs([input], false);
    const entry = reply.entries[0];
    if (!entry) throw new Error("Redis abuse-control consumption returned no entry");
    return this.mapConsumption(input, entry);
  }

  async consumeBatch(inputs: readonly AbuseControlConsumptionInput[]): Promise<AbuseControlBatchConsumption> {
    if (inputs.length === 0) return { entries: [], rejected: null };
    const reply = await this.consumeInputs(inputs, true);
    if (reply.rejectedIndex > 0) {
      const index = reply.rejectedIndex - 1;
      const rejected = reply.entries[index];
      if (!rejected) throw new Error("Redis abuse-control batch returned no rejected entry");
      return { entries: [], rejected: this.mapConsumption(inputs[index], rejected) };
    }
    return {
      entries: reply.entries.map((entry, index) => this.mapConsumption(inputs[index], entry)),
      rejected: null,
    };
  }

  async deleteExpired(_now: Date): Promise<void> {
    // Each write carries an absolute TTL, so Redis owns expiry without a scan on the request path.
  }

  async close(): Promise<void> {
    await this.connectPromise?.catch(() => undefined);
    if (this.client.isOpen) await this.client.close();
  }

  private async consumeInputs(
    inputs: readonly AbuseControlConsumptionInput[],
    rollbackOnReject: boolean,
  ): Promise<ConsumeScriptReply> {
    const arguments_ = [rollbackOnReject ? "1" : "0"];
    for (const input of inputs) {
      arguments_.push(
        String(input.limit),
        String(input.windowMs),
        String(input.blockMs),
        String(input.now.getTime()),
      );
    }
    arguments_.push(String(ENTRY_TTL_MS));
    return parseConsumeReply(await this.eval(
      consumeScript,
      inputs.map((input) => entryKey(input.scope, input.subjectKey)),
      arguments_,
    ));
  }

  private mapConsumption(
    input: AbuseControlConsumptionInput,
    reply: ConsumptionReply,
  ): AbuseControlConsumption {
    return {
      entry: mapEntry(input.scope, input.subjectKey, reply),
      blocked: reply.blocked,
      weightedAttemptCount: reply.weightedAttemptCount,
    };
  }

  private async eval(script: string, keys: string[], arguments_: string[]): Promise<unknown> {
    await this.ensureConnected();
    return this.client.withCommandOptions({ timeout: this.input.commandTimeoutMs }).eval(script, {
      keys,
      arguments: arguments_,
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isReady) return;
    this.connectPromise ??= this.client.connect().finally(() => {
      this.connectPromise = undefined;
    });
    await this.connectPromise;
  }
}
