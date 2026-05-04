import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Self-host VT323 so it loads under the strict `font-src 'self'` CSP.
import '@fontsource/vt323/400.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
