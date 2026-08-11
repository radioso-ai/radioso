import type { Metadata } from 'next'
import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { notFound } from 'next/navigation'

import { absoluteUrl, ogImage, site } from '@/lib/site'

type PageProps = {
  params: Promise<{ mdxPath: string[] }>
}

export const generateStaticParams = generateStaticParamsFor('mdxPath')

/** `['api','settings']` -> `/api/settings`; the content root -> `/`. */
function routeFor(mdxPath: string[] | undefined): string {
  const segments = (mdxPath ?? []).filter(Boolean)
  return segments.length ? `/${segments.join('/')}` : '/'
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const params = await props.params
  let metadata: Metadata

  try {
    metadata = (await importPage(params.mdxPath)).metadata
  } catch {
    notFound()
  }

  const url = absoluteUrl(routeFor(params.mdxPath))
  const title = asText(metadata.title) ?? site.name
  const description = asText(metadata.description) ?? site.description

  // Without an explicit per-page canonical every route inherits the root
  // layout's canonical and points search engines at the homepage.
  return {
    ...metadata,
    alternates: { ...metadata.alternates, canonical: url },
    openGraph: {
      ...metadata.openGraph,
      type: 'article',
      url,
      title,
      description,
      siteName: site.name,
      images: [ogImage],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  }
}

export default async function CatchAllPage(props: PageProps) {
  const params = await props.params
  let result

  try {
    result = await importPage(params.mdxPath)
  } catch {
    notFound()
  }

  const { default: Page, toc, metadata } = result

  return <Page params={params} toc={toc} metadata={metadata} />
}
