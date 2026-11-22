import { attributeValueText, attributeWrittenText } from '@/components/dashboard/settings/attribute-copy'
import type { ConversationAttribute } from '@/lib/api-types'

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** A conversation's attributes, read-only: each value, who set it and when. Renders nothing when there are none. */
export function ConversationAttributes({
  attributes,
  className,
}: {
  attributes: readonly ConversationAttribute[] | undefined
  className?: string
}) {
  if (!attributes?.length) return null

  return (
    <section aria-label="Attributes" className={className}>
      <div className="rounded-lg border border-border/70 bg-background/70 p-4">
        <p className="text-sm font-medium text-foreground">Attributes</p>
        <dl className="mt-2 grid gap-x-4 gap-y-3 sm:grid-cols-2">
          {attributes.map((attribute) => (
            <div key={attribute.name} className="min-w-0">
              <dt className="font-mono text-[11px] text-muted-foreground">{attribute.name}</dt>
              <dd className="mt-0.5 break-words text-sm text-foreground">
                <span className={attribute.redacted ? 'text-muted-foreground' : undefined}>{attributeValueText(attribute)}</span>
                {attribute.option?.archived ? <span className="text-muted-foreground"> (archived)</span> : null}
              </dd>
              <dd className="text-xs text-muted-foreground">
                {attributeWrittenText(attribute)} · {timestampFormatter.format(new Date(attribute.updatedAt))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
