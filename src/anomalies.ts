export interface AnomalyMeta {
  name: string
  blurb: string
  color: string
}

const KNOWN: Record<string, AnomalyMeta> = {
  blinking: { name: 'Blinking', blurb: 'An object disappears and reappears.', color: '#7C5CFF' },
  missing_object: { name: 'Missing object', blurb: 'An object vanishes for the whole burst.', color: '#5B6B82' },
  missing_texture: { name: 'Missing texture', blurb: 'Material replaced by a checker pattern.', color: '#1F8A7E' },
  corrupted_texture: { name: 'Corrupted texture', blurb: 'Material replaced by solid magenta.', color: '#D6338A' },
  lod_popping: { name: 'LOD popping', blurb: 'Object flips to a low-detail version.', color: '#E07A1F' },
  camera_clipping: { name: 'Camera clipping', blurb: 'Near geometry is sliced away for the whole capture.', color: '#2D7FF9' },
  stuck_low_mip: { name: 'Blurry texture', blurb: 'A texture stays stuck at low resolution.', color: '#B07A12' },
  uv_corruption: { name: 'UV corruption', blurb: 'Texture coordinates are scrambled.', color: '#0E98B0' },
  normal_corruption: { name: 'Normal corruption', blurb: 'Surface shading turns wrong.', color: '#5E9B1F' },
}

const FALLBACK_COLORS = ['#8A5CF6', '#C2410C', '#0F766E', '#BE185D', '#4D7C0F', '#1D4ED8']

const ALIASES: Record<string, string> = { blink: 'blinking' }

export function canonicalId(id: string): string {
  return ALIASES[id] ?? id
}

export function anomalyMeta(id: string): AnomalyMeta {
  const k = KNOWN[canonicalId(id)]
  if (k) return k
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const pretty = id.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  return { name: pretty, blurb: '', color: FALLBACK_COLORS[h % FALLBACK_COLORS.length] }
}

export const POOL_ORDER = [
  'blinking',
  'missing_texture',
  'corrupted_texture',
  'lod_popping',
  'missing_object',
  'stuck_low_mip',
  'uv_corruption',
  'normal_corruption',
  'camera_clipping',
]

export function sortAnomalyIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ia = POOL_ORDER.indexOf(canonicalId(a))
    const ib = POOL_ORDER.indexOf(canonicalId(b))
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
}
