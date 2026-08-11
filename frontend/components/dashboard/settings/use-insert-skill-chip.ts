'use client'

import { useCallback, useEffect, useRef } from 'react'

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type TextNode,
} from 'lexical'

import { $createChipNode } from '@/components/dashboard/settings/routine-chip-node'

export function useInsertSkillChip() {
  const [editor] = useLexicalComposerContext()
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  return useCallback(({
    skillName,
    displayName = skillName,
    nodeToReplace = null,
    appendWhenNoSelection = true,
    focusEditor = false,
  }: {
    skillName: string
    displayName?: string
    nodeToReplace?: TextNode | null
    appendWhenNoSelection?: boolean
    focusEditor?: boolean
  }) => {
    if (!mountedRef.current) return
    const insert = () => {
      editor.update(() => {
        const chip = $createChipNode('skill', skillName, displayName)
        const trailing = $createTextNode(' ')
        if (nodeToReplace) {
          nodeToReplace.replace(chip)
          chip.insertAfter(trailing)
          trailing.select()
          return
        }
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          selection.insertNodes([chip, trailing])
          trailing.select()
          return
        }
        if (!appendWhenNoSelection) return
        const root = $getRoot()
        const last = root.getLastChild()
        if ($isElementNode(last)) {
          last.append(chip, trailing)
        } else {
          const paragraph = $createParagraphNode()
          paragraph.append(chip, trailing)
          root.append(paragraph)
        }
        trailing.select()
      })
    }
    if (focusEditor) editor.focus(insert)
    else insert()
  }, [editor])
}
