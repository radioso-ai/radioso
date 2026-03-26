'use client'

export function MetadataBadges({
  metadata,
  className = 'mt-1',
}: {
  metadata?: Record<string, unknown> | null
  className?: string
}) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null
  }

  const entries = Object.entries(metadata).map(([key, value]) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      return [key, String(value)] as const
    }

    return [key, JSON.stringify(value)] as const
  })

  return (
    <div className={`${className} flex flex-wrap gap-1`}>
      {entries.map(([key, value]) => (
        <span
          key={key}
          className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {key}: {value}
        </span>
      ))}
    </div>
  )
}
