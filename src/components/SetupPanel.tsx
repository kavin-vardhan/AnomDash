import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, ChevronDown, FolderOpen, RotateCcw, CheckCircle2, AlertTriangle, Crosshair, X, Shuffle } from 'lucide-react'
import { useStore, useControlValue, useLive, HIDDEN_ANOMALY_IDS } from '../store'
import { useApp } from '../appStore'
import { useTape } from '../recorder'
import { client } from '../transport/AnomalyClient'
import { anomalyMeta, sortAnomalyIds } from '../anomalies'
import { displayName, isTargetable } from '../types'
import { throttle } from '../lib/throttle'
import { Button, Segmented, Section, Switch, Dot } from './ui'
import { Timeline } from './Timeline'

const LENGTHS = [
  { value: '120', label: '4 s' },
  { value: '300', label: '10 s' },
  { value: '900', label: '30 s' },
  { value: '0', label: 'Until I stop' },
]

function PoolRow({ id, fallback, enabled }: { id: string; fallback: boolean; enabled: boolean }) {
  const on = useControlValue<boolean>(`auto.pool.${id}`, fallback)
  const meta = anomalyMeta(id)
  const toggle = (v: boolean) => {
    if (client.autoConfig({ pool: { [id]: v } })) useStore.getState().setOptimistic(`auto.pool.${id}`, v)
  }
  return (
    <label className={`pick-row${on ? ' is-on' : ''}${enabled ? '' : ' is-disabled'}`}>
      <span className="pick-swatch" style={{ background: meta.color }} />
      <span className="pick-text">
        <span className="pick-name">{meta.name}</span>
        <span className="pick-blurb">{meta.blurb}</span>
      </span>
      <input type="checkbox" className="switch" checked={on} disabled={!enabled} onChange={(e) => toggle(e.target.checked)} />
    </label>
  )
}

function RandomMix() {
  const pool = useStore((s) => s.snapshot?.auto.pool)
  const { live } = useLive()
  const ids = useMemo(() => sortAnomalyIds(Object.keys(pool ?? {}).filter((id) => !HIDDEN_ANOMALY_IDS.has(id))), [pool])
  const optimistic = useStore((s) => s.optimistic)
  const onCount = ids.filter((id) => {
    const o = optimistic[`auto.pool.${id}`]
    return o !== undefined ? !!o.value : !!pool?.[id]
  }).length
  const setAll = (v: boolean) => {
    const patch: Record<string, boolean> = {}
    for (const id of ids) patch[id] = v
    if (client.autoConfig({ pool: patch })) for (const id of ids) useStore.getState().setOptimistic(`auto.pool.${id}`, v)
  }
  return (
    <div className="pick-list">
      <div className="pick-head">
        <span>{ids.length ? `${onCount} of ${ids.length} on` : live ? 'Loading anomaly types…' : 'Anomaly types appear once the game is connected.'}</span>
        <span className="grow" />
        <button className="link-btn" disabled={!live} onClick={() => setAll(true)}>All</button>
        <button className="link-btn" disabled={!live} onClick={() => setAll(false)}>None</button>
      </div>
      {ids.map((id) => <PoolRow key={id} id={id} fallback={!!pool?.[id]} enabled={live} />)}
    </div>
  )
}

