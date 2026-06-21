import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pure localhost dev server. The app connects to the in-game control server at ws://127.0.0.1:8077
// (ws:// is not subject to CORS/same-origin, so no proxy is needed).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
})
