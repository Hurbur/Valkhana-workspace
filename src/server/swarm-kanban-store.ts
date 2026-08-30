import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const SWARM_KANBAN_LANES = [
  'backlog',
  'todo',
  'ready',
  'running',
  'review',
  'blocked',
  'done',
] as const
export type SwarmKanbanLane = (typeof SWARM_KANBAN_LANES)[number]

export type SwarmKanbanCard = {
  id: string
  title: string
  spec: string
  acceptanceCriteria: Array<string>
  assignedWorker: string | null
  reviewer: string | null
  status: SwarmKanbanLane | string
  missionId: string | null
  reportPath: string | null
  createdBy: string
  createdAt: number
  updatedAt: number
  parents?: Array<string>
  children?: Array<string>
  latestRun?: {
    summary?: string | null
    outcome?: string | null
    status?: string | null
  } | null
  tags?: Array<string>
  source?: string
}

type SwarmKanbanFile = { cards: Array<SwarmKanbanCard> }

type ListFilters = {
  status?: string | null
  assignedWorker?: string | null
  reviewer?: string | null
  missionId?: string | null
}

export type CreateSwarmKanbanCardInput = {
  title: string
  spec?: string
  acceptanceCriteria?: Array<string>
  assignedWorker?: string | null
  reviewer?: string | null
  status?: SwarmKanbanLane | null
  missionId?: string | null
  reportPath?: string | null
  createdBy?: string | null
  parents?: Array<string>
  tags?: Array<string>
  idempotencyKey?: string | null
}

export type UpdateSwarmKanbanCardInput = Partial<
  Omit<CreateSwarmKanbanCardInput, 'createdBy'>
>

const HERMES_HOME =
  process.env.HERMES_HOME ??
  process.env.CLAUDE_HOME ??
  path.join(os.homedir(), '.hermes')
export const SWARM_KANBAN_FILE = path.join(HERMES_HOME, 'swarm2-kanban.json')

function loadKanbanFile(): SwarmKanbanFile {
  if (!fs.existsSync(SWARM_KANBAN_FILE)) return { cards: [] }
  try {
    const raw = fs.readFileSync(SWARM_KANBAN_FILE, 'utf-8').trim()
    const parsed = raw ? (JSON.parse(raw) as Partial<SwarmKanbanFile>) : {}
    return {
      cards: Array.isArray(parsed.cards)
        ? parsed.cards.map((card, index) => normalizeCard(card, index))
        : [],
    }
  } catch (err) {
    console.error(
      `[swarm-kanban-store] Failed to read legacy migration input ${SWARM_KANBAN_FILE}:`,
      err,
    )
    return { cards: [] }
  }
}

function normalizeStatus(value: unknown): SwarmKanbanLane {
  if (value === 'in_progress' || value === 'doing') return 'running'
  return SWARM_KANBAN_LANES.includes(value as SwarmKanbanLane)
    ? (value as SwarmKanbanLane)
    : 'backlog'
}

function normalizeCriteria(value: unknown): Array<string> {
  if (Array.isArray(value))
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  if (typeof value === 'string')
    return value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
  return []
}

function normalizeTags(value: unknown): Array<string> {
  if (Array.isArray(value))
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  if (typeof value === 'string')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  return []
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeCard(
  card: Partial<Omit<SwarmKanbanCard, 'status'>> & {
    id?: string
    title?: string
    status?: SwarmKanbanLane | string | null
  },
  legacyIndex = 0,
): SwarmKanbanCard {
  const now = Date.now()
  return {
    id:
      typeof card.id === 'string' && card.id
        ? card.id
        : `legacy-missing-id-${legacyIndex + 1}`,
    title:
      typeof card.title === 'string' && card.title.trim()
        ? card.title.trim()
        : 'Untitled task',
    spec: typeof card.spec === 'string' ? card.spec : '',
    acceptanceCriteria: normalizeCriteria(card.acceptanceCriteria),
    assignedWorker: optionalString(card.assignedWorker),
    reviewer: optionalString(card.reviewer),
    status: normalizeStatus(card.status),
    missionId: optionalString(card.missionId),
    reportPath: optionalString(card.reportPath),
    createdBy:
      typeof card.createdBy === 'string' && card.createdBy
        ? card.createdBy
        : 'swarm2-kanban',
    createdAt: typeof card.createdAt === 'number' ? card.createdAt : now,
    updatedAt: typeof card.updatedAt === 'number' ? card.updatedAt : now,
    parents: normalizeTags(card.parents),
    children: normalizeTags(card.children),
    latestRun: card.latestRun ?? null,
    tags: normalizeTags(card.tags),
    source: typeof card.source === 'string' ? card.source : undefined,
  }
}

export function listSwarmKanbanCards(
  filters: ListFilters = {},
): Array<SwarmKanbanCard> {
  let cards = loadKanbanFile().cards
  if (filters.status)
    cards = cards.filter(
      (card) => card.status === normalizeStatus(filters.status),
    )
  if (filters.assignedWorker)
    cards = cards.filter(
      (card) => card.assignedWorker === filters.assignedWorker,
    )
  if (filters.reviewer)
    cards = cards.filter((card) => card.reviewer === filters.reviewer)
  if (filters.missionId)
    cards = cards.filter((card) => card.missionId === filters.missionId)
  return [...cards].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title),
  )
}
