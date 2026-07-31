'use client'

import { useEffect, useState } from 'react'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type SessionOrganizeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  sessionTitle: string
}

type OrganizedSessionMetadata = {
  pinned: boolean
  archived: boolean
  project: string | null
  tags: Array<string>
}

type SessionsResponse = {
  sessions?: Array<{ id: string; metadata: OrganizedSessionMetadata }>
  error?: string
}

/**
 * Per-session archive/tag/export/share actions, opened from the sidebar's
 * "..." menu. Previously this menu item only linked out to the dashboard's
 * Session Organizer card - full parity for a single session now lives here
 * instead, using the same `/api/dashboard/sessions*` endpoints the card
 * uses (see session-organizer-card.tsx). Reads the session's current
 * archived/tags state on open rather than assuming it, since the sidebar's
 * own session list (a different backend, see that card's docstring) does
 * not carry this metadata.
 */
export function SessionOrganizeDialog({
  open,
  onOpenChange,
  sessionId,
  sessionTitle,
}: SessionOrganizeDialogProps) {
  const [metadata, setMetadata] = useState<OrganizedSessionMetadata | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [shareStatus, setShareStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'creating' }
    | { kind: 'ready'; url: string; expiresAt: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setShareStatus({ kind: 'idle' })
    fetch(`/api/dashboard/sessions?sessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => res.json())
      .then((body: SessionsResponse) => {
        if (cancelled) return
        const match = body.sessions?.find((s) => s.id === sessionId)
        if (match) {
          setMetadata(match.metadata)
        } else {
          setLoadError(body.error ?? 'session not found in the organizer')
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError('failed to load session metadata')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch('/api/dashboard/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...body }),
      })
      const result = (await res.json()) as { metadata?: OrganizedSessionMetadata; error?: string }
      if (result.metadata) setMetadata(result.metadata)
    } finally {
      setBusy(false)
    }
  }

  function toggleArchived() {
    if (!metadata) return
    void patch({ archived: !metadata.archived })
  }

  function addTag() {
    const tag = tagInput.trim()
    if (!tag || !metadata) return
    if (metadata.tags.includes(tag)) {
      setTagInput('')
      return
    }
    void patch({ tags: [...metadata.tags, tag] }).then(() => setTagInput(''))
  }

  function removeTag(tag: string) {
    if (!metadata) return
    void patch({ tags: metadata.tags.filter((t) => t !== tag) })
  }

  function exportSession(format: 'json' | 'markdown') {
    window.open(
      `/api/dashboard/sessions/export?format=${format}&sessionId=${encodeURIComponent(sessionId)}`,
      '_blank',
    )
  }

  async function createShareLink() {
    setShareStatus({ kind: 'creating' })
    try {
      const res = await fetch('/api/dashboard/sessions/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'markdown', sessionId }),
      })
      const body = (await res.json()) as { id?: string; expiresAt?: string; error?: string }
      if (!res.ok || !body.id || !body.expiresAt) {
        setShareStatus({ kind: 'error', message: body.error ?? 'snapshot creation failed' })
        return
      }
      setShareStatus({
        kind: 'ready',
        url: `${window.location.origin}/api/dashboard/sessions/snapshot/${body.id}`,
        expiresAt: body.expiresAt,
      })
    } catch {
      setShareStatus({ kind: 'error', message: 'snapshot creation failed' })
    }
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="p-4">
          <DialogTitle className="mb-1">Organize session</DialogTitle>
          <DialogDescription className="mb-4 truncate">{sessionTitle}</DialogDescription>

          {loading ? (
            <div className="py-3 text-center text-sm text-primary-500">Loading…</div>
          ) : loadError ? (
            <div className="py-3 text-center text-sm text-red-600">{loadError}</div>
          ) : metadata ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-primary-700">
                  {metadata.archived ? 'Archived' : 'Not archived'}
                </span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={toggleArchived}>
                  {metadata.archived ? 'Unarchive' : 'Archive'}
                </Button>
              </div>

              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-primary-500">
                  Tags
                </div>
                {metadata.tags.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {metadata.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        disabled={busy}
                        onClick={() => removeTag(tag)}
                        className="rounded-full border border-primary-200 px-2 py-0.5 text-xs text-primary-700 hover:bg-primary-100"
                        title="Remove tag"
                      >
                        {tag} ×
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        addTag()
                      }
                    }}
                    placeholder="Add a tag"
                    className="flex-1 rounded-lg border border-primary-200 bg-primary-50 px-3 py-1.5 text-sm text-primary-900 outline-none focus:border-primary-400"
                  />
                  <Button size="sm" disabled={busy || !tagInput.trim()} onClick={addTag}>
                    Add
                  </Button>
                </div>
              </div>

              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-primary-500">
                  Export
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => exportSession('json')}>
                    JSON
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => exportSession('markdown')}>
                    Markdown
                  </Button>
                </div>
              </div>

              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-primary-500">
                  Share
                </div>
                {shareStatus.kind === 'ready' ? (
                  <div className="text-xs text-primary-600">
                    Tailscale-only link, expires{' '}
                    {new Date(shareStatus.expiresAt).toLocaleString()}:
                    <div className="mt-1 break-all">
                      <a
                        href={shareStatus.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary-800 underline"
                      >
                        {shareStatus.url}
                      </a>
                    </div>
                  </div>
                ) : shareStatus.kind === 'error' ? (
                  <div className="text-xs text-red-600">{shareStatus.message}</div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={shareStatus.kind === 'creating'}
                    onClick={createShareLink}
                  >
                    {shareStatus.kind === 'creating' ? 'Creating…' : 'Create share link'}
                  </Button>
                )}
              </div>
            </div>
          ) : null}

          <div className="mt-4 flex justify-end">
            <DialogClose>Close</DialogClose>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
