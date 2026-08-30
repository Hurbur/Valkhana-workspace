import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { z } from 'zod'
import { createKanbanCard, getKanbanBackendMeta, KanbanAdapterError, listKanbanCards, updateKanbanCard } from '../../server/kanban-backend'
import { isAuthenticated } from '../../server/auth-middleware'
import { ValkhanaCoreError } from '../../server/valkhana-core-client'

function adapterError(error: unknown) {
  if (error instanceof KanbanAdapterError || error instanceof ValkhanaCoreError) {
    return json({ ok: false, error: error.message }, { status: error.status })
  }
  return json({ ok: false, error: 'ValKhana Core Kanban adapter failed' }, { status: 502 })
}

const AcceptanceCriteriaSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      return value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    }
    return []
  },
  z.array(z.string().trim().min(1).max(5000)).default([]),
)

const TagsSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    }
    return []
  },
  z.array(z.string().trim().min(1).max(120)).default([]),
)

const CreateCardSchema = z.object({
  title: z.string().trim().min(1).max(200),
  spec: z.string().trim().max(5000).optional().default(''),
  acceptanceCriteria: AcceptanceCriteriaSchema,
  assignedWorker: z.string().trim().max(120).optional().nullable(),
  reviewer: z.string().trim().max(120).optional().nullable(),
  status: z.enum(['backlog', 'todo', 'ready', 'running', 'review', 'blocked', 'done']).optional().default('backlog'),
  missionId: z.string().trim().max(200).optional().nullable(),
  reportPath: z.string().trim().max(500).optional().nullable(),
  createdBy: z.string().trim().max(120).optional().default('aurora'),
  parents: z.array(z.string().trim().min(1).max(200)).optional().default([]),
  tags: TagsSchema,
  idempotencyKey: z.string().trim().max(500).optional().nullable(),
})

const UpdateCardSchema = CreateCardSchema.partial().extend({
  id: z.string().trim().min(1),
})

export const Route = createFileRoute('/api/swarm-kanban')({
  server: {
    handlers: {
      // GET/POST/PATCH previously had no auth check at all — unlike every
      // other mutating route in this codebase (mcp/*, skills/*,
      // external-memory/*, knowledge/*, valkhana-*), this let any
      // network-reachable client read, create, or modify kanban cards with
      // no session cookie.
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          return json({
            ok: true,
            cards: await listKanbanCards(),
            backend: getKanbanBackendMeta(),
          })
        } catch (error) {
          return adapterError(error)
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const parsed = CreateCardSchema.safeParse(body)
        if (!parsed.success) {
          return json({ ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') }, { status: 400 })
        }
        const data = parsed.data
        try {
          const card = await createKanbanCard({
            title: data.title,
            spec: data.spec,
            acceptanceCriteria: data.acceptanceCriteria,
            assignedWorker: data.assignedWorker,
            reviewer: data.reviewer,
            status: data.status,
            missionId: data.missionId,
            reportPath: data.reportPath,
            createdBy: data.createdBy,
            parents: data.parents,
            tags: data.tags,
            idempotencyKey: data.idempotencyKey,
          })
          return json({ ok: true, card, backend: getKanbanBackendMeta() }, { status: 201 })
        } catch (error) {
          return adapterError(error)
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const parsed = UpdateCardSchema.safeParse(body)
        if (!parsed.success) {
          return json({ ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') }, { status: 400 })
        }
        const { id, ...updates } = parsed.data
        try {
          const card = await updateKanbanCard(id, updates)
          if (!card) return json({ ok: false, error: 'Card not found' }, { status: 404 })
          return json({ ok: true, card, backend: getKanbanBackendMeta() })
        } catch (error) {
          return adapterError(error)
        }
      },
    },
  },
})
