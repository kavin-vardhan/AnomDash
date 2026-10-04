import type { ReactNode, ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'record'

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode }) {
  return (
    <button className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`} {...rest}>
      {icon ? <span className="btn-icon">{icon}</span> : null}
      {children ? <span className="btn-label">{children}</span> : null}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: T
  options: Array<{ value: T; label: ReactNode; hint?: string }>
  onChange: (v: T) => void
  disabled?: boolean
  ariaLabel: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          disabled={disabled}
          title={o.hint}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: ReactNode
  hint?: ReactNode
}) {
  return (
    <label className={`switch-row${disabled ? ' is-disabled' : ''}`}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {hint ? <span className="switch-hint">{hint}</span> : null}
      </span>
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section${className ? ` ${className}` : ''}`}>
      <header className="section-head">
        <h3>{title}</h3>
        {aside ? <div className="section-aside">{aside}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return <span className="dot" style={{ background: color, width: size, height: size }} />
}
