import { anomalyMeta } from '../anomalies'

export interface TimelineSeg {
  type: string
  start: number
  end: number
}

export function Timeline({
  total,
  segments,
  progress,
  size = 'md',
  label,
}: {
  total: number
  segments: TimelineSeg[]
  progress?: number
  size?: 'sm' | 'md' | 'lg'
  label?: string
}) {
  const n = Math.max(1, total)
  return (
    <div className={`timeline timeline-${size}`} role="img" aria-label={label ?? 'Anomaly timeline'}>
      {typeof progress === 'number' && <div className="timeline-progress" style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />}
      {segments.map((s, i) => {
        const left = (Math.max(0, s.start) / n) * 100
        const width = Math.max(((Math.max(s.end, s.start) - s.start + 1) / n) * 100, 0.6)
        const meta = anomalyMeta(s.type)
        return (
          <span
            key={`${s.type}-${s.start}-${i}`}
            className="timeline-seg"
            style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: meta.color }}
            title={`${meta.name} · frames ${s.start}–${s.end}`}
          />
        )
      })}
    </div>
  )
}
