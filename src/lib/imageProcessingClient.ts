type WorkerStage = 'decode' | 'floodfill' | 'dilate' | 'alpha'

type ProcessResponse =
  | {
      type: 'progress'
      requestId: string
      stage: WorkerStage
    }
  | {
      type: 'success'
      requestId: string
      blob: Blob
      width: number
      height: number
    }
  | {
      type: 'error'
      requestId: string
      message: string
    }

type ProcessRequest = {
  type: 'remove-white-bg'
  requestId: string
  file: Blob
  threshold: number
}

type PendingRequest = {
  resolve: (value: { blob: Blob; width: number; height: number }) => void
  reject: (error: Error) => void
  onProgress?: (stage: WorkerStage) => void
}

let worker: Worker | null = null
const pendingById = new Map<string, PendingRequest>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/imageProcessingWorker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = (event: MessageEvent<ProcessResponse>) => {
      const message = event.data
      const pending = pendingById.get(message.requestId)
      if (!pending) {
        return
      }

      if (message.type === 'progress') {
        pending.onProgress?.(message.stage)
        return
      }

      pendingById.delete(message.requestId)

      if (message.type === 'success') {
        pending.resolve({ blob: message.blob, width: message.width, height: message.height })
        return
      }

      pending.reject(new Error(message.message))
    }

    worker.onerror = (event) => {
      const error = new Error(event.message || 'Image worker crashed')
      for (const entry of pendingById.values()) {
        entry.reject(error)
      }
      pendingById.clear()
    }
  }

  return worker
}

export function preprocessImage(
  file: Blob,
  threshold: number,
  onProgress?: (stage: WorkerStage) => void,
): Promise<{ blob: Blob; width: number; height: number }> {
  const requestId = crypto.randomUUID()
  const activeWorker = getWorker()

  return new Promise((resolve, reject) => {
    pendingById.set(requestId, { resolve, reject, onProgress })

    const payload: ProcessRequest = {
      type: 'remove-white-bg',
      requestId,
      file,
      threshold,
    }

    activeWorker.postMessage(payload)
  })
}
