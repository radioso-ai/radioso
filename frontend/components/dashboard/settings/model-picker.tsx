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
 *   from `runnableModelsByProvider`: the catalog models this workspace can run,
 *   which the backend owns as the single source of truth. A saved model outside
 *   that list still shows in the trigger, listed but not selectable.
 * - `openai-compatible` renders a free-form text input because self-hosted
 *   endpoints (vLLM / Ollama / LMStudio / ...) advertise arbitrary identifiers.
 */
export function ModelPicker({
  inputId,
  provider,
  runnableModelsByProvider,
  value,
  onChange,
  onCommit,
  disabled,
  className,
}: {
  inputId: string
  provider: LlmProviderName | ''
  runnableModelsByProvider: KnownModelsByProvider
  value: string
  onChange: (next: string) => void
  onCommit?: (next: string) => void
  disabled?: boolean
  className?: string
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
          onBlur={(event) => onCommit?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommit?.(event.currentTarget.value)
            }
          }}
          placeholder="model identifier accepted by your endpoint"
          disabled={disabled}
          className={className}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          OpenAI-compatible endpoints serve whatever model the upstream advertises (vLLM, Ollama, LMStudio, …). Press Enter or tab out to save.
        </p>
      </>
    )
  }

  const options = runnableModelsByProvider[provider] ?? []
  const savedOutsideOptions = value !== '' && !options.includes(value)
  // An empty list means the catalog has not loaded yet, not that the saved model stopped running.
  const savedUnavailable = savedOutsideOptions && options.length > 0
  return (
    <>
      <Select
        value={value}
        onValueChange={(next) => {
          onChange(next)
          onCommit?.(next)
        }}
        disabled={disabled || options.length === 0}
      >
        <SelectTrigger id={inputId} className={className}>
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          {savedOutsideOptions ? (
            <SelectItem value={value} disabled>
              {savedUnavailable ? `${value} (unavailable)` : value}
            </SelectItem>
          ) : null}
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {savedUnavailable ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          This model isn&apos;t available on this deployment&apos;s shared key, so calls run on the deployment default. Pick an available model, or add your own key in Providers settings.
        </p>
      ) : null}
    </>
  )
}
