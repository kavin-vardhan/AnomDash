function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isSnapshot(msg: unknown): boolean {
  if (!isObj(msg) || msg.type !== 'snapshot') return false
  if (!Array.isArray(msg.active) || !Array.isArray(msg.visible)) return false
  if (!isObj(msg.view) || !isObj(msg.session) || !isObj(msg.capture)) return false
  if (!isObj(msg.auto)) return false
  const auto = msg.auto as Record<string, unknown>
  return isObj(auto.pool) && Array.isArray(auto.liveFires)
}

export function isCatalog(msg: unknown): boolean {
  if (!isObj(msg) || msg.type !== 'catalog') return false
  return msg.entries === undefined || Array.isArray(msg.entries)
}
