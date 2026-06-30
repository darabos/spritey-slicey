export async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob)
}

export async function resizeBitmapToHeight(
  source: ImageBitmap,
  targetHeight: number,
): Promise<OffscreenCanvas> {
  const width = Math.round((targetHeight * source.width) / source.height)
  const canvas = new OffscreenCanvas(width, targetHeight)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not create 2D context')
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, width, targetHeight)
  return canvas
}

export async function cropCanvasToBlob(
  source: OffscreenCanvas,
  left: number,
  top: number,
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not create crop context')
  }

  context.drawImage(source, left, top, width, height, 0, 0, width, height)
  return canvas.convertToBlob({ type: 'image/png' })
}
