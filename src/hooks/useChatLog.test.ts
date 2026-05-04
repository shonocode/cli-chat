import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatLog } from './useChatLog'

describe('useChatLog', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('namespaces stored keys with cli-chat:log: prefix', () => {
    const { result } = renderHook(() => useChatLog())
    act(() => {
      result.current.append('alice', 'hi', new Date('2026-04-28T10:00:00'))
    })
    expect(localStorage.getItem('cli-chat:log:2026-04-28')).toBe('alice> hi\n')
    expect(localStorage.getItem('2026-04-28')).toBeNull()
  })

  it('list() returns only date keys, not unrelated localStorage entries', () => {
    localStorage.setItem('unrelated-app:foo', 'bar')
    const { result } = renderHook(() => useChatLog())
    act(() => {
      result.current.append('alice', 'a', new Date('2026-04-28T10:00:00'))
      result.current.append('bob', 'b', new Date('2026-04-27T10:00:00'))
    })
    expect(result.current.list()).toEqual(['2026-04-27', '2026-04-28'])
    expect(localStorage.getItem('unrelated-app:foo')).toBe('bar')
  })

  it('clear() leaves unrelated keys untouched', () => {
    localStorage.setItem('unrelated-app:foo', 'bar')
    const { result } = renderHook(() => useChatLog())
    act(() => {
      result.current.append('alice', 'a')
      result.current.clear()
    })
    expect(result.current.list()).toEqual([])
    expect(localStorage.getItem('unrelated-app:foo')).toBe('bar')
  })

  it('remove() rejects malformed date strings', () => {
    const { result } = renderHook(() => useChatLog())
    expect(result.current.remove('../etc/passwd')).toBe(false)
    expect(result.current.remove('2026-04-28')).toBe(false) // no entry
  })

  it('read() rejects malformed date strings', () => {
    const { result } = renderHook(() => useChatLog())
    expect(result.current.read('not-a-date')).toBeNull()
  })
})
