'use client'

import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react'

import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getRoot,
  $isElementNode,
  COMMAND_PRIORITY_LOW,
  KEY_BACKSPACE_COMMAND,
  type EditorState,
} from 'lexical'

import { HeadingNode } from '@lexical/rich-text'

import { $isChipNode, ChipNode, type RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
import { ChipTypeaheadPlugin, type RoutineEditorVariable } from '@/components/dashboard/settings/routine-chip-typeahead-plugin'
import { $initializeFromParagraphs, $readProseParagraphs } from '@/components/dashboard/settings/routine-prose-nodes'
import { RoutineVariablesProvider } from '@/components/dashboard/settings/routine-variables-context'
import type { RoutineSlotType } from '@/lib/api-types'
import type { ChipDocVariable, ProseParagraph } from '@/lib/routine-prose'

export type { RoutineEditorVariable }

function OnParagraphChangePlugin({ onParagraphChange }: { onParagraphChange: (paragraphs: ProseParagraph[]) => void }) {
  const [editor] = useLexicalComposerContext()
  const callbackRef = useRef(onParagraphChange)
  const hasEmittedInitialDocRef = useRef(false)
  useEffect(() => {
    callbackRef.current = onParagraphChange
  })

  useEffect(() => {
    const emit = (editorState: EditorState) => {
      editorState.read(() => {
        callbackRef.current($readProseParagraphs())
      })
    }
    const unregister = editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves }) => {
      // Replacing the callback is not a document edit. Each row receives a new parent
      // callback after a draft update and must not emit again on that alone.
      if (editorState === prevEditorState || (dirtyElements.size === 0 && dirtyLeaves.size === 0)) return
      emit(editorState)
    })

    if (!hasEmittedInitialDocRef.current) {
      hasEmittedInitialDocRef.current = true
      emit(editor.getEditorState())
    }

    return unregister
  }, [editor])

  return null
}

// Backspace on a genuinely empty step (no text, no chips — not just whitespace) removes the
// step instead of doing nothing, so deleting a step the operator has emptied out is a single
// keystroke instead of a trip to the step editor's own trash button. Registered at the same
// priority as a chip's own Backspace handling; the two never actually compete, because a
// selected chip and an empty editor are mutually exclusive states. This also means the "must
// not fire while the @ typeahead is open" requirement holds for free — the typeahead can only
// be open once "@" has been typed, at which point the editor is no longer empty.
function EmptyStepBackspacePlugin({ onEmptyBackspace }: { onEmptyBackspace?: () => void }) {
  const [editor] = useLexicalComposerContext()
  const callbackRef = useRef(onEmptyBackspace)
  useEffect(() => {
    callbackRef.current = onEmptyBackspace
  })

  useEffect(() => editor.registerCommand(KEY_BACKSPACE_COMMAND, (event: KeyboardEvent) => {
    if (!callbackRef.current) return false
    let hasContent = false
    for (const block of $getRoot().getChildren()) {
      if (!$isElementNode(block)) continue
      for (const child of block.getChildren()) {
        if ($isChipNode(child) || child.getTextContent().trim().length > 0) {
          hasContent = true
          break
        }
      }
      if (hasContent) break
    }
    if (hasContent) return false
    // The host removes this editor's whole row on the next render, not this keystroke's
    // native character deletion — left un-prevented, that native default can still land on
    // whatever the focus hand-off moves into (the previous step's editor), clipping a
    // character off text that was never meant to be touched.
    event.preventDefault()
    callbackRef.current()
    return true
  }, COMMAND_PRIORITY_LOW), [editor])

  return null
}

// Opens a step's instruction editor with the caret already at the end, for the one moment
// that matters: right after Backspace removed the step after it, so typing continues where
// the operator left off instead of landing at the start of whatever text is already there.
// `hasRunRef` makes this fire once per mount — a plain click into the field positions its own
// caret and must not be overridden by this running again.
function AutoFocusEndPlugin({ enabled, onDone }: { enabled?: boolean; onDone?: () => void }) {
  const [editor] = useLexicalComposerContext()
  const hasRunRef = useRef(false)
  useEffect(() => {
    if (!enabled || hasRunRef.current) return
    hasRunRef.current = true
    editor.getRootElement()?.focus()
    editor.update(() => {
      $getRoot().selectEnd()
    })
    onDone?.()
  }, [editor, enabled, onDone])

  return null
}

