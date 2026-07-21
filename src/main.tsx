import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { loadRuntimeConfig } from './config'
import './styles.css'

function render() {
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  )
}

loadRuntimeConfig().then(render, render)
