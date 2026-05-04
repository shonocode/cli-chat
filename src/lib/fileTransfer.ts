// Wire protocol for file transfer over the existing DataConnection:
//  - Control frames: JSON strings starting with `{"_t":"f"` (so we can
//    detect them cheaply without parsing every chat message as JSON).
//  - Chunk frames: binary (ArrayBuffer / Uint8Array) sent in order between
//    the `init` and `done` control frames.
// Chat messages remain plain strings — they cannot collide with the JSON
// prefix because chat is sent as raw text or base64 ciphertext.

export const CHUNK_SIZE = 16 * 1024
export const BACKPRESSURE_THRESHOLD = 512 * 1024
export const FILE_FRAME_PREFIX = '{"_t":"f"'

export type FileFrame =
  | {
      _t: 'f'
      op: 'init'
      id: string
      name: string
      size: number
      mime: string
      chunks: number
    }
  | { _t: 'f'; op: 'accept'; id: string }
  | { _t: 'f'; op: 'reject'; id: string; reason?: string }
  | { _t: 'f'; op: 'done'; id: string }
  | { _t: 'f'; op: 'abort'; id: string; reason?: string }

export const isFileFrameString = (value: string): boolean =>
  value.startsWith(FILE_FRAME_PREFIX)

export const parseFileFrame = (value: string): FileFrame | null => {
  try {
    const parsed = JSON.parse(value) as { _t?: string; op?: string }
    if (parsed?._t !== 'f' || typeof parsed.op !== 'string') return null
    return parsed as FileFrame
  } catch {
    return null
  }
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export const buildProgressBar = (
  bytes: number,
  total: number,
  width = 20,
): string => {
  const ratio = total === 0 ? 1 : Math.min(1, bytes / total)
  const filled = Math.round(ratio * width)
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${Math.round(
    ratio * 100,
  )}%`
}

export const isIosPwa = (): boolean => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined')
    return false
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return false
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
  const legacy = (navigator as { standalone?: boolean }).standalone === true
  return Boolean(standalone || legacy)
}

// On iOS PWA, blob-URL downloads are unreliable; navigator.share opens the
// native share sheet (Files / AirDrop / Photos). Web Share API requires an
// active user gesture, which is why we expose this only via /save.
export const deliverBlob = async (blob: Blob, name: string): Promise<void> => {
  const file = new File([blob], name, {
    type: blob.type || 'application/octet-stream',
  })
  if (
    isIosPwa() &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  ) {
    await navigator.share({ files: [file], title: name })
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const pickFile = (): Promise<File | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.style.display = 'none'
    let resolved = false
    const finish = (value: File | null) => {
      if (resolved) return
      resolved = true
      if (input.parentNode) input.parentNode.removeChild(input)
      resolve(value)
    }
    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null)
    })
    input.addEventListener('cancel', () => finish(null))
    document.body.appendChild(input)
    input.click()
  })

export const toArrayBuffer = (
  data: ArrayBuffer | ArrayBufferView,
): ArrayBuffer => {
  if (data instanceof ArrayBuffer) return data
  // SharedArrayBuffer is not a possible source here (DataChannel never
  // delivers SAB-backed views), so the assertion is safe.
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer
}

export const newTransferId = (): string => {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return random
}
