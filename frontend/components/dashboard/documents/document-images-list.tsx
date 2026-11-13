'use client'

import type { DocumentDetails } from '@/lib/api-types'

type DocumentImage = NonNullable<DocumentDetails['images']>[number]

const ROLE_LABEL: Record<DocumentImage['role'], string> = {
  primary: 'Main picture',
  inline: 'In the text',
}

/** A main picture many documents share is the site's, not this document's: answers never show it as its own. */
const roleLabel = (image: DocumentImage): string => (image.siteWide ? 'Site-wide, not shown' : ROLE_LABEL[image.role])

const WAITING_LABEL: Record<Exclude<DocumentImage['status'], 'stored'>, string> = {
  pending: 'Not fetched yet',
  skipped: 'Not kept',
}

/**
 * The pictures captured from a document's content, the ones an agent with reply cards on can show
 * beside an answer. A stored image shows its thumbnail; one that is waiting or was not kept says so.
 */
export function DocumentImagesList({ images }: { images: DocumentImage[] }) {
  if (images.length === 0) return null

  return (
    <section aria-labelledby="document-images-heading" className="mb-6">
      <h2 id="document-images-heading" className="mb-2 text-sm font-medium text-foreground">
        Images
      </h2>
      <ul className="flex flex-wrap gap-3">
        {images.map((image) => (
          <li key={image.id} className="w-32">
            {image.status === 'stored' && image.src ? (
              // eslint-disable-next-line @next/next/no-img-element -- a stored copy served by the backend's image route
              <img
                src={image.src}
                alt={image.alt || image.caption || roleLabel(image)}
                loading="lazy"
                className="h-24 w-32 rounded-md border border-border object-cover"
              />
            ) : (
              <div className="flex h-24 w-32 items-center justify-center rounded-md border border-dashed border-border px-2 text-center text-xs text-muted-foreground">
                {WAITING_LABEL[image.status === 'stored' ? 'pending' : image.status]}
              </div>
            )}
            <p className="mt-1 truncate text-xs text-muted-foreground" title={image.caption ?? image.alt}>
              {roleLabel(image)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
