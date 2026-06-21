import { useEffect, useMemo, useState } from 'react'
import { useStore, useLive } from '../store'
import { client } from '../transport/AnomalyClient'
import { ArgControls } from './ArgControls'
import type { CatalogEntry } from '../types'

const SCOPES = ['object', 'component', 'global'] as const

export function InjectPanel() {
  const catalog = useStore((s) => s.catalog)
  const visible = useStore((s) => s.snapshot?.visible ?? [])
  const selected = useStore((s) => s.selectedActor)
  const selectActor = useStore((s) => s.selectActor)
  const addPendingInject = useStore((s) => s.addPendingInject)
  const { live } = useLive()

  const [anomalyId, setAnomalyId] = useState<string>('')
  const [componentTarget, setComponentTarget] = useState('')
  const [args, setArgs] = useState<Record<string, string>>({})

  const entry: CatalogEntry | undefined = useMemo(
    () => catalog.find((e) => e.id === anomalyId) ?? catalog[0],
    [catalog, anomalyId],
  )
  const entryId = entry?.id

  // Reset arg values to the schema defaults whenever the selected anomaly changes.
  useEffect(() => {
    if (!entry) return
    const init: Record<string, string> = {}
    for (const a of entry.args) init[a.name] = a.default
    setArgs(init)
  }, [entryId]) // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const g: Record<string, CatalogEntry[]> = { object: [], component: [], global: [] }
    for (const e of catalog) (g[e.scope] ?? (g[e.scope] = [])).push(e)
    return g
  }, [catalog])

  if (!entry) return <div className="panel inject"><h3>Inject</h3><div className="dim">loading catalog…</div></div>

  const scope = entry.scope
  const requiredMissing = entry.args.some((a) => a.required && !(args[a.name] ?? a.default).trim())
  const targetMissing = scope === 'object' ? !selected : scope === 'component' ? !componentTarget.trim() : false
  const canInject = live && !requiredMissing && !targetMissing

  const doInject = () => {
    if (!canInject) return
    let target = ''
    let displayTarget = ''
    if (scope === 'object' && selected) { target = '=' + selected; displayTarget = selected }
    else if (scope === 'component') { target = componentTarget.trim(); displayTarget = componentTarget.trim() }

    const argv = entry.args.map((a) => args[a.name] ?? a.default)
    while (argv.length && argv[argv.length - 1].trim() === '') argv.pop() // trim trailing empty optionals

    if (client.inject(entry.id, target, argv)) {
      addPendingInject(entry.id, displayTarget, 'manual') // optimistic only if the command actually went out
    }
  }

  return (
    <div className="panel inject">
      <h3>Inject</h3>

      <label className="field">
        anomaly
        <select value={entry.id} onChange={(e) => setAnomalyId(e.target.value)}>
          {SCOPES.map((g) =>
            grouped[g]?.length ? (
              <optgroup key={g} label={g}>
                {grouped[g].map((e) => <option key={e.id} value={e.id}>{e.id}</option>)}
              </optgroup>
            ) : null,
          )}
        </select>
      </label>
      <div className="usage dim">{entry.description}</div>

      {scope === 'object' && (
        <label className="field">
          target (on-screen)
          <select value={selected ?? ''} onChange={(e) => selectActor(e.target.value || null)}>
            <option value="">— pick / click the preview —</option>
            {visible.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        </label>
      )}
      {scope === 'component' && (
        <label className="field">
          target (name substring)
          <input value={componentTarget} placeholder="e.g. a light name" onChange={(e) => setComponentTarget(e.target.value)} />
        </label>
      )}
      {scope === 'global' && <div className="dim small">global — no target</div>}

      <ArgControls specs={entry.args} values={args} onChange={(name, v) => setArgs((a) => ({ ...a, [name]: v }))} />

      <div className="btn-row">
        <button disabled={!canInject} onClick={doInject}>Inject</button>
        <button disabled={!live} onClick={() => { if (client.revert(entry.id)) useStore.getState().addPendingReverts([entry.id]) }}>Revert</button>
        <button className="danger" disabled={!live} onClick={() => client.revertAll()}>Revert all</button>
      </div>
      {targetMissing && <div className="warn small">pick a target</div>}
      {requiredMissing && <div className="warn small">a required arg is empty</div>}
    </div>
  )
}
