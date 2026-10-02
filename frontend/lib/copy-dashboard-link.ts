/**
 * Copies a dashboard link as an absolute URL. The clipboard needs a secure context, so a
 * self-hosted dashboard served over plain HTTP gets `copied: false` and shows `url` instead.
 */
export const copyDashboardLink = async (href: string): Promise<{ copied: boolean; url: string }> => {
  const url = new URL(href, window.location.href).toString()
  try {
    await navigator.clipboard.writeText(url)
    return { copied: true, url }
  } catch {
    return { copied: false, url }
  }
}
