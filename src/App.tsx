import PWABadge from './PWABadge'
import Terminal from './Terminal'
import { useChatSession } from './hooks/useChatSession'
import { useWakeLock } from './hooks/useWakeLock'
import './App.css'

const App = () => {
  const { state, isProcessing, handleSubmit } = useChatSession()
  useWakeLock(state.status === 'connected' || state.status === 'connecting')

  return (
    <>
      <div className="crt">
        <Terminal
          prompt={state.peerId}
          lines={state.messages}
          isProcessing={isProcessing}
          onSubmit={handleSubmit}
        />
      </div>
      <PWABadge />
    </>
  )
}

export default App
