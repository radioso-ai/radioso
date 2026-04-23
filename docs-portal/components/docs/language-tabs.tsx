'use client'

import { useState } from 'react'

import { CodeBlock } from '@/components/docs/code-block'
import { cn } from '@/lib/utils'

interface CodeExample {
  code: string
  filename?: string
  label: string
  language: string
}

export function LanguageTabs({ examples }: { examples: CodeExample[] }) {
  const [activeTab, setActiveTab] = useState(0)

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex border-b border-border bg-muted/30">
        {examples.map((example, index) => (
          <button
            key={example.language}
            onClick={() => setActiveTab(index)}
            className={cn(
              'px-4 py-3 text-sm font-medium transition-colors',
              activeTab === index ? 'border-b-2 border-primary bg-background text-foreground -mb-px' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {example.label}
          </button>
        ))}
      </div>
      <div className="[&>div]:rounded-none [&>div]:border-0">
        <CodeBlock code={examples[activeTab].code} language={examples[activeTab].language} filename={examples[activeTab].filename} />
      </div>
    </div>
  )
}
