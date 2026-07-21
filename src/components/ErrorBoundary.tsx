import { Component } from 'react'
import type { ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="error-screen">
        <div className="error-card">
          <h1>Dashboard crashed</h1>
          <p className="dim">{String(this.state.error)}</p>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}