function OneObject() {
  const catalog = useStore((s) => s.catalog)
  const visible = useStore((s) => s.snapshot?.visible ?? [])
  const selected = useStore((s) => s.selectedActor)
  const selectActor = useStore((s) => s.selectActor)
  const anomalyId = useApp((s) => s.form.anomalyId)
  const setForm = useApp((s) => s.setForm)
  const options = useMemo(() => sortAnomalyIds(catalog.filter(isTargetable).map((e) => e.id)), [catalog])

  useEffect(() => {
    if ((!anomalyId || !options.includes(anomalyId)) && options.length) setForm({ anomalyId: options[0] })
  }, [options, anomalyId, setForm])

  const target = visible.find((v) => v.name === selected)

  return (
    <div className="one-object">
      <div className="field-label">Anomaly</div>
      <div className="chip-grid">
        {options.map((id) => {
          const meta = anomalyMeta(id)
          return (
            <button key={id} className={`chip-opt${id === anomalyId ? ' on' : ''}`} onClick={() => setForm({ anomalyId: id })} title={meta.blurb}>
              <Dot color={meta.color} size={8} />
              {meta.name}
            </button>
          )
        })}
      </div>
      <div className="field-label">Object</div>
      {target ? (
        <div className="target-card">
          <Crosshair size={16} />
          <span className="target-text">
            <span className="target-name">{displayName(target)}</span>
            <span className="target-sub">{target.name}</span>
          </span>
          <button className="icon-btn" aria-label="Clear the target" onClick={() => selectActor(null)}><X size={15} /></button>
        </div>
      ) : (
        <div className="target-empty">
          <Crosshair size={16} />
          <span>Click an object in the live view, or choose one:</span>
        </div>
      )}
      <select className="select" value={selected ?? ''} onChange={(e) => selectActor(e.target.value || null)}>
        <option value="">Objects in view ({visible.length})</option>
        {visible.map((v) => (
          <option key={v.name} value={v.name}>{displayName(v)}{v.asset ? ` — ${v.name}` : ''}</option>
        ))}
      </select>
      {selected && !target && <div className="note warn"><AlertTriangle size={14} /> The selected object has left the view.</div>}
    </div>
  )
}

function SliderRow({ label, hint, min, max, step, value, format, send, path }: {
  label: string; hint: string; min: number; max: number; step: number; value: number; format: (v: number) => string; send: (v: number) => boolean; path: string
}) {
  const shown = useControlValue<number>(path, value)
  const { live } = useLive()
  const throttled = useMemo(() => throttle((v: number) => { send(v) }, 100), [send])
  useEffect(() => () => throttled.cancel(), [throttled])
  const last = useRef(value)
  return (
    <div className="slider-row">
      <div className="slider-top">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{format(shown)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={shown} disabled={!live}
        onChange={(e) => { const v = Number(e.target.value); last.current = v; useStore.getState().setOptimistic(path, v); throttled(v) }}
        onPointerUp={() => { throttled.cancel(); if (send(last.current)) useStore.getState().setOptimistic(path, last.current) }}
        onKeyUp={() => { throttled.cancel(); if (send(last.current)) useStore.getState().setOptimistic(path, last.current) }}
      />
      <div className="slider-hint">{hint}</div>
    </div>
  )
}

const sendPoll = (cm: number) => client.setPollRadius(cm)
const sendCoverage = (pct: number) => client.setMinScreenCoverage(pct)

function Advanced() {
  const form = useApp((s) => s.form)
  const setForm = useApp((s) => s.setForm)
  const session = useStore((s) => s.snapshot?.session)
  const { connected, live } = useLive()
  const [open, setOpen] = useState(false)
  const hud = (which: 'selector' | 'auto', path: string, v: boolean) => {
    if (client.setHud(which, v)) useStore.getState().setOptimistic(path, v)
  }
  const scopingShown = useControlValue<boolean>('session.viewportScoping', !!session?.viewportScoping)
  const selHud = useControlValue<boolean>('session.selectorHud', !!session?.selectorHud)
  const autoHud = useControlValue<boolean>('session.autoHud', !!session?.autoHud)

  return (
    <div className={`advanced${open ? ' is-open' : ''}`}>
      <button className="advanced-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>Advanced options</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="advanced-body">
          <div className="field-label">Image format</div>
          <Segmented
            ariaLabel="Image format"
            value={form.format}
            onChange={(v) => setForm({ format: v })}
            options={[{ value: 'png', label: 'PNG · lossless' }, { value: 'jpeg', label: 'JPEG · smaller' }]}
          />
          <div className="field-label">Saved image size</div>
          <select className="select" value={form.outputHeight} onChange={(e) => setForm({ outputHeight: e.target.value })}>
            <option value="">As rendered (native)</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="540">540p</option>
            <option value="360">360p</option>
          </select>
          <div className="field-help">The game still renders at full size; only the saved images are scaled. Labels stay exact.</div>
          <div className="field-label">Random seed</div>
          <input className="input" value={form.seed} placeholder="Automatic" inputMode="numeric" onChange={(e) => setForm({ seed: e.target.value.replace(/[^0-9]/g, '') })} />
          <div className="field-help">Leave empty for fresh variety. The same seed repeats the same choices.</div>

          <SliderRow
            label="Target distance" path="session.pollRadius" min={0} max={20000} step={100} value={session?.pollRadius ?? 0}
            format={(cm) => (cm <= 0 ? 'Any distance' : `Within ${(cm / 100).toFixed(0)} m`)} send={sendPoll}
            hint="Only objects this close to the player can receive anomalies."
          />
          <SliderRow
            label="Minimum object size" path="session.minScreenCoverage" min={0} max={50} step={1} value={session?.minScreenCoverage ?? 0}
            format={(v) => (v <= 0 ? 'Any size' : `${Math.round(v)}% of screen`)} send={sendCoverage}
            hint="Raise it to skip tiny or far-away objects."
          />
          <div className="advanced-actions">
            <Button variant="secondary" size="sm" icon={<RotateCcw size={15} />} disabled={!connected} onClick={() => client.revertAll()}>
              Reset all anomalies
            </Button>
          </div>
          <div className="field-label">Developer overlays</div>
          <Switch label="Selector HUD" checked={selHud} disabled={!live} onChange={(v) => hud('selector', 'session.selectorHud', v)} />
          <Switch label="Auto-injector HUD" checked={autoHud} disabled={!live} onChange={(v) => hud('auto', 'session.autoHud', v)} />
          <Switch
            label="Viewport scoping"
            checked={scopingShown}
            disabled={!live}
            onChange={(v) => { if (client.setViewportScoping(v)) useStore.getState().setOptimistic('session.viewportScoping', v) }}
          />
        </div>
      )}
    </div>
  )
}

