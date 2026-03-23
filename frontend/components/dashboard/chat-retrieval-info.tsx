'use client'

import type { RetrievalInfo, RetrievalTrace } from '@/lib/api'
import { ChatRetrievalTraceDetail } from './chat-retrieval-trace-detail'

interface ChatRetrievalInfoProps {
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
  selectedStageId?: string
  graphMode?: boolean
}

export function ChatRetrievalInfo({
  retrievalInfo,
  retrievalTrace,
  selectedStageId,
  graphMode = false,
}: ChatRetrievalInfoProps) {
  if (!retrievalInfo && !retrievalTrace) {
    return null
  }

  return (
    <div className="space-y-3">
      <ChatRetrievalTraceDetail
        retrievalTrace={retrievalTrace}
        selectedStageId={graphMode ? selectedStageId : undefined}
      />
    </div>
  )
}
