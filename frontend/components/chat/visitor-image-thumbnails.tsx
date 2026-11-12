'use client'

import { useEffect, useState } from 'react'
import { ChevronRight, ImageOff } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { API_BASE } from '@/lib/api-client'
import { publicChatApi } from '@/lib/api-public-chat'
import type { VisitorImage, VisitorImageSource, VisitorImageThreadConfig } from '@/lib/visitor-image-types'

export type { VisitorImageThreadConfig }
import { useOnceIntersecting } from '@/lib/use-once-intersecting'
import { loadVisitorImage, visitorImageCacheKey } from '@/lib/visitor-image-blob-cache'

/** A teammate's view of a conversation's photos: loaded from the dashboard route, with the agent's readings under the bubble. */
export const operatorVisitorImages = (workspaceId: string, conversationId: string): VisitorImageThreadConfig => ({
  source: { kind: 'operator', workspaceId, conversationId },
  altLabel: 'Photo the visitor sent',
  unavailableLabel: 'Photo unavailable',
  readings: { label: 'What the agent read', unreadLabel: 'The agent could not read this photo.' },
})

/** Test Chat's photos: loaded from the test, with the agent's readings under the operator's bubble. */
export const testChatVisitorImages = (workspaceId: string, agentId: string, executionId: string): VisitorImageThreadConfig => ({
  source: { kind: 'test_chat', workspaceId, agentId, executionId },
  altLabel: 'Photo sent in this test',
  unavailableLabel: 'Photo unavailable',
  readings: { label: 'What the agent read', unreadLabel: 'The agent could not read this photo.' },
})

const THUMBNAIL_CLASS = 'size-24 shrink-0 overflow-hidden rounded-lg'
const PLACEHOLDER_STYLE = { background: 'color-mix(in srgb, currentColor 14%, transparent)' } as const

type TeammateImageSource = Exclude<VisitorImageSource, { kind: 'public' }>

const operatorImageUrl = (source: TeammateImageSource, imageId: string): string => {
  const path = source.kind === 'operator'
    ? `conversations/${encodeURIComponent(source.conversationId)}`
    : `agents/${encodeURIComponent(source.agentId)}/test-executions/${encodeURIComponent(source.executionId)}`
  return `${API_BASE}/${path}/images/${encodeURIComponent(imageId)}?workspaceId=${encodeURIComponent(source.workspaceId)}`
}

type LoadedImage = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error' }

/** The visitor's photo as a blob URL, released when the thumbnail goes away. */
function usePublicImage(publicChatToken: string, imageId: string): LoadedImage {
  const [image, setImage] = useState<LoadedImage>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    loadVisitorImage(visitorImageCacheKey(publicChatToken, imageId), () => publicChatApi.fetchImage(publicChatToken, imageId))
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setImage({ status: 'ready', url: objectUrl })
      })
      .catch(() => {
        if (!cancelled) setImage({ status: 'error' })
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [publicChatToken, imageId])
  return image
}

function Unavailable({ label, className = THUMBNAIL_CLASS }: { label: string; className?: string }) {
  return (
    <div className={`${className} flex items-center justify-center`} style={PLACEHOLDER_STYLE} title={label} role="img" aria-label={label}>
      <ImageOff className="size-5 opacity-70" aria-hidden />
    </div>
  )
}

function PhotoImg({ url, alt, onError, className = THUMBNAIL_CLASS }: { url: string; alt: string; onError?: () => void; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a blob or dashboard-session URL the image optimizer cannot fetch
  return <img src={url} alt={alt} onError={onError} className={`${className} object-cover`} />
}

function PublicThumbnail({ publicChatToken, image, config }: { publicChatToken: string; image: VisitorImage; config: VisitorImageThreadConfig }) {
  const loaded = usePublicImage(publicChatToken, image.id)
  if (loaded.status === 'error') return <Unavailable label={config.unavailableLabel} />
  if (loaded.status === 'loading') return <div className={`${THUMBNAIL_CLASS} animate-pulse`} style={PLACEHOLDER_STYLE} aria-hidden />
  return <PhotoImg url={loaded.url} alt={config.altLabel} />
}

/**
 * A teammate's view of a photo is recorded each time its bytes are sent, so the photo is asked for
 * only once it is on screen, never because it sits somewhere down a long thread.
 */
function OperatorThumbnail({ source, image, config }: { source: TeammateImageSource; image: VisitorImage; config: VisitorImageThreadConfig }) {
  const [failed, setFailed] = useState(false)
  const [frame, seen] = useOnceIntersecting<HTMLDivElement>()
  return (
    <div ref={frame} className={THUMBNAIL_CLASS}>
      {!seen ? <div className="size-full animate-pulse" style={PLACEHOLDER_STYLE} aria-hidden /> : failed
        ? <Unavailable label={config.unavailableLabel} className="size-full" />
        : <PhotoImg url={operatorImageUrl(source, image.id)} alt={config.altLabel} className="size-full" onError={() => setFailed(true)} />}
    </div>
  )
}

/** The photos a visitor message carries, inside the visitor's bubble. */
export function VisitorImageThumbnails({ images, config }: { images: readonly VisitorImage[]; config: VisitorImageThreadConfig }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="visitor-image-thumbnails">
      {images.map((image) =>
        config.source.kind === 'public' ? (
          <PublicThumbnail key={image.id} publicChatToken={config.source.publicChatToken} image={image} config={config} />
        ) : (
          <OperatorThumbnail key={image.id} source={config.source} image={image} config={config} />
        ),
      )}
    </div>
  )
}

/**
 * What the agent read in each photo, under the visitor's bubble where a teammate can open it. The
 * reading is the agent's, so it never sits inside the visitor's own words.
 */
export function VisitorImageReadings({ images, label, unreadLabel }: { images: readonly VisitorImage[] } & NonNullable<VisitorImageThreadConfig['readings']>) {
  if (images.length === 0) return null
  return (
    <Collapsible className="max-w-full self-end text-xs text-muted-foreground">
      <CollapsibleTrigger className="group/readings flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]/readings:rotate-90" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-1 space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
          {images.map((image, index) => (
            <li key={image.id} className="select-text whitespace-pre-wrap">
              <span className="font-medium text-foreground">{index + 1}. </span>
              {image.reading ?? unreadLabel}
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}
