'use client'

export function MetadataBadges({
  metadata,
  className = 'mt-1',
}: {
  metadata?: Record<string, string | number | boolean | null> | null
  className?: string
}) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null
  }

  return (
    <div className={`${className} flex flex-wrap gap-1`}>
      {Object.entries(metadata).map(([key, value]) => (
        <span
          key={key}
          className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {key}: {String(value)}
        </span>
      ))}
    </div>
  )
}
