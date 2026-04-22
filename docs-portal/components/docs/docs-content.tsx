'use client'

import { ArrowRight, CheckCircle2, Info } from 'lucide-react'

import { CodeBlock } from '@/components/docs/code-block'
import { LanguageTabs } from '@/components/docs/language-tabs'
import { Badge } from '@/components/ui/badge'

const sdkExamples = [
  {
    language: 'typescript',
    label: 'TypeScript',
    filename: 'app.ts',
    code: `import { createRadiosoClient } from '@radioso/typescript-sdk'

const client = createRadiosoClient({
  baseUrl: 'http://localhost:8080',
  apiToken: process.env.RADIOSO_API_TOKEN!,
})

const response = await client.chat.create({
  query: 'What does the FAQ say about uploaded content?',
  stream: false,
})

console.log(response.answer)`,
  },
  {
    language: 'curl',
    label: 'cURL',
    code: `curl -sS -X POST http://localhost:8080/api/v1/chat \\
  -H "Authorization: Bearer $RADIOSO_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"What does the FAQ say about uploaded content?","stream":false}'`,
  },
]

export function DocsContent({
  highlightedSections,
}: {
  highlightedSections?: string[]
}) {
  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-14">
        <section id="introduction" className="mb-14">
          <div className="mb-5 flex items-center gap-2">
            <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs">v0.1</Badge>
            <Badge variant="outline" className="rounded-full border-emerald-200 bg-emerald-500/5 px-3 py-1 text-xs text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
              Early preview
            </Badge>
          </div>
          <h1 className="max-w-4xl text-5xl font-semibold tracking-tight text-foreground text-balance">Docs for teams that need answers they can defend</h1>
          <p className="mt-5 max-w-4xl text-xl leading-relaxed text-muted-foreground">
            Radioso is built for grounded answers, traceable citations, workspace-scoped controls, and embedded support experiences. This portal is designed to get you to first success quickly and then explain enough of the system that you can trust what you deploy.
          </p>
          <div className="mt-6 rounded-2xl border border-primary/20 bg-primary/7 p-5">
            <div className="flex gap-3">
              <ArrowRight className="mt-0.5 h-5 w-5 text-primary" />
              <p className="text-base leading-relaxed text-primary/95">
                Start with one of three paths: run Radioso locally, embed it on a website, or upload docs and ask through the API.
              </p>
            </div>
          </div>
          {highlightedSections?.length ? <div className="mt-4 text-sm text-muted-foreground">Active filter: {highlightedSections.join(', ')}</div> : null}
        </section>

        <section id="run-locally" className="mb-14">
          <h2 className="mb-4 flex items-center gap-2 text-3xl font-semibold text-foreground">
            <ArrowRight className="h-5 w-5 text-primary" />
            Run locally in 5 minutes
          </h2>
          <p className="mb-6 text-lg leading-relaxed text-muted-foreground">
            The intended local path is the bootstrap script at the repo root. It prepares `backend/.env`, starts Postgres, the backend, the worker, and the frontend, then waits until the stack is healthy.
          </p>
          <CodeBlock code="./run-dev.sh" language="bash" filename="Terminal" showLineNumbers={false} />
        </section>

        <section id="api-first-success" className="mb-14">
          <h2 className="mb-4 text-3xl font-semibold text-foreground">API first success</h2>
          <p className="mb-6 text-lg leading-relaxed text-muted-foreground">
            Reach first success with plain HTTP or the TypeScript SDK: create a session, reveal the workspace token, upload content, and ask one grounded question.
          </p>
          <LanguageTabs examples={sdkExamples} />
        </section>

        <section id="authentication" className="mb-14">
          <h2 className="mb-4 text-3xl font-semibold text-foreground">Authentication</h2>
          <p className="mb-6 text-lg leading-relaxed text-muted-foreground">
            Radioso supports multiple access patterns depending on whether you are using the product UI, the developer API, or the public embed flow.
          </p>
          <CodeBlock code={`Authorization: Bearer YOUR_API_KEY`} language="bash" showLineNumbers={false} />
          <div className="mt-6 rounded-2xl border border-border bg-card p-5">
            <div className="flex gap-3">
              <Info className="mt-0.5 h-5 w-5 text-primary" />
              <div>
                <h4 className="mb-1 font-medium text-foreground">Security best practice</h4>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Never expose workspace API tokens in client-side code. Use them from trusted server environments or backend workflows.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="grounded-answers" className="mb-14">
          <h2 className="mb-4 text-3xl font-semibold text-foreground">Grounded answers</h2>
          <p className="mb-6 text-lg leading-relaxed text-muted-foreground">
            Grounding is a product contract in Radioso, not a marketing flourish. Retrieval settings, citations, and unsupported-answer behavior exist so you can shape and inspect answer quality deliberately.
          </p>
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              <div>
                <span className="font-mono text-sm font-medium text-foreground">Grounded answers</span>
                <span className="ml-2 text-sm text-muted-foreground">use retrieved context instead of unsupported model priors</span>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              <div>
                <span className="font-mono text-sm font-medium text-foreground">Citations</span>
                <span className="ml-2 text-sm text-muted-foreground">stay visible and operator-configurable</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
