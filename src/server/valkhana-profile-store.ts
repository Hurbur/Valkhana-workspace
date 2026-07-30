import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  fetchValkhanaActiveProfile,
  type ValkhanaActiveProfile,
} from './valkhana-dashboard-adapter'

export type ProfileMetadataFile = 'handoff-status.json' | 'session-organizer.json'

export class ValkhanaProfileStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValkhanaProfileStoreError'
  }
}

type ResolveActiveProfileStoreOptions = {
  /** Dependency injection keeps dashboard credentials at the adapter boundary. */
  fetchActiveProfile?: () => Promise<ValkhanaActiveProfile>
  /** Test-only override; production uses the operator's real Hermes home. */
  hermesHome?: string
}

function defaultHermesHome(): string {
  return process.env.HERMES_HOME || `${process.env.HOME || ''}/.hermes`
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function isAllowedProfileDirectory(
  root: string,
  profilePath: string,
  profile: ValkhanaActiveProfile,
): boolean {
  if (!isInsideRoot(root, profilePath)) return false
  const rel = relative(root, profilePath)
  if (!rel) return profile.id === 'default' || profile.name === 'default'
  const segments = rel.split(sep)
  return segments.length === 2 && segments[0] === 'profiles' && Boolean(segments[1])
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT')
}

export interface ValkhanaProfileStore {
  readonly profile: Readonly<ValkhanaActiveProfile>
  readJson(file: ProfileMetadataFile): Promise<unknown | null>
  writeJson(file: ProfileMetadataFile, value: unknown): Promise<void>
}

/**
 * Resolves a profile directory through dashboard identity rather than a client
 * request. The path is realpath-checked to reject traversal and symlinks that
 * escape the Hermes profile root before any file operation occurs.
 */
export async function resolveActiveProfileStore(
  options: ResolveActiveProfileStoreOptions = {},
): Promise<ValkhanaProfileStore> {
  const fetchActiveProfile = options.fetchActiveProfile ?? fetchValkhanaActiveProfile
  const profile = await fetchActiveProfile()
  const configuredRoot = options.hermesHome ?? defaultHermesHome()

  let root: string
  let profilePath: string
  try {
    root = await realpath(configuredRoot)
    profilePath = await realpath(profile.path)
  } catch (error) {
    throw new ValkhanaProfileStoreError(
      `dashboard profile directory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!isAllowedProfileDirectory(root, profilePath, profile)) {
    throw new ValkhanaProfileStoreError(
      'dashboard profile path is outside the Hermes profile root',
    )
  }

  const safeFilePath = (file: ProfileMetadataFile): string => {
    const candidate = resolve(profilePath, file)
    if (basename(candidate) !== file || relative(profilePath, candidate).includes('..')) {
      throw new ValkhanaProfileStoreError('profile metadata filename is invalid')
    }
    return candidate
  }

  const assertMetadataTargetSafe = async (target: string): Promise<void> => {
    try {
      const targetStat = await lstat(target)
      if (!targetStat.isSymbolicLink()) return
      const resolvedTarget = await realpath(target)
      if (!isInsideRoot(profilePath, resolvedTarget)) {
        throw new ValkhanaProfileStoreError('profile metadata symlink escapes profile')
      }
    } catch (error) {
      if (isNotFound(error)) return
      if (error instanceof ValkhanaProfileStoreError) throw error
      throw new ValkhanaProfileStoreError(
        `failed to inspect profile metadata target: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    profile: { ...profile, path: profilePath },
    async readJson(file) {
      const target = safeFilePath(file)
      await assertMetadataTargetSafe(target)
      let raw: string
      try {
        raw = await readFile(target, 'utf8')
      } catch (error) {
        if (isNotFound(error)) return null
        throw new ValkhanaProfileStoreError(
          `failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      try {
        return JSON.parse(raw) as unknown
      } catch {
        throw new ValkhanaProfileStoreError(`${file} contains malformed JSON`)
      }
    },
    async writeJson(file, value) {
      const target = safeFilePath(file)
      await assertMetadataTargetSafe(target)
      const temporary = resolve(profilePath, `.${file}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        await rename(temporary, target)
      } catch (error) {
        throw new ValkhanaProfileStoreError(
          `failed to atomically write ${file}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}