// The routine instruction editor for one document row: plain language plus `@` variable
// chips. A skill runs through a tool step (`+ Step → Tool steps`), never through step text,
// so this surface offers no `#` skill menu.
export function RoutineInstructionEditor({
  initialContent,
  variables,
  onCreateVariable,
  onChange,
  onBlur,
  onEmptyBackspace,
  autoFocusEnd,
  onAutoFocused,
  ariaLabel,
}: {
  initialContent: ProseParagraph[]
  variables: ChipDocVariable[]
  onCreateVariable: (variable: RoutineEditorVariable) => void
  // Every line the author wrote, in order. A step instruction is one string, so the host
  // decides how the lines join — the editor never drops the ones after the first.
  onChange: (paragraphs: ProseParagraph[]) => void
  // Leaving the field is what closes editing — every keystroke already saved live through
  // `onChange`, so blur has nothing left to commit but the host's own edit-mode flag.
  onBlur?: () => void
  // Backspace with the step already empty — the host removes the step and decides where
  // focus goes next; this editor only reports the keystroke.
  onEmptyBackspace?: () => void
  // Set once, right after this row opens as the target of that removal, so the caret lands
  // at the end instead of the start.
  autoFocusEnd?: boolean
  onAutoFocused?: () => void
  ariaLabel?: string
}): JSX.Element {
  const reservedRefKinds = useMemo(
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- keeps the literal from widening to string, so fromEntries yields Record<string, RoutineChipKind>.
    () => Object.fromEntries(variables.map((variable) => [variable.id, 'variable' as RoutineChipKind])),
    [variables],
  )
  // A variable's type, required, and mutable flags are owned by the Document row's own
  // controls; the chips here read them and never write back.
  const variablesContext = useMemo(
    () => ({
      variables,
      getType: (refId: string): RoutineSlotType => variables.find((variable) => variable.id === refId)?.type ?? 'text',
      setType: () => undefined,
      getRequired: (refId: string): boolean => variables.find((variable) => variable.id === refId)?.required ?? true,
      setRequired: () => undefined,
      getMutable: (refId: string): boolean => variables.find((variable) => variable.id === refId)?.mutable ?? false,
      setMutable: () => undefined,
      // A skill named here runs as a step of this routine, so its chip offers input and
      // output binding — unlike a skill merely mentioned in a directive action.
      supportsStepBindings: true,
    }),
    [variables],
  )

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // A chip is a real focusable button, so clicking one to open its own dropdown/popover/dialog
  // moves DOM focus there — first to the button itself, then into whatever Radix portals to
  // `document.body` for it — which is not the author leaving the field. React bubbles a blur
  // from any descendant losing focus up to this wrapper (native `blur` does not bubble, but
  // React's synthetic version does), so one handler here covers the content-editable itself
  // and every chip button inside it; only treat it as leaving once focus lands somewhere that
  // is neither inside this editor nor inside one of those portalled chip surfaces.
  const onWrapperBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const related = event.relatedTarget as HTMLElement | null
    if (related && (
      wrapperRef.current?.contains(related)
      || related.closest('[role="menu"], [role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper]')
    )) {
      return
    }
    onBlur?.()
  }, [onBlur])

  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'routine-chip-editor',
        nodes: [ChipNode, HeadingNode],
        onError: (error: Error) => {
          throw error
        },
        theme: {},
        editorState: initialContent.length > 0
          ? () => $initializeFromParagraphs(initialContent)
          : undefined,
      }}
    >
      <RoutineVariablesProvider value={variablesContext}>
        {/* The Document rows own every structural control — steps, branches, endings, skill
            bindings — so this surface carries no chrome of its own beyond a focus ring; typing
            "@" is the only affordance, exactly as the placeholder says. */}
        <div ref={wrapperRef} onBlur={onWrapperBlur} className="routine-prose-surface rounded-sm bg-transparent focus-within:ring-1 focus-within:ring-ring/50">
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  aria-label={ariaLabel ?? 'Routine'}
                  className="w-full text-sm leading-7 outline-none [&_p]:my-0 [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:leading-tight [&_h1]:text-foreground first:[&_h1]:mt-0"
                />
              }
              placeholder={() => (
                <div className="pointer-events-none absolute left-0 top-0 text-sm leading-7 text-muted-foreground">
                  Write the routine in plain language. Type @ to insert a variable.
                </div>
              )}
              ErrorBoundary={LexicalErrorBoundary}
            />
          </div>
          <HistoryPlugin />
          <OnParagraphChangePlugin onParagraphChange={onChange} />
          <EmptyStepBackspacePlugin onEmptyBackspace={onEmptyBackspace} />
          <AutoFocusEndPlugin enabled={autoFocusEnd} onDone={onAutoFocused} />
          <ChipTypeaheadPlugin variables={variables} reservedRefKinds={reservedRefKinds} onCreateVariable={onCreateVariable} variablesOnly />
        </div>
      </RoutineVariablesProvider>
    </LexicalComposer>
  )
}
