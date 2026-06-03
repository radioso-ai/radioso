'use client'

import { ArrowRight, CheckCircle2, Info } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'

import { CodeBlock } from '@/components/docs/code-block'
import { LanguageTabs } from '@/components/docs/language-tabs'

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
  message: 'What does the FAQ say about uploaded content?',
  stream: false,
})

console.log(response.answer)`,
  },
  {
    language: 'curl',
    label: 'cURL',
    code: `curl -sS -X POST http://localhost:8080/api/v1/assistant/chat \\
  -H "Authorization: Bearer $RADIOSO_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"What does the FAQ say about uploaded content?","stream":false}'`,
  },
]

export function DocsContent() {
  const quickstartCards = [
    {
      href: '/quickstarts/run-locally',
      title: 'Run locally',
      description: 'Bootstrap the full stack with Docker, create a workspace, and verify grounded answers.',
    },
    {
      href: '/quickstarts/website-embed',
      title: 'Embed on your website',
      description: 'Use the local embed harness and validate the origin allowlist before production rollout.',
    },
    {
      href: '/quickstarts/api-first-success',
      title: 'Use the API',
      description: 'Register, reveal a workspace token, upload a document, and ask the first grounded question.',
    },
  ]

  return (
    <>
      <section id="introduction" className="mb-14">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-secondary" />
          <span className="font-medium text-foreground">v0.1</span>
          <span className="text-muted-foreground/70">·</span>
          <span>Early preview</span>
        </div>
        <h1 className="sr-only">Radioso documentation</h1>
        <Image
          src="/radioso-lockup.svg"
          alt="Radioso"
          width={1173}
          height={300}
          priority
          className="h-auto w-full max-w-[420px]"
        />
        <p className="mt-6 max-w-3xl text-xl leading-relaxed text-muted-foreground">
          Grounded answers, traceable citations, and workspace-scoped controls for teams that need to defend what their assistants say.
        </p>
        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <div className="flex gap-3">
            <ArrowRight className="mt-0.5 h-5 w-5 text-primary" />
            <p className="text-base leading-relaxed text-foreground/85">
              Start with one of three paths: run Radioso locally, embed it on a website, or upload docs and ask through the API.
            </p>
          </div>
        </div>
      </section>

      <section className="mb-14 grid gap-4 md:grid-cols-3">
        {quickstartCards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/40 hover:bg-sidebar-accent/40"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-foreground">{card.title}</h2>
              <ArrowRight className="h-4 w-4 text-primary transition-transform group-hover:translate-x-0.5" />
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{card.description}</p>
          </Link>
        ))}
      </section>

      <section id="run-locally" className="mb-14">
        <h2 className="mb-4 flex items-center gap-2 text-3xl font-semibold text-foreground">
          <ArrowRight className="h-5 w-5 text-primary" />
          Run locally in 5 minutes
        </h2>
        <p className="mb-6 text-lg leading-relaxed text-muted-foreground">
          The intended local path is the bootstrap script at the repo root. It prepares `.env`, starts Postgres, the backend, the worker, and the frontend, then waits until the stack is healthy.
        </p>
        <CodeBlock code="./run-dev.sh" language="bash" filename="Terminal" showLineNumbers={false} />
        <div className="mt-4">
          <Link href="/quickstarts/run-locally" className="text-sm font-medium text-primary hover:underline">
            Open the full local quickstart
          </Link>
        </div>
      </section>

      <section id="api-first-success" className="mb-14">
        <h2 className="mb-4 text-3xl font-semibold text-foreground">API first success</h2>
        <p className="mb-6 text-lg leading-relaxed text-muted-foreground">
          Reach first success with plain HTTP or the TypeScript SDK: create a session, reveal the workspace token, upload content, and ask one grounded question.
        </p>
        <LanguageTabs examples={sdkExamples} />
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link href="/quickstarts/api-first-success" className="font-medium text-primary hover:underline">
            Open the full API quickstart
          </Link>
          <Link href="/sdk/typescript-getting-started" className="font-medium text-primary hover:underline">
            Open the SDK guide
          </Link>
        </div>
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
        <div className="mt-4">
          <Link href="/guides/authentication" className="text-sm font-medium text-primary hover:underline">
            Open the authentication guide
          </Link>
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
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link href="/why-radioso/grounded-answers" className="font-medium text-primary hover:underline">
            Why grounded answers matter
          </Link>
          <Link href="/architecture" className="font-medium text-primary hover:underline">
            Read the architecture overview
          </Link>
        </div>
      </section>
    </>
  )
}
