import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type PinnedSessionsState = {
  pinnedSessionKeys: Array<string>
  pinSession: (key: string) => void
  unpinSession: (key: string) => void
  togglePinnedSession: (key: string) => void
  isSessionPinned: (key: string) => boolean
}

/**
 * Best-effort sync to the profile-scoped Session Organizer metadata
 * (src/server/valkhana-session-organizer.ts). Confirmed (2026-07-30) that
 * this store's session keys and the Session Organizer's session ids are the
 * same id space in this deployment (dashboard-backed sessions capability) -
 * both surfaces show the identical live session list. Fire-and-forget: this
 * hook's own localStorage state stays the source of truth for the sidebar's
 * own instant UX; a failed sync (offline, dashboard down) never blocks or
 * reverts the local pin/unpin the user just did.
 */
function syncPinToServer(sessionId: string, pinned: boolean): void {
  if (typeof window === 'undefined') return
  fetch('/api/dashboard/sessions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, pinned }),
  }).catch(() => {
    // Best-effort - the Session Organizer card's own next GET will simply
    // not reflect this pin until a future successful sync.
  })
}

export const usePinnedSessionsStore = create<PinnedSessionsState>()(
  persist(
    (set, get) => ({
      pinnedSessionKeys: [],
      pinSession: (key) => {
        if (get().pinnedSessionKeys.includes(key)) return
        set((state) => ({ pinnedSessionKeys: [...state.pinnedSessionKeys, key] }))
        syncPinToServer(key, true)
      },
      unpinSession: (key) => {
        set((state) => ({
          pinnedSessionKeys: state.pinnedSessionKeys.filter(
            (pinnedKey) => pinnedKey !== key,
          ),
        }))
        syncPinToServer(key, false)
      },
      togglePinnedSession: (key) => {
        if (get().isSessionPinned(key)) {
          get().unpinSession(key)
          return
        }
        get().pinSession(key)
      },
      isSessionPinned: (key) => get().pinnedSessionKeys.includes(key),
    }),
    { name: 'pinned-sessions' },
  ),
)

export function usePinnedSessions() {
  const pinnedSessionKeys = usePinnedSessionsStore((s) => s.pinnedSessionKeys)
  const togglePinnedSession = usePinnedSessionsStore(
    (s) => s.togglePinnedSession,
  )
  return { pinnedSessionKeys, togglePinnedSession }
}
