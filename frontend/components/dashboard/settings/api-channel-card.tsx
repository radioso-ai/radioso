'use client'

import { useMemo, useState } from 'react'
import { Code2, ExternalLink, FileCode } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import {
  CodeSnippet,
  ExampleSelector,
  type ExampleLanguage,
  useInlineWorkspaceToken,
} from '@/components/shared/api-snippets'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

const API_BASE_PATH = process.env.NEXT_PUBLIC_API_BASE_PATH ?? '/backend/api/v1'
const SDK_BASE_PATH = API_BASE_PATH.replace(/\/api\/v1\/?$/, '')
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'http://localhost:3001'
const PLACEHOLDER_ORIGIN = 'https://your-radioso-host'

const tokenLiteral = (apiToken: string | null) => (apiToken ? JSON.stringify(apiToken) : "'radioso_...'")
const curlBearer = (apiToken: string | null) => apiToken ?? '$RADIOSO_API_TOKEN'

const buildCreateDocumentCurl = (origin: string, apiToken: string | null) => `curl ${origin}${API_BASE_PATH}/document \\
  -X POST \\
  -H "Authorization: Bearer ${curlBearer(apiToken)}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Support FAQ","content":"Radioso answers questions grounded in your documents."}'`

const buildAskQuestionCurl = (origin: string, apiToken: string | null) => `curl ${origin}${API_BASE_PATH}/assistant/chat \\
  -X POST \\
  -H "Authorization: Bearer ${curlBearer(apiToken)}" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"What does the support FAQ say?","stream":false}'`

const buildCreateDocumentTypeScript = (origin: string, apiToken: string | null) => `import { createRadiosoClient } from '@radioso/typescript-sdk'

const client = createRadiosoClient({
  baseUrl: '${origin}${SDK_BASE_PATH}',
  apiToken: ${tokenLiteral(apiToken)},
})

await client.documents.create({
  title: 'Support FAQ',
  content: 'Radioso answers questions grounded in your documents.',
})`

const buildAskQuestionTypeScript = () => `// using the client from step 1
const response = await client.chat.create({
  message: 'What does the support FAQ say?',
  stream: false,
})

console.log(response.answer)`

export function ApiChannelCard({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { apiToken, apiTokenError, isApiTokenLoading } = useInlineWorkspaceToken(workspaceId)
  const [exampleLanguage, setExampleLanguage] = useState<ExampleLanguage>('curl')

  const origin = useMemo(
    () => (typeof window === 'undefined' ? PLACEHOLDER_ORIGIN : window.location.origin),
    [],
  )
  const apiBaseUrl = `${origin}${API_BASE_PATH}`

  const isCurl = exampleLanguage === 'curl'
  const createDocumentCode = isCurl
    ? buildCreateDocumentCurl(origin, apiToken)
    : buildCreateDocumentTypeScript(origin, apiToken)
  const askQuestionCode = isCurl
    ? buildAskQuestionCurl(origin, apiToken)
    : buildAskQuestionTypeScript()

  return (
    <SettingsCard
      id="api-channel"
      icon={<Code2 className="h-5 w-5 text-primary" />}
      title="API"
      description="Upload documents and ask questions from server-side code or scripts."
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-foreground">API base URL</Label>
            <CopyValueField value={apiBaseUrl} ariaLabel="Copy API base URL" className="w-full" />
          </div>
          <div className="space-y-2">
            <Label className="text-foreground">API token</Label>
            {isApiTokenLoading ? (
              <div className="flex h-10 items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" />
                Loading workspace API token...
              </div>
            ) : apiTokenError ? (
              <p className="text-sm text-destructive">{apiTokenError}</p>
            ) : apiToken ? (
              <CopyValueField value={apiToken} ariaLabel="Copy API token" className="w-full" truncate />
            ) : null}
          </div>
        </div>

        <div className="space-y-3 rounded-xl bg-muted/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-foreground">
              <FileCode className="h-4 w-4" />
              <Label className="text-foreground">Quick start</Label>
            </div>
            <ExampleSelector value={exampleLanguage} onChange={setExampleLanguage} />
          </div>
          <p className="text-xs text-muted-foreground">
            Send the assistant a document, then ask a question grounded in its contents.
          </p>
          <CodeSnippet label="1. Add a document" code={createDocumentCode} />
          <CodeSnippet label="2. Ask a question" code={askQuestionCode} />
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <a
              href={`${DOCS_URL}/api`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              View full API reference
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}
