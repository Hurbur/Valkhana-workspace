import { describe, expect, it } from 'vitest'
import {
  applySessionOrganizerPatch,
  createSessionOrganizer,
  filterOrganizedSessions,
  parseSessionOrganizer,
  parseSessionOrganizerPatch,
} from './valkhana-session-organizer'

describe('session organizer metadata contract', () => {
  it('stores only normalized organizer fields under a stable session id', () => {
    const current = createSessionOrganizer(
      'test2',
      new Date('2026-07-30T12:00:00.000Z'),
    )

    const updated = applySessionOrganizerPatch(
      current,
      parseSessionOrganizerPatch({
        sessionId: 'session-123',
        pinned: true,
        archived: false,
        project: '  Valkhana  ',
        tags: [' UI ', 'security', 'ui'],
      }),
      new Date('2026-07-30T12:01:00.000Z'),
    )

    expect(updated.sessions['session-123']).toEqual({
      pinned: true,
      archived: false,
      project: 'Valkhana',
      tags: ['ui', 'security'],
      updatedAt: '2026-07-30T12:01:00.000Z',
    })
  })

  it('rejects unstable ids and arbitrary metadata fields', () => {
    expect(() =>
      parseSessionOrganizerPatch({
        sessionId: '../escape',
        pinned: true,
      }),
    ).toThrow('sessionId')
    expect(() =>
      parseSessionOrganizerPatch({
        sessionId: 'session-123',
        pinned: true,
        credential: 'must-not-persist',
      }),
    ).toThrow('unsupported field')
  })

  it('fails closed when persisted metadata belongs to another profile', () => {
    expect(() =>
      parseSessionOrganizer(
        {
          version: 1,
          profileId: 'default',
          updatedAt: '2026-07-30T12:00:00.000Z',
          sessions: {},
        },
        'test2',
      ),
    ).toThrow('different profile')
  })

  it('filters joined sessions by project, tag, archive, and pin state', () => {
    const sessions = [
      {
        id: 'one',
        title: 'One',
        metadata: {
          pinned: true,
          archived: false,
          project: 'Valkhana',
          tags: ['security'],
          updatedAt: '2026-07-30T12:00:00.000Z',
        },
      },
      {
        id: 'two',
        title: 'Two',
        metadata: {
          pinned: false,
          archived: true,
          project: 'Atlas',
          tags: ['reference'],
          updatedAt: '2026-07-30T12:00:00.000Z',
        },
      },
    ]

    expect(
      filterOrganizedSessions(sessions, {
        project: 'valkhana',
        tag: 'SECURITY',
        archived: false,
        pinned: true,
      }).map((session) => session.id),
    ).toEqual(['one'])
  })
})
