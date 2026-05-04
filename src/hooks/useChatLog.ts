import { useCallback, useMemo } from 'react'

const STORAGE_PREFIX = 'cli-chat:log:'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const formatDateKey = (date: Date): string => {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const storageKey = (dateKey: string): string => `${STORAGE_PREFIX}${dateKey}`

export type ChatLog = {
  append(sender: string, payload: string, when?: Date): void
  read(dateKey: string): string | null
  list(): string[]
  remove(dateKey: string): boolean
  clear(): void
  todayKey(): string
}

export const useChatLog = (storage: Storage = localStorage): ChatLog => {
  const append = useCallback(
    (sender: string, payload: string, when: Date = new Date()) => {
      const key = storageKey(formatDateKey(when))
      const existing = storage.getItem(key) ?? ''
      storage.setItem(key, `${existing}${sender}> ${payload}\n`)
    },
    [storage],
  )

  const read = useCallback(
    (dateKey: string) =>
      DATE_RE.test(dateKey) ? storage.getItem(storageKey(dateKey)) : null,
    [storage],
  )

  const list = useCallback(() => {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const raw = storage.key(i)
      if (raw && raw.startsWith(STORAGE_PREFIX)) {
        keys.push(raw.slice(STORAGE_PREFIX.length))
      }
    }
    return keys.sort()
  }, [storage])

  const remove = useCallback(
    (dateKey: string) => {
      if (!DATE_RE.test(dateKey)) return false
      const key = storageKey(dateKey)
      if (storage.getItem(key) === null) return false
      storage.removeItem(key)
      return true
    },
    [storage],
  )

  const clear = useCallback(() => {
    // Remove only our prefixed keys; leave other origin data alone.
    const toDelete: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const raw = storage.key(i)
      if (raw && raw.startsWith(STORAGE_PREFIX)) toDelete.push(raw)
    }
    for (const key of toDelete) storage.removeItem(key)
  }, [storage])

  const todayKey = useCallback(() => formatDateKey(new Date()), [])

  return useMemo(
    () => ({ append, read, list, remove, clear, todayKey }),
    [append, read, list, remove, clear, todayKey],
  )
}
