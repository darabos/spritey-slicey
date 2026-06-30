import JSZip from 'jszip'
import { blobToImageBitmap, cropCanvasToBlob, resizeBitmapToHeight } from './cropResize'
import type { SheetRecord } from './types'

function parseCellKey(key: string): { row: number; column: number } | null {
  const [rowPart, columnPart] = key.split(':')
  const row = Number(rowPart)
  const column = Number(columnPart)
  if (!Number.isInteger(row) || !Number.isInteger(column)) {
    return null
  }
  if (row < 0 || column < 0) {
    return null
  }
  return { row, column }
}

function safeName(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) {
    return 'unnamed'
  }
  return collapsed.replace(/[\\/:*?"<>|]/g, '_')
}

function characterFromFilename(filename: string): string {
  const basename = filename.replace(/\.[^.]+$/, '').trim()
  const firstWord = basename.split(/\s+/)[0] ?? ''
  const normalized = firstWord.toLowerCase().replace(/[^a-z0-9_-]+/g, '')
  return normalized || 'unknown'
}

function buildStops(length: number, ratios: number[]): number[] {
  return [0, ...ratios.map((stop) => Math.round(length * stop)), length]
}

export async function exportSheetsAsZip(sheets: SheetRecord[]): Promise<void> {
  const zip = new JSZip()
  const filenameCounts = new Map<string, number>()
  let exportedCount = 0

  for (const sheet of sheets) {
    const sourceBlob = sheet.processedBlob ?? sheet.originalBlob
    const image = await blobToImageBitmap(sourceBlob)

    try {
      const resized = await resizeBitmapToHeight(image, 1600)
      const width = resized.width
      const height = resized.height

      const xStops = buildStops(width, sheet.grid.verticalLines)
      const yStops = buildStops(height, sheet.grid.horizontalLines)

      const folderName = characterFromFilename(sheet.filename)
      const folder = zip.folder(folderName)
      if (!folder) {
        throw new Error('Could not create zip folder')
      }

      for (const [key, cellName] of Object.entries(sheet.grid.cellNames)) {
        const parsed = parseCellKey(key)
        if (!parsed) {
          continue
        }
        if (parsed.row >= sheet.grid.rows || parsed.column >= sheet.grid.columns) {
          continue
        }

        const left = xStops[parsed.column]
        const right = xStops[parsed.column + 1]
        const top = yStops[parsed.row]
        const bottom = yStops[parsed.row + 1]
        const cellWidth = right - left
        const cellHeight = bottom - top
        if (cellWidth <= 0 || cellHeight <= 0) {
          continue
        }

        const cellBlob = await cropCanvasToBlob(resized, left, top, cellWidth, cellHeight)
        const baseFileName = `${folderName} ${safeName(cellName)}.png`

        const existingCount = filenameCounts.get(`${folderName}/${baseFileName}`) ?? 0
        filenameCounts.set(`${folderName}/${baseFileName}`, existingCount + 1)

        const fileName =
          existingCount === 0
            ? baseFileName
            : `${folderName} ${safeName(cellName)} (${existingCount + 1}).png`

        folder.file(fileName, cellBlob)
        exportedCount += 1
      }
    } finally {
      image.close()
    }
  }

  if (exportedCount === 0) {
    throw new Error('No named cells found to export.')
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'sprite-cells.zip'
  anchor.click()
  URL.revokeObjectURL(url)
}
