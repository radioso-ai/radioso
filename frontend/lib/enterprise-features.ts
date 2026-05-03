export const RADIOSO_EDITION = process.env.NEXT_PUBLIC_RADIOSO_EDITION ?? 'oss'

export const WEBSITE_EMBED_CHANNEL_ENABLED = RADIOSO_EDITION === 'enterprise'
