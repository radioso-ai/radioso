'use client'

import { useEffect, useState, type FormEvent } from 'react'

import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useAuth } from '@/lib/auth-context'
import type { UserProfile } from '@/lib/api-types'

/** The signed-in person's own profile. Every member reaches it, whatever their role. */
export function ProfileView() {
  const { setDisplayName } = useAuth()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [draft, setDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    authApi.getProfile()
      .then((loaded) => {
        if (!active) return
        setProfile(loaded)
        setDraft(loaded.displayName ?? '')
        setDisplayName(loaded.displayName)
      })
      .catch((loadError: unknown) => {
        if (active) setError(getApiErrorMessage(loadError, 'Failed to load profile.'))
      })
    return () => {
      active = false
    }
  }, [setDisplayName])

  const isUnchanged = draft.trim() === (profile?.displayName ?? '')

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setIsSaving(true)
    try {
      const saved = await authApi.updateProfile({ displayName: draft })
      setProfile(saved)
      setDraft(saved.displayName ?? '')
      setDisplayName(saved.displayName)
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to save profile.'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <DashboardPage title="Profile" contentClassName="settings-surface min-h-0 flex-1 overflow-y-auto" contentScroll={false}>
      <form onSubmit={handleSubmit} className="w-full max-w-md space-y-6 p-6">
        <div className="space-y-2">
          <Label htmlFor="profile-display-name">Display name</Label>
          <Input
            id="profile-display-name"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!profile || isSaving}
            aria-describedby="profile-display-name-help"
          />
          <p id="profile-display-name-help" className="text-xs text-muted-foreground">
            Shown to visitors when you reply.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-email">Email</Label>
          <Input id="profile-email" type="email" value={profile?.email ?? ''} readOnly disabled />
        </div>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <Button type="submit" loading={isSaving} disabled={!profile || isUnchanged}>
          Save
        </Button>
      </form>
    </DashboardPage>
  )
}
