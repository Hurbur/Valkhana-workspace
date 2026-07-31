import { describe, expect, it } from 'vitest'
import { WIDGET_CATALOG } from './use-dashboard-layout'

describe('dashboard handoff widgets', () => {
  it('registers both briefing and handoff status as selectable side-rail widgets', () => {
    const widgets = new Map(WIDGET_CATALOG.map((widget) => [widget.id, widget]))

    expect(widgets.get('daily_briefing')).toMatchObject({ column: 'rail', hideable: true })
    expect(widgets.get('handoff_status')).toMatchObject({ column: 'rail', hideable: true })
  })
})
