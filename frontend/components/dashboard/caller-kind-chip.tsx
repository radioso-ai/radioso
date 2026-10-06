import { Bot } from 'lucide-react'

/** A terse operator marker for conversations started by another AI agent. */
export function AgentCallerChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">
      <Bot className="h-3 w-3" aria-hidden />
      AI agent
    </span>
  )
}
