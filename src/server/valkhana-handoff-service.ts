import {
  createInitialHandoffStatus,
  parseHandoffStatus,
  ValkhanaHandoffStatusError,
  type HandoffStatus,
} from './valkhana-handoff-status'
import { resolveActiveProfileStore } from './valkhana-profile-store'

export async function readActiveHandoffStatus(): Promise<{
  store: Awaited<ReturnType<typeof resolveActiveProfileStore>>
  status: HandoffStatus
}> {
  const store = await resolveActiveProfileStore()
  const raw = await store.readJson('handoff-status.json')
  const status = raw
    ? parseHandoffStatus(raw)
    : createInitialHandoffStatus(store.profile.id)

  if (status.profileId !== store.profile.id) {
    throw new ValkhanaHandoffStatusError(
      'handoff status belongs to a different profile',
    )
  }
  return { store, status }
}
