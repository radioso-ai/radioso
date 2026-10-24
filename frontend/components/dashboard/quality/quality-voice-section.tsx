'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { QualityVoiceStats } from '@/lib/api'
import { voiceStatsRows } from '@/lib/quality-stats'

/**
 * Voice-channel companion to the health row above: call volume and the
 * time-limit/interruption signals that don't apply to text turns. Rendered
 * only when the backend reports voice activity for the current window.
 */
export function QualityVoiceSection({ voice }: { voice: QualityVoiceStats }) {
  return (
    <Card className="mt-3" data-testid="quality-voice-section">
      <CardHeader>
        <CardTitle>Voice</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Calls your agents answered in this period.
        </p>
        <div className="space-y-1.5 text-sm">
          {voiceStatsRows(voice).map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="text-foreground">{row.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
