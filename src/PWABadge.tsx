import './PWABadge.css'

import { useRegisterSW } from 'virtual:pwa-register/react'

const PWABadge = () => {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div className="PWABadge" role="alert" aria-labelledby="toast-message">
      <div className="PWABadge-toast">
        <div className="PWABadge-message">
          <span id="toast-message">Update available.</span>
        </div>
        <div className="PWABadge-buttons">
          <button
            className="PWABadge-toast-button"
            onClick={() => updateServiceWorker(true)}
          >
            Reload
          </button>
          <button
            className="PWABadge-toast-button"
            onClick={() => setNeedRefresh(false)}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default PWABadge
