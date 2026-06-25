import type { ArgSpec } from '../types'

export function ArgControls({
  specs,
  values,
  onChange,
}: {
  specs: ArgSpec[]
  values: Record<string, string>
  onChange: (name: string, v: string) => void
}) {
  if (!specs.length) return <div className="dim small">no args</div>
  return (
    <div className="argcontrols">
      {specs.map((spec) => (
        <ArgControl key={spec.name} spec={spec} value={values[spec.name] ?? spec.default} onChange={(v) => onChange(spec.name, v)} />
      ))}
    </div>
  )
}

function ArgControl({ spec, value, onChange }: { spec: ArgSpec; value: string; onChange: (v: string) => void }) {
  const labelText = `${spec.name}${spec.required ? ' *' : ''}`
  const hasMin = spec.min !== undefined
  const hasMax = spec.max !== undefined
  const ranged = hasMin && hasMax && (spec.type === 'float' || spec.type === 'int')

  let control: JSX.Element
  if (spec.type === 'bool') {
    control = (
      <input type="checkbox" checked={value === 'true' || value === '1'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} />
    )
  } else if (spec.type === 'enum') {
    control = (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(spec.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  } else if (spec.type === 'string') {
    control = <input value={value} placeholder={spec.default} onChange={(e) => onChange(e.target.value)} />
  } else if (ranged) {
    const step = spec.type === 'int' ? 1 : (spec.max! - spec.min!) / 100 || 0.1
    control = (
      <span className="arg-row">
        <input type="range" min={spec.min} max={spec.max} step={step} value={value || String(spec.min)} onChange={(e) => onChange(e.target.value)} />
        <span className="argval">{value || String(spec.min)}</span>
      </span>
    )
  } else {
    control = (
      <input
        type="number"
        min={hasMin ? spec.min : undefined}
        max={hasMax ? spec.max : undefined}
        value={value}
        placeholder={spec.default || '(default)'}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  return (
    <label className="arg">
      <span className="arg-label">{labelText}</span>
      {control}
    </label>
  )
}
