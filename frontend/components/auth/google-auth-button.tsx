'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { authApi } from '@/lib/api'

export function GoogleAuthButton({
  label,
  returnTo,
  disabled = false,
}: {
  label: string
  returnTo?: string
  disabled?: boolean
}) {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let active = true
    void authApi.getGoogleLoginStatus().then((status) => {
      if (active) setEnabled(status.enabled)
    })
    return () => {
      active = false
    }
  }, [])

  if (!enabled) return null

  return (
    <>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={disabled}
        onClick={() => window.location.assign(authApi.getGoogleLoginStartUrl({ returnTo }))}
      >
        {label}
      </Button>
    </>
  )
}
