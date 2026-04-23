import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { notFound } from 'next/navigation'

type PageProps = {
  params: Promise<{ mdxPath: string[] }>
}

export const generateStaticParams = generateStaticParamsFor('mdxPath')

export async function generateMetadata(props: PageProps) {
  const params = await props.params
  let metadata

  try {
    metadata = (await importPage(params.mdxPath)).metadata
  } catch {
    notFound()
  }

  return metadata
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
