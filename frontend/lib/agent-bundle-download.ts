import { agentBundleApi, agentBundleFileName } from '@/lib/api'

/**
 * Fetches the agent's bundle and writes it to disk in one action rather than opening it in a tab:
 * it is a document the operator moves, not a page they read. Resolves to the downloaded file's name.
 */
export async function downloadAgentBundle(agentId: string, agentName: string): Promise<string> {
  const bundle = await agentBundleApi.exportBundle(agentId)
  const fileName = agentBundleFileName(agentName, new Date())
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  return fileName
}
