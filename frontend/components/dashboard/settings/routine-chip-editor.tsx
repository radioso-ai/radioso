'use client'

import { useEffect, useMemo, useRef, type JSX } from 'react'

import { AtSign } from 'lucide-react'

import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getSelection, $isRangeSelection, type EditorState } from 'lexical'

import { HeadingNode } from '@lexical/rich-text'

import { ChipNode, type RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
import { ChipTypeaheadPlugin, type RoutineEditorVariable } from '@/components/dashboard/settings/routine-chip-typeahead-plugin'
import { $initializeFromParagraphs, $readProseParagraphs } from '@/components/dashboard/settings/routine-prose-nodes'
import { RoutineVariablesProvider } from '@/components/dashboard/settings/routine-variables-context'
import { Button } from '@/components/ui/button'
import type { RoutineSlotType } from '@/lib/api-types'
import type { ChipDocVariable, ProseParagraph } from '@/lib/routine-prose'

export type { RoutineEditorVariable }

// The Document rows own every structural control — steps, branches, endings, skill
// bindings — so the inline editor's only affordance is inserting a variable, the one piece
// of structure that belongs inside a sentence.
function EditorToolbar() {
  const [editor] = useLexicalComposerContext()

  const insertVariableTrigger = () => {
    editor.focus(() => {
      editor.update(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          selection.insertText('@')
        }
      })
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-input px-1.5 py-1">
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={insertVariableTrigger}>
        <AtSign className="h-4 w-4" />
        Variable
      </Button>
    </div>
  )
}

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

// The routine instruction editor for one document row: plain language plus `@` variable
// chips and `#` skill chips.
export function RoutineInstructionEditor({
  initialContent,
  variables,
  onCreateVariable,
  onChange,
  ariaLabel,
}: {
  initialContent: ProseParagraph[]
  variables: ChipDocVariable[]
  onCreateVariable: (variable: RoutineEditorVariable) => void
  // Every line the author wrote, in order. A step instruction is one string, so the host
  // decides how the lines join — the editor never drops the ones after the first.
  onChange: (paragraphs: ProseParagraph[]) => void
  ariaLabel?: string
}): JSX.Element {
  const reservedRefKinds = useMemo(
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
        <div className="routine-prose-surface rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <EditorToolbar />
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  aria-label={ariaLabel ?? 'Routine'}
                  className="min-h-40 w-full px-3 py-2 text-sm outline-none [&_p]:my-1 [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:leading-tight [&_h1]:text-foreground first:[&_h1]:mt-0"
                />
              }
              placeholder={() => (
                <div className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
                  Write the routine in plain language. Type @ to insert a variable.
                </div>
              )}
              ErrorBoundary={LexicalErrorBoundary}
            />
          </div>
          <HistoryPlugin />
          <OnParagraphChangePlugin onParagraphChange={onChange} />
          <ChipTypeaheadPlugin variables={variables} reservedRefKinds={reservedRefKinds} onCreateVariable={onCreateVariable} />
        </div>
      </RoutineVariablesProvider>
    </LexicalComposer>
  )
}
