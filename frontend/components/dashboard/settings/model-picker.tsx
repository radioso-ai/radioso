'use client'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { KnownModelsByProvider, LlmProviderName } from '@/lib/api-llm-providers'

/**
 * Single component for choosing a model id for a given provider.
 *
 * - Closed-set providers (openai / gemini / claude) render a Select sourced
 *   from `knownModelsByProvider`, which the backend owns as the single source
 *   of truth.
 * - `openai-compatible` renders a free-form text input because self-hosted
 *   endpoints (vLLM / Ollama / LMStudio / ...) advertise arbitrary identifiers.
 */
export function ModelPicker({
  inputId,
  provider,
  knownModelsByProvider,
  value,
  onChange,
  disabled,
}: {
  inputId: string
  provider: LlmProviderName | ''
  knownModelsByProvider: KnownModelsByProvider
  value: string
  onChange: (next: string) => void
  disabled?: boolean
}) {
  if (provider === '') {
    return (
      <p className="text-xs text-muted-foreground">Choose a provider to pick a model.</p>
    )
  }

  if (provider === 'openai-compatible') {
    return (
      <>
        <Input
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="model identifier accepted by your endpoint"
          disabled={disabled}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          OpenAI-compatible endpoints serve whatever model the upstream advertises (vLLM, Ollama, LMStudio, …).
        </p>
      </>
    )
  }

  const options = knownModelsByProvider[provider] ?? []
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled || options.length === 0}>
      <SelectTrigger id={inputId}>
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
