/**
 * Script bodies stay adapter-local. KEYS are the account co-slot expiry ZSET,
 * lease HASH, and counter HASH; ARGV never contains a raw principal id.
 */
export const redisAdmissionScripts = {
  acquire: `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local aggregate = ARGV[2]
local expected, desired = tonumber(ARGV[3]), tonumber(ARGV[4])
if desired ~= expected + 1 then return {0, 'fenced', 1} end
local currentRecord = redis.call('HGET', KEYS[2], aggregate)
local current = tonumber(currentRecord and cjson.decode(currentRecord).localCount or '0')
local replayed = current == desired
if replayed then
  if desired > 0 then
    local expiry = now + tonumber(ARGV[9])
    redis.call('ZADD', KEYS[1], expiry, aggregate)
    redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[9]))
    redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[9]))
    redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[9]))
  end
end
local cleanup = tonumber(ARGV[10])
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, cleanup)
for _, lease in ipairs(expired) do
  local record = redis.call('HGET', KEYS[2], lease)
  if record then
    local metadata = cjson.decode(record)
    for _, field in ipairs({'account', 'workspace:' .. metadata.workspaceId, 'principal:' .. metadata.principalHash}) do
      local next = math.max(0, tonumber(redis.call('HGET', KEYS[3], field) or '0') - metadata.localCount)
      if next == 0 then redis.call('HDEL', KEYS[3], field) else redis.call('HSET', KEYS[3], field, next) end
    end
    redis.call('HDEL', KEYS[2], lease)
  end
  redis.call('ZREM', KEYS[1], lease)
end
currentRecord = redis.call('HGET', KEYS[2], aggregate)
current = tonumber(currentRecord and cjson.decode(currentRecord).localCount or '0')
local hasMore = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)[1] and 1 or 0
if replayed then return {1, 'already_desired', now, now + tonumber(ARGV[9]), #expired, hasMore} end
if #expired == cleanup and hasMore == 1 then
  return {0, 'cleanup_backlog', 250, hasMore}
end
if current ~= expected then return {0, 'fenced', 1} end
local accountCount = tonumber(redis.call('HGET', KEYS[3], 'account') or '0')
local workspaceCount = tonumber(redis.call('HGET', KEYS[3], 'workspace:' .. ARGV[1]) or '0')
local principalCount = tonumber(redis.call('HGET', KEYS[3], 'principal:' .. ARGV[11]) or '0')
local delta = desired - expected
if accountCount + delta > tonumber(ARGV[6]) then return {0, 'account_limit', 1000} end
if workspaceCount + delta > tonumber(ARGV[7]) then return {0, 'workspace_limit', 1000} end
if principalCount + delta > tonumber(ARGV[8]) then return {0, 'principal_limit', 1000} end
if desired < 0 then desired = 0 end
for _, field in ipairs({'account', 'workspace:' .. ARGV[1], 'principal:' .. ARGV[11]}) do
  local next = math.max(0, tonumber(redis.call('HGET', KEYS[3], field) or '0') + delta)
  if next == 0 then redis.call('HDEL', KEYS[3], field) else redis.call('HSET', KEYS[3], field, next) end
end
if desired == 0 then
  redis.call('HDEL', KEYS[2], aggregate)
  redis.call('ZREM', KEYS[1], aggregate)
else
  local expiry = now + tonumber(ARGV[9])
  redis.call('HSET', KEYS[2], aggregate, cjson.encode({workspaceId=ARGV[1], principalHash=ARGV[11], localCount=desired}))
  redis.call('ZADD', KEYS[1], expiry, aggregate)
end
if desired == 0 then redis.call('HDEL', KEYS[3], aggregate) end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[9]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[9]))
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[9]))
return {1, 'ok', now, now + tonumber(ARGV[9]), #expired, hasMore}
`,
  renew: `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local aggregate, expected, desired = ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
if desired ~= expected or desired <= 0 then return {0, 'fenced', 1} end
local record = redis.call('HGET', KEYS[2], aggregate)
local current = tonumber(record and cjson.decode(record).localCount or '0')
local replayed = current == desired
if replayed then
  local expiry = now + tonumber(ARGV[9])
  redis.call('ZADD', KEYS[1], expiry, aggregate)
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[9]))
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[9]))
  redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[9]))
end
local cleanup = tonumber(ARGV[10])
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, cleanup)
for _, lease in ipairs(expired) do
  local record = redis.call('HGET', KEYS[2], lease)
  if record then
    local metadata = cjson.decode(record)
    for _, field in ipairs({'account', 'workspace:' .. metadata.workspaceId, 'principal:' .. metadata.principalHash}) do
      local next = math.max(0, tonumber(redis.call('HGET', KEYS[3], field) or '0') - metadata.localCount)
      if next == 0 then redis.call('HDEL', KEYS[3], field) else redis.call('HSET', KEYS[3], field, next) end
    end
    redis.call('HDEL', KEYS[2], lease)
  end
  redis.call('ZREM', KEYS[1], lease)
end
record = redis.call('HGET', KEYS[2], aggregate)
current = tonumber(record and cjson.decode(record).localCount or '0')
local hasMore = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)[1] and 1 or 0
if replayed then return {1, 'already_desired', now, now + tonumber(ARGV[9]), #expired, hasMore} end
if current ~= expected then return {0, 'fenced', 1} end
if desired <= 0 then return {0, 'fenced', 1} end
local expiry = now + tonumber(ARGV[9])
redis.call('HSET', KEYS[2], aggregate, cjson.encode({workspaceId=ARGV[1], principalHash=ARGV[11], localCount=desired}))
redis.call('ZADD', KEYS[1], expiry, aggregate)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[9]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[9]))
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[9]))
return {1, 'ok', now, expiry, #expired, hasMore}
`,
  release: `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local aggregate = ARGV[2]
local expected, desired = tonumber(ARGV[3]), math.max(0, tonumber(ARGV[4]))
if desired ~= math.max(0, expected - 1) then return {0, 'fenced', 1} end
local record = redis.call('HGET', KEYS[2], aggregate)
local current = tonumber(record and cjson.decode(record).localCount or '0')
local replayed = current == desired
if replayed then
  local expiry = desired > 0 and now + tonumber(ARGV[9]) or 0
  if desired > 0 then
    redis.call('ZADD', KEYS[1], expiry, aggregate)
    redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[9]))
    redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[9]))
    redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[9]))
  end
end
local cleanup = tonumber(ARGV[10])
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, cleanup)
for _, lease in ipairs(expired) do
  local stale = redis.call('HGET', KEYS[2], lease)
  if stale then
    local metadata = cjson.decode(stale)
    for _, field in ipairs({'account', 'workspace:' .. metadata.workspaceId, 'principal:' .. metadata.principalHash}) do
      local next = math.max(0, tonumber(redis.call('HGET', KEYS[3], field) or '0') - metadata.localCount)
      if next == 0 then redis.call('HDEL', KEYS[3], field) else redis.call('HSET', KEYS[3], field, next) end
    end
    redis.call('HDEL', KEYS[2], lease)
  end
  redis.call('ZREM', KEYS[1], lease)
end
record = redis.call('HGET', KEYS[2], aggregate)
current = tonumber(record and cjson.decode(record).localCount or '0')
local hasMore = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)[1] and 1 or 0
if replayed then return {1, 'already_desired', now, desired > 0 and now + tonumber(ARGV[9]) or 0, #expired, hasMore} end
if current ~= expected then return {0, 'fenced', 1} end
local metadata = record and cjson.decode(record) or {workspaceId=ARGV[1], principalHash=ARGV[11], localCount=expected}
local delta = desired - expected
for _, field in ipairs({'account', 'workspace:' .. metadata.workspaceId, 'principal:' .. metadata.principalHash}) do
  local next = math.max(0, tonumber(redis.call('HGET', KEYS[3], field) or '0') + delta)
  if next == 0 then redis.call('HDEL', KEYS[3], field) else redis.call('HSET', KEYS[3], field, next) end
end
if desired == 0 then redis.call('HDEL', KEYS[2], aggregate); redis.call('ZREM', KEYS[1], aggregate)
else redis.call('HSET', KEYS[2], aggregate, cjson.encode({workspaceId=metadata.workspaceId, principalHash=metadata.principalHash, localCount=desired})); redis.call('ZADD', KEYS[1], now + tonumber(ARGV[9]), aggregate) end
if desired > 0 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[9]))
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[9]))
  redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[9]))
end
return {1, 'ok', now, desired > 0 and now + tonumber(ARGV[9]) or 0, #expired, hasMore}
`,
  sweep: `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cleanup = tonumber(ARGV[1])
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, cleanup)
for _, lease in ipairs(expired) do
  local record = redis.call('HGET', KEYS[2], lease)
  if record then
    local metadata = cjson.decode(record)
    for _, field in ipairs({'account', 'workspace:' .. metadata.workspaceId, 'principal:' .. metadata.principalHash}) do
      local next = math.max(0, tonumber(redis.call('HGET', KEYS[3], field) or '0') - metadata.localCount)
      if next == 0 then redis.call('HDEL', KEYS[3], field) else redis.call('HSET', KEYS[3], field, next) end
    end
    redis.call('HDEL', KEYS[2], lease)
  end
  redis.call('ZREM', KEYS[1], lease)
end
local hasMore = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)[1] and 1 or 0
return {1, 'ok', now, #expired, hasMore}
`,
  reconnect: `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local retry = 0
for index = 1, 3 do
  local offset = (index - 1) * 3
  local window, limit, burst = tonumber(ARGV[offset + 1]), tonumber(ARGV[offset + 2]), tonumber(ARGV[offset + 3])
  local record = redis.call('HMGET', KEYS[index], 'tokens', 'updatedAt')
  local tokens, updatedAt = tonumber(record[1]) or burst, tonumber(record[2]) or now
  tokens = math.min(burst, tokens + ((now - updatedAt) / window) * limit)
  if tokens < 1 then retry = math.max(retry, math.ceil(((1 - tokens) * window) / limit)) end
  ARGV[offset + 10] = tostring(tokens)
end
if retry > 0 then return {0, 'reconnect_limit', retry} end
for index = 1, 3 do
  local offset = (index - 1) * 3
  redis.call('HSET', KEYS[index], 'tokens', tonumber(ARGV[offset + 10]) - 1, 'updatedAt', now)
  redis.call('PEXPIRE', KEYS[index], tonumber(ARGV[offset + 1]))
end
return {1, 'ok', now}
`,
} as const;
