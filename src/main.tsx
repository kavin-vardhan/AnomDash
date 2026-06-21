import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// No StrictMode: this app holds a single live WebSocket; double-invoked dev effects add needless churn.
createRoot(document.getElementById('root')!).render(<App />)
