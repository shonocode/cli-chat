import type { KeyboardEvent } from 'react'
import type { TerminalLine } from './state/session'

type TerminalProps = {
  prompt: string
  lines: ReadonlyArray<TerminalLine>
  isProcessing: boolean
  onSubmit(value: string): void
}

const Terminal = ({ prompt, lines, isProcessing, onSubmit }: TerminalProps) => {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const value = e.currentTarget.value
    e.currentTarget.value = ''
    onSubmit(value)
  }

  return (
    <div className="terminal">
      <div className="message">
        {lines.map((line, index) => (
          <div key={index}>
            {line.sender ? `${line.sender}> ` : ''}
            {line.text}
          </div>
        ))}
      </div>
      <div className="command">
        <span>{prompt}{'> '}</span>
        <input
          className="command-input"
          type="text"
          onKeyDown={handleKeyDown}
          disabled={isProcessing}
          autoFocus
        />
      </div>
    </div>
  )
}

export default Terminal
