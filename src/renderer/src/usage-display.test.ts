import { describe, expect, it } from 'vitest'
import type { ToolUsageLimits } from '../../core/usage'
import { usageDisplay, windowLabel } from './usage-display'

// Synthetic figures only.
const NOW = new Date('2026-10-18T12:00:00').getTime()
const HOUR = 3_600_000

function limits(change: Partial<ToolUsageLimits> = {}): ToolUsageLimits {
  return {
    observedAt: NOW - 2 * 60_000,
    windows: [
      { usedPercent: 16, windowMinutes: 300, resetsAt: NOW + 6.5 * HOUR },
      { usedPercent: 43.4, windowMinutes: 10080, resetsAt: NOW + 3 * 24 * HOUR }
    ],
    limitReached: false,
    ...change
  }
}

describe('usageDisplay', () => {
  it('shows each window with its share and reset time, and no note below the limit', () => {
    const display = usageDisplay(limits(), NOW)
    expect(display.meters.map(({ label, value, level }) => ({ label, value, level }))).toEqual([
      { label: '5h', value: '16%', level: 'normal' },
      { label: 'Week', value: '43%', level: 'normal' }
    ])
    expect(display.note).toBeNull()
    expect(display.summary).toBe(
      '5-hour limit 16% used, resets 18:30; Weekly limit 43% used, resets Wed\u00a012:00.'
    )
  })

  it('turns orange from 80% and red at the limit, with the reset time', () => {
    const display = usageDisplay(
      limits({
        windows: [
          { usedPercent: 100, windowMinutes: 300, resetsAt: NOW + HOUR },
          { usedPercent: 80, windowMinutes: 10080, resetsAt: null }
        ],
        limitReached: true
      }),
      NOW
    )
    expect(display.meters.map((meter) => meter.level)).toEqual(['reached', 'high'])
    expect(display.note).toBe('Limit reached · resets 13:00')
  })

  it('shows a window that reset since the figures were recorded as reset, not its old share', () => {
    const display = usageDisplay(
      limits({ windows: [{ usedPercent: 97, windowMinutes: 300, resetsAt: NOW - 1 }] }),
      NOW
    )
    expect(display.meters[0]).toMatchObject({ percent: null, value: 'Reset', level: 'normal' })
    expect(display.summary).toContain('5-hour limit reset since last update')
  })

  it('clamps a share past 100', () => {
    const display = usageDisplay(
      limits({ windows: [{ usedPercent: 140, windowMinutes: 60, resetsAt: null }] }),
      NOW
    )
    expect(display.meters[0]).toMatchObject({ percent: 100, value: '100%', label: '1h' })
  })

  it.each([
    [null, 'Limit'],
    [300, '5h'],
    [10080, 'Week'],
    [2880, '2d'],
    [90, '90m']
  ])('names a %s-minute window %s', (minutes, label) => {
    expect(windowLabel(minutes)).toBe(label)
  })
})
