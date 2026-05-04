import { describe, it, expect } from 'vitest'
import {
  buildProgressBar,
  formatBytes,
  isFileFrameString,
  parseFileFrame,
} from './fileTransfer'

describe('isFileFrameString', () => {
  it('detects file frames by their JSON prefix', () => {
    expect(isFileFrameString('{"_t":"f","op":"init","id":"x"}')).toBe(true)
  })

  it('does not match chat messages, even ones starting with {', () => {
    expect(isFileFrameString('hello world')).toBe(false)
    expect(isFileFrameString('{"text":"hi"}')).toBe(false)
    // Base64 ciphertext never starts with '{'
    expect(isFileFrameString('AgABCDEF...')).toBe(false)
  })
})

describe('parseFileFrame', () => {
  it('returns null on invalid JSON', () => {
    expect(parseFileFrame('not json')).toBeNull()
  })

  it('returns null when _t or op is missing', () => {
    expect(parseFileFrame('{"foo":"bar"}')).toBeNull()
    expect(parseFileFrame('{"_t":"f"}')).toBeNull()
  })

  it('parses a well-formed init frame', () => {
    const frame = parseFileFrame(
      '{"_t":"f","op":"init","id":"abc","name":"x.txt","size":10,"mime":"text/plain","chunks":1}',
    )
    expect(frame).toEqual({
      _t: 'f',
      op: 'init',
      id: 'abc',
      name: 'x.txt',
      size: 10,
      mime: 'text/plain',
      chunks: 1,
    })
  })
})

describe('formatBytes', () => {
  it('formats bytes / KB / MB / GB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB')
  })
})

describe('buildProgressBar', () => {
  it('renders 0%, 50%, 100% bars with the right fill', () => {
    expect(buildProgressBar(0, 100, 10)).toBe('[----------] 0%')
    expect(buildProgressBar(50, 100, 10)).toBe('[#####-----] 50%')
    expect(buildProgressBar(100, 100, 10)).toBe('[##########] 100%')
  })

  it('handles total=0 by treating progress as complete', () => {
    expect(buildProgressBar(0, 0, 4)).toBe('[####] 100%')
  })
})
