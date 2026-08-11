'use client'

/** Sub-heading for a labelled block inside a settings card. */
export function BlockHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}
