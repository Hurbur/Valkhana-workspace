import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveActiveProfileStore } from './valkhana-profile-store'

const temporaryRoots: Array<string> = []

async function makeProfile() {
  const hermesHome = await mkdtemp(join(tmpdir(), 'valkhana-profile-store-'))
  temporaryRoots.push(hermesHome)
  const profilePath = join(hermesHome, 'profiles', 'test2')
  await mkdir(profilePath, { recursive: true })
  return { hermesHome, profilePath }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('profile-owned metadata store', () => {
  it('writes and reads handoff metadata only in the dashboard-selected profile directory', async () => {
    const { hermesHome, profilePath } = await makeProfile()
    const store = await resolveActiveProfileStore({
      hermesHome,
      fetchActiveProfile: async () => ({ id: 'test2', name: 'test2', path: profilePath }),
    })

    await store.writeJson('handoff-status.json', { state: 'ready-for-terminal' })

    await expect(store.readJson('handoff-status.json')).resolves.toEqual({
      state: 'ready-for-terminal',
    })
    await expect(readdir(profilePath)).resolves.toEqual(['handoff-status.json'])
  })

  it('rejects a dashboard path that escapes the Hermes profile root', async () => {
    const { hermesHome } = await makeProfile()
    const outsidePath = await mkdtemp(join(tmpdir(), 'valkhana-profile-store-outside-'))
    temporaryRoots.push(outsidePath)

    await expect(
      resolveActiveProfileStore({
        hermesHome,
        fetchActiveProfile: async () => ({
          id: 'test2',
          name: 'test2',
          path: outsidePath,
        }),
      }),
    ).rejects.toThrow('outside the Hermes profile root')
  })

  it('fails closed when the profile-owned JSON is malformed', async () => {
    const { hermesHome, profilePath } = await makeProfile()
    await writeFile(join(profilePath, 'handoff-status.json'), '{not json', 'utf8')
    const store = await resolveActiveProfileStore({
      hermesHome,
      fetchActiveProfile: async () => ({ id: 'test2', name: 'test2', path: profilePath }),
    })

    await expect(store.readJson('handoff-status.json')).rejects.toThrow('malformed JSON')
  })

  it('rejects a metadata symlink that escapes the selected profile before reading it', async () => {
    const { hermesHome, profilePath } = await makeProfile()
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'valkhana-profile-store-outside-file-'))
    const outsideFile = join(outsideDirectory, 'handoff-status.json')
    temporaryRoots.push(outsideDirectory)
    await writeFile(outsideFile, JSON.stringify({ secret: 'must not leak' }), 'utf8')
    await symlink(outsideFile, join(profilePath, 'handoff-status.json'))
    const store = await resolveActiveProfileStore({
      hermesHome,
      fetchActiveProfile: async () => ({ id: 'test2', name: 'test2', path: profilePath }),
    })

    await expect(store.readJson('handoff-status.json')).rejects.toThrow('symlink escapes profile')
  })

  it('rejects a metadata symlink that escapes the selected profile before writing it', async () => {
    const { hermesHome, profilePath } = await makeProfile()
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'valkhana-profile-store-outside-write-'))
    const outsideFile = join(outsideDirectory, 'handoff-status.json')
    temporaryRoots.push(outsideDirectory)
    await writeFile(outsideFile, JSON.stringify({ must: 'remain unchanged' }), 'utf8')
    await symlink(outsideFile, join(profilePath, 'handoff-status.json'))
    const store = await resolveActiveProfileStore({
      hermesHome,
      fetchActiveProfile: async () => ({ id: 'test2', name: 'test2', path: profilePath }),
    })

    await expect(store.writeJson('handoff-status.json', { state: 'idle' })).rejects.toThrow(
      'symlink escapes profile',
    )
    await expect(readFile(outsideFile, 'utf8')).resolves.toContain('remain unchanged')
  })
})
