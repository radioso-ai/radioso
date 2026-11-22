'use client'

import { useEffect, useState } from 'react'

import { contextVariablesApi } from '@/lib/api-context-variables'
import { buildAttributeFilterChoices, type AttributeFilterChoice } from '@/lib/conversation-attributes'

/** The workspace's Choice attributes for the Inbox's attribute filter; empty until loaded, or when not enabled. */
export const useInboxAttributeOptions = (enabled: boolean): AttributeFilterChoice[] => {
  const [choices, setChoices] = useState<AttributeFilterChoice[]>([])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false

    void contextVariablesApi.listCatalog()
      .then((response) => {
        if (!cancelled) {
          setChoices(buildAttributeFilterChoices(response.contextVariables))
        }
      })
      .catch(() => {
        // Without the catalog the Inbox shows no attribute filter.
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  return choices
}
