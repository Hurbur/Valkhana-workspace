export interface ValKhanaCoreHealth {
  name: string
  version: string
  status: 'healthy'
}

export type ValKhanaCoreState =
  | { kind: 'online'; health: ValKhanaCoreHealth }
  | { kind: 'offline'; message: string }
  | { kind: 'web'; message: string }

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in globalThis
}

export async function getValKhanaCoreState(): Promise<ValKhanaCoreState> {
  if (!isTauriRuntime()) {
    return {
      kind: 'web',
      message: 'Core health is available in the Tauri desktop target.',
    }
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const health = await invoke<ValKhanaCoreHealth>('valkhana_core_health')
    if (
      health.name !== 'valkhana-core' ||
      health.status !== 'healthy' ||
      typeof health.version !== 'string'
    ) {
      throw new Error('Core returned an invalid health response')
    }
    return { kind: 'online', health }
  } catch (error) {
    return {
      kind: 'offline',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
