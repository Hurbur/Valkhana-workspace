import { describe, expect, it } from 'vitest'
import { useChatStore } from './chat-store'
import type { ChatMessage } from '../screens/chat/types'

function textMessage(
  id: string,
  role: string,
  text: string,
  historyIndex: number,
): ChatMessage {
  return {
    id,
    role,
    timestamp: 1_700_000_000_000,
    __historyIndex: historyIndex,
    content: [{ type: 'text', text }],
  }
}

describe('chat-store history merge ordering', () => {
  it('preserves persisted history order when messages share a timestamp', () => {
    const messages: Array<ChatMessage> = [
      textMessage('m1', 'user', 'first question', 0),
      textMessage('m2', 'assistant', 'first answer', 1),
      textMessage('m3', 'user', 'follow-up', 2),
    ]

    const merged = useChatStore
      .getState()
      .mergeHistoryMessages('history-order-session', messages)

    expect(merged.map((message) => message.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('accepts local-store historyIndex as a persisted order hint', () => {
    const messages: Array<ChatMessage> = [
      {
        id: 'local-1',
        role: 'user',
        timestamp: 1_700_000_000_000,
        historyIndex: 0,
        content: [{ type: 'text', text: 'local question' }],
      },
      {
        id: 'local-2',
        role: 'assistant',
        timestamp: 1_700_000_000_000,
        historyIndex: 1,
        content: [{ type: 'text', text: 'local answer' }],
      },
      {
        id: 'local-3',
        role: 'user',
        timestamp: 1_700_000_000_000,
        historyIndex: 2,
        content: [{ type: 'text', text: 'local follow-up' }],
      },
    ]

    const merged = useChatStore
      .getState()
      .mergeHistoryMessages('local-history-order-session', messages)

    expect(merged.map((message) => message.id)).toEqual([
      'local-1',
      'local-2',
      'local-3',
    ])
  })

  it('does not drop a distinct realtime message whose text happens to be a superstring of an unrelated finalized history message', () => {
    // Regression test: matchesRealtimeMessage() used to prefix-match
    // histText/rtText in either direction regardless of whether histMsg was
    // still an in-flight optimistic placeholder. Two fully-finalized,
    // genuinely distinct messages where one text is a literal prefix of the
    // other (e.g. "no" then later "no thanks") would incorrectly match, and
    // the second, real message would be silently excluded from the merged
    // transcript.
    const sessionKey = 'prefix-collision-session'
    const historyMessages: Array<ChatMessage> = [
      textMessage('hist-1', 'user', 'no', 0),
    ]
    const realtimeMessage = textMessage('rt-1', 'user', 'no thanks', 1)

    useChatStore.setState((state) => {
      const realtimeMessages = new Map(state.realtimeMessages)
      realtimeMessages.set(sessionKey, [realtimeMessage])
      return { realtimeMessages }
    })

    const merged = useChatStore
      .getState()
      .mergeHistoryMessages(sessionKey, historyMessages)

    const texts = merged.map(
      (message) => (message.content as Array<{ text?: string }>)[0]?.text,
    )
    expect(texts).toContain('no')
    expect(texts).toContain('no thanks')
    expect(merged).toHaveLength(2)
  })
})
