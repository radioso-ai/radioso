let fallbackCounter = 0

export const createClientId = (prefix = 'client') => {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)
  if (randomUUID) {
    return randomUUID()
  }

  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER
  const time = Date.now().toString(36)
  const counter = fallbackCounter.toString(36)
  const random = Math.random().toString(36).slice(2, 10)
  return `${prefix}-${time}-${counter}-${random}`
}
