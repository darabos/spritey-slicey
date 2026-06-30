type ProcessRequest = {
  type: 'remove-white-bg'
  requestId: string
  file: Blob
  threshold: number
}

type ProgressResponse = {
  type: 'progress'
  requestId: string
  stage: 'decode' | 'floodfill' | 'dilate' | 'alpha'
}

type SuccessResponse = {
  type: 'success'
  requestId: string
  blob: Blob
  width: number
  height: number
}

type ErrorResponse = {
  type: 'error'
  requestId: string
  message: string
}

type WorkerResponse = ProgressResponse | SuccessResponse | ErrorResponse

function clampColor(value: number): number {
  if (value < 0) {
    return 0
  }
  if (value > 255) {
    return 255
  }
  return Math.round(value)
}

function isWithinThreshold(
  data: Uint8ClampedArray,
  offset: number,
  seedR: number,
  seedG: number,
  seedB: number,
  threshold: number,
): boolean {
  const dr = Math.abs(data[offset] - seedR)
  const dg = Math.abs(data[offset + 1] - seedG)
  const db = Math.abs(data[offset + 2] - seedB)
  return dr <= threshold && dg <= threshold && db <= threshold
}

self.onmessage = async (event: MessageEvent<ProcessRequest>) => {
  const { data } = event
  if (data.type !== 'remove-white-bg') {
    return
  }

  const post = (message: WorkerResponse) => {
    self.postMessage(message)
  }

  try {
    post({ type: 'progress', requestId: data.requestId, stage: 'decode' })
    const bitmap = await createImageBitmap(data.file)
    const width = bitmap.width
    const height = bitmap.height

    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      throw new Error('2D context unavailable in worker')
    }

    context.drawImage(bitmap, 0, 0)
    bitmap.close()

    const imageData = context.getImageData(0, 0, width, height)
    const pixels = imageData.data
    const total = width * height

    post({ type: 'progress', requestId: data.requestId, stage: 'floodfill' })

    const mask = new Uint8Array(total)
    const queue = new Uint32Array(total)
    let head = 0
    let tail = 0

    const seedR = pixels[0]
    const seedG = pixels[1]
    const seedB = pixels[2]

    mask[0] = 1
    queue[tail] = 0
    tail += 1

    while (head < tail) {
      const index = queue[head]
      head += 1

      const x = index % width
      const y = Math.floor(index / width)

      if (x > 0) {
        const left = index - 1
        if (!mask[left]) {
          const offset = left * 4
          if (isWithinThreshold(pixels, offset, seedR, seedG, seedB, data.threshold)) {
            mask[left] = 1
            queue[tail] = left
            tail += 1
          }
        }
      }

      if (x + 1 < width) {
        const right = index + 1
        if (!mask[right]) {
          const offset = right * 4
          if (isWithinThreshold(pixels, offset, seedR, seedG, seedB, data.threshold)) {
            mask[right] = 1
            queue[tail] = right
            tail += 1
          }
        }
      }

      if (y > 0) {
        const up = index - width
        if (!mask[up]) {
          const offset = up * 4
          if (isWithinThreshold(pixels, offset, seedR, seedG, seedB, data.threshold)) {
            mask[up] = 1
            queue[tail] = up
            tail += 1
          }
        }
      }

      if (y + 1 < height) {
        const down = index + width
        if (!mask[down]) {
          const offset = down * 4
          if (isWithinThreshold(pixels, offset, seedR, seedG, seedB, data.threshold)) {
            mask[down] = 1
            queue[tail] = down
            tail += 1
          }
        }
      }
    }

    post({ type: 'progress', requestId: data.requestId, stage: 'dilate' })

    const dilated = new Uint8Array(total)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x
        let touched = false

        for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
            if (mask[ny * width + nx]) {
              touched = true
              break
            }
          }
          if (touched) {
            break
          }
        }

        if (touched) {
          dilated[index] = 1
        }
      }
    }

    post({ type: 'progress', requestId: data.requestId, stage: 'alpha' })

    for (let index = 0; index < total; index += 1) {
      const offset = index * 4
      const r = pixels[offset]
      const g = pixels[offset + 1]
      const b = pixels[offset + 2]

      if (dilated[index]) {
        const alpha = 255 - Math.min(r, g, b)
        if (alpha > 0) {
          pixels[offset] = clampColor((255 * (r - 255 + alpha)) / alpha)
          pixels[offset + 1] = clampColor((255 * (g - 255 + alpha)) / alpha)
          pixels[offset + 2] = clampColor((255 * (b - 255 + alpha)) / alpha)
        }
        pixels[offset + 3] = alpha
      } else {
        pixels[offset + 3] = 255
      }
    }

    context.putImageData(imageData, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })

    post({
      type: 'success',
      requestId: data.requestId,
      blob,
      width,
      height,
    })
  } catch (error) {
    post({
      type: 'error',
      requestId: data.requestId,
      message: error instanceof Error ? error.message : 'Image processing failed',
    })
  }
}
