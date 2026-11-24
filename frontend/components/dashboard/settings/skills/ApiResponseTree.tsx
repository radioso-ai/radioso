'use client'

import { useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  describeNode,
  formatJsonPath,
  isAddressablePath,
  isJsonRecord,
  type JsonPathSegment,
} from './api-response-tree'
import { valueCanBeOutput } from './api-request-skill-model'

// An array longer than this shows its first records only; every one shares the first's shape.
const SHOWN_ARRAY_ITEMS = 3

function TreeNode({ label, value, segments, depth, pickedPaths, onPick }: {
  label: string
  value: unknown
  segments: readonly JsonPathSegment[]
  depth: number
  pickedPaths: ReadonlySet<string>
  onPick: (segments: readonly JsonPathSegment[], value: unknown) => void
}) {
  const children: Array<[JsonPathSegment, unknown]> = Array.isArray(value)
    ? value.slice(0, SHOWN_ARRAY_ITEMS).map((item, index): [JsonPathSegment, unknown] => [index, item])
    : isJsonRecord(value)
      ? Object.entries(value)
      : []
  const [open, setOpen] = useState(depth < 2)
  const path = formatJsonPath(segments)
  const isContainer = Array.isArray(value) || isJsonRecord(value)
  const isPickable = valueCanBeOutput(value) && segments.length > 0
  const isAddressable = isAddressablePath(segments)
  const canPick = isPickable && isAddressable
  const isPicked = pickedPaths.has(path)
  const description = describeNode(value)

  return (
    <li>
      <div className="flex items-center gap-1 py-0.5">
        {isContainer ? (
          <button
            type="button"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        ) : <span className="w-5" />}
        <span className="shrink-0 font-mono text-xs text-foreground">{label}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={description}>{description}</span>
        {canPick ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 shrink-0 px-1.5 text-xs"
            disabled={isPicked}
            aria-label={`Add ${path} as output`}
            onClick={() => onPick(segments, value)}
          >
            <Plus className="h-3 w-3" />
            {isPicked ? 'Added' : Array.isArray(value) ? 'List' : 'Output'}
          </Button>
        ) : isPickable ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">Key can&apos;t be addressed</span>
        ) : null}
      </div>
      {isContainer && open && children.length > 0 ? (
        <ul className="ml-2 border-l border-border pl-3">
          {children.map(([key, child]) => (
            <TreeNode
              key={String(key)}
              label={String(key)}
              value={child}
              segments={[...segments, key]}
              depth={depth + 1}
              pickedPaths={pickedPaths}
              onPick={onPick}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** The parsed response as a tree; a scalar adds an output, an array adds a list output. */
export function ApiResponseTree({ body, pickedPaths, onPick }: {
  body: unknown
  pickedPaths: ReadonlySet<string>
  onPick: (segments: readonly JsonPathSegment[], value: unknown) => void
}) {
  return (
    <ul aria-label="Response body" className="max-h-72 min-w-0 overflow-auto rounded-md border border-border bg-muted/20 p-2">
      <TreeNode label="response" value={body} segments={[]} depth={0} pickedPaths={pickedPaths} onPick={onPick} />
    </ul>
  )
}
