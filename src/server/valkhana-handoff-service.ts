import {
  applyHandoffStatusPatch,
  createInitialHandoffStatus,
  parseHandoffStatus,
  ValkhanaHandoffStatusError,
  type HandoffActor,
  type HandoffStatusPatch,
  type HandoffStatus,
} from './valkhana-handoff-status'
import { resolveActiveProfileStore } from './valkhana-profile-store'

type ActiveProfileStore = Awaited<ReturnType<typeof resolveActiveProfileStore>>

const mutationTails = new Map<string, Promise<void>>()

async function readHandoffStatusFromStore(
  store: ActiveProfileStore,
): Promise<HandoffStatus> {
  const raw = await store.readJson('handoff-status.json')
  const status = raw
    ? parseHandoffStatus(raw)
    : createInitialHandoffStatus(store.profile.id)

  if (status.profileId !== store.profile.id) {
    throw new ValkhanaHandoffStatusError(
      'handoff status belongs to a different profile',
    )
  }
  return status
}

/**
 * Serialize mutations for one Hermes profile. The complete read, validation,
 * transition, and atomic write live inside the critical section so separate
 * browser and Brain requests cannot act on the same stale handoff state.
 */
async function withProfileMutation<T>(
  profileId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(profileId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  mutationTails.set(profileId, current)

  await previous
  try {
    return await operation()
  } finally {
    release()
    if (mutationTails.get(profileId) === current) {
      mutationTails.delete(profileId)
    }
  }
}

export async function readActiveHandoffStatus(): Promise<{
  store: ActiveProfileStore
  status: HandoffStatus
}> {
  const store = await resolveActiveProfileStore()
  const status = await readHandoffStatusFromStore(store)
  return { store, status }
}

export async function mutateActiveHandoffStatus(
  actor: HandoffActor,
  patch: HandoffStatusPatch,
  options: {
    resolveStore?: () => Promise<ActiveProfileStore>
  } = {},
): Promise<HandoffStatus> {
  const resolveStore = options.resolveStore ?? resolveActiveProfileStore
  const store = await resolveStore()

  return withProfileMutation(store.profile.id, async () => {
    const status = await readHandoffStatusFromStore(store)
    const updated = applyHandoffStatusPatch(status, patch, actor)
    await store.writeJson('handoff-status.json', updated)
    return updated
  })
}
