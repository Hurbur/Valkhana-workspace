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
 *
 * One retry after a short delay: a single dropped request (transient
 * network blip, a moment of dashboard unavailability) used to mean the two
 * surfaces silently disagreed until the user happened to toggle that same
 * session again. This does not turn it into a guaranteed-consistent system
 * (a sustained outage still drifts until the next toggle, which is the
 * accepted tradeoff described above) - it only closes the common transient
 * case for free.
 */
function syncPinToServer(sessionId: string, pinned: boolean, isRetry = false): void {
  if (typeof window === 'undefined') return
  fetch('/api/dashboard/sessions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, pinned }),
  })
    .then((res) => {
      if (!res.ok && !isRetry) {
        setTimeout(() => syncPinToServer(sessionId, pinned, true), 2000)
      }
    })
    .catch(() => {
      if (!isRetry) {
        setTimeout(() => syncPinToServer(sessionId, pinned, true), 2000)
      }
      // Second attempt's own failure is swallowed here - the Session
      // Organizer card's own next GET will simply not reflect this pin
      // until a future successful sync, per the documented tradeoff above.
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