function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function Recording() {
  const cap = useStore((s) => s.snapshot?.capture)
  const tape = useTape()
  const { connected } = useLive()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])
  if (!cap) return null
  const max = cap.maxFrames
  const waiting = cap.framesWritten === 0
  const total = max > 0 ? max : Math.max(cap.framesWritten + 30, 300)
  const types = new Map<string, number>()
  for (const s of tape.segments) types.set(s.id, (types.get(s.id) ?? 0) + 1)

  return (
    <div className="recording">
      <div className="rec-head">
        <span className="rec-dot" />
        <span className="rec-word">{waiting ? 'Waiting for the game window' : 'Recording'}</span>
        <span className="grow" />
        <span className="rec-time">{fmtDuration((now - tape.startedAt) / 1000)}</span>
      </div>
      <div className="rec-count">
        <span className="rec-big">{cap.framesWritten}</span>
        <span className="rec-of">{max > 0 ? `of ${max} frames` : 'frames saved'}</span>
      </div>
      <Timeline total={total} progress={cap.framesWritten / total} segments={tape.segments.map((s) => ({ type: s.id, start: s.start, end: s.end }))} size="lg" />
      {waiting && <div className="note"><Crosshair size={14} /> Click into the game window. Capture begins as soon as it has focus.</div>}
      <div className="rec-fired">
        {types.size === 0 ? (
          <span className="muted">Anomalies will appear here as they fire.</span>
        ) : (
          [...types.entries()].map(([id, n]) => (
            <span key={id} className="fired-chip"><Dot color={anomalyMeta(id).color} size={8} />{anomalyMeta(id).name}<b>{n}</b></span>
          ))
        )}
      </div>
      <Button variant="record" size="lg" icon={<Square size={16} fill="currentColor" />} disabled={!connected} onClick={() => client.captureStop()}>
        Stop capture
      </Button>
    </div>
  )
}

function Saved() {
  const last = useStore((s) => s.lastCaptureStopped)
  const setView = useApp((s) => s.setView)
  const [hidden, setHidden] = useState<number | null>(null)
  if (!last || hidden === last.at) return null
  const slow = typeof last.targetFps === 'number' && typeof last.stampedFps === 'number' && Math.abs(last.stampedFps - last.targetFps) > 0.0005
  return (
    <div className="saved">
      <CheckCircle2 size={20} />
      <div className="saved-text">
        <div className="saved-title">Capture saved · {last.frames} frames</div>
        <div className="saved-sub">{last.sessionId || 'New session'}</div>
        {slow && <div className="saved-warn">The PC couldn’t hold {last.targetFps} fps, so the video is timed at {last.stampedFps?.toFixed(2)} fps and plays at true speed.</div>}
      </div>
      <div className="saved-actions">
        <Button variant="secondary" size="sm" onClick={() => setView('library')}>Open Library</Button>
        <button className="icon-btn" aria-label="Dismiss" onClick={() => setHidden(last.at)}><X size={15} /></button>
      </div>
    </div>
  )
}

