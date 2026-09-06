'use client'

import { useEffect, useState } from 'react'
import { OperatorMcpConsent } from '@/components/operator-mcp/operator-mcp-consent'

export default function OperatorMcpConsentPage() {
  const [transactionId, setTransactionId] = useState<string | null>(null)
  useEffect(() => {
    queueMicrotask(() => setTransactionId(new URLSearchParams(window.location.search).get('transaction')))
  }, [])
  if (!transactionId) return <main className="flex min-h-screen items-center justify-center p-8 text-sm text-muted-foreground">Missing authorization transaction.</main>
  return <OperatorMcpConsent transactionId={transactionId} />
}

