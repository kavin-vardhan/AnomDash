// Display helpers.

// The capture runDir comes back engine-relative (../../../../../.../Saved/AnomalyCaptures/run_<seed>_<ts>);
// show just the run folder name.
export function basename(p: string): string {
  if (!p) return ''
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

export function metres(cm: number): string {
  return cm <= 0 ? 'OFF' : `${(cm / 100).toFixed(0)} m`
}

// Screen-coverage cull readout: 0 (or less) = OFF -> "Off"; otherwise a whole-percent value.
export function coveragePct(v: number): string {
  return v <= 0 ? 'Off' : `${Math.round(v)}%`
}