export function SetupPanel() {
  const running = useStore((s) => !!s.snapshot?.capture.running)
  const pool = useStore((s) => s.snapshot?.auto.pool)
  const optimistic = useStore((s) => s.optimistic)
  const selected = useStore((s) => s.selectedActor)
  const form = useApp((s) => s.form)
  const setForm = useApp((s) => s.setForm)
  const settings = useApp((s) => s.settings)
  const setView = useApp((s) => s.setView)
  const setOptimistic = useStore((s) => s.setOptimistic)
  const { live } = useLive()

  const targeted = form.mode === 'targeted'
  const poolOn = Object.keys(pool ?? {}).filter((id) => !HIDDEN_ANOMALY_IDS.has(id)).some((id) => {
    const o = optimistic[`auto.pool.${id}`]
    return o !== undefined ? !!o.value : !!pool?.[id]
  })
  const frames = Number(form.frames)
  const custom = form.customLength
  const customMissing = custom && !(frames > 0)

  let blocker = ''
  if (!live) blocker = 'Waiting for the game'
  else if (targeted && !selected) blocker = 'Pick an object first'
  else if (targeted && !form.anomalyId) blocker = 'Pick an anomaly first'
  else if (!targeted && !poolOn) blocker = 'Turn on at least one anomaly'
  else if (customMissing) blocker = 'Enter a frame count'

  const start = () => {
    const opts: Record<string, unknown> = { format: form.format }
    if (form.outputHeight) opts.outputHeight = Number(form.outputHeight)
    if (settings?.capturesRoot) opts.dir = settings.capturesRoot
    if (form.seed) opts.seed = Number(form.seed)
    if (frames > 0) opts.maxFrames = Math.floor(frames)
    if (targeted && selected && form.anomalyId) {
      opts.anomaly = form.anomalyId
      opts.target = selected
    }
    if (client.captureStart(opts)) setOptimistic('capture.running', true)
  }

  if (running) {
    return (
      <aside className="setup">
        <Recording />
      </aside>
    )
  }

  return (
    <aside className="setup">
      <div className="setup-scroll">
        <Saved />
        <Section title="What to capture">
          <Segmented
            ariaLabel="Capture mode"
            value={form.mode}
            onChange={(v) => setForm({ mode: v })}
            options={[
              { value: 'auto', label: <><Shuffle size={15} /> Random mix</>, hint: 'Fires a random mix of the anomalies you switch on' },
              { value: 'targeted', label: <><Crosshair size={15} /> One object</>, hint: 'One anomaly on one object you pick' },
            ]}
          />
          {targeted ? <OneObject /> : <RandomMix />}
        </Section>
        <Section title="Length" aside={<span className="muted">{customMissing ? 'Enter a frame count' : frames > 0 ? `${frames} frames at 30 fps` : 'Runs until you press Stop'}</span>}>
          <Segmented
            ariaLabel="Capture length"
            value={custom ? 'custom' : form.frames}
            onChange={(v) => setForm(v === 'custom' ? { customLength: true, frames: String(frames > 0 ? frames : 600) } : { customLength: false, frames: v })}
            options={[...LENGTHS, { value: 'custom', label: 'Custom' }]}
          />
          {custom && (
            <div className="inline-field">
              <input className="input" inputMode="numeric" value={form.frames} onChange={(e) => setForm({ frames: e.target.value.replace(/[^0-9]/g, '') })} />
              <span className="muted">frames</span>
            </div>
          )}
        </Section>
        <Section title="Saves to">
          <button className="path-row" onClick={() => setView('settings')} title="Change in Settings">
            <FolderOpen size={16} />
            <span className="path-text">{settings?.capturesRoot || 'Default folder'}</span>
            <span className="path-change">Change</span>
          </button>
        </Section>
        <Advanced />
      </div>
      <div className="setup-foot">
        <Button variant="primary" size="lg" icon={<Play size={16} fill="currentColor" />} disabled={!!blocker} onClick={start}>
          Start capture
        </Button>
        <div className="setup-foot-note">{blocker || 'Tip: after pressing Start, click into the game window.'}</div>
      </div>
    </aside>
  )
}
