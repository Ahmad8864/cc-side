import type { Activity } from './protocol.ts'

const frames = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
export function activityFrame(activity: Activity, now: number) {
  const elapsed = Math.max(0, now - activity.startedAt)
  return {
    glyph: frames[Math.floor(elapsed / 120) % frames.length],
    label:
      activity.phase === 'thinking'
        ? 'Thinking'
        : activity.phase === 'compacting'
          ? 'Compacting'
          : activity.phase === 'stopping'
            ? 'Stopping'
            : 'Working',
    seconds: Math.floor(elapsed / 1000),
  }
}
