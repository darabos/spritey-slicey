export const DEFAULT_COLUMNS = 6
export const DEFAULT_ROWS = 4
export const MIN_GAP = 0.02

export type GridConfig = {
  columns: number
  rows: number
  horizontalLines: number[]
  verticalLines: number[]
  cellNames: Record<string, string>
  dimensions: {
    width: number
    height: number
  } | null
}

export type SheetProcessingStatus = 'processing' | 'ready' | 'error'

export type SheetMeta = {
  id: string
  filename: string
  displayName: string
  createdAt: number
  updatedAt: number
  status: SheetProcessingStatus
  errorMessage: string | null
  grid: GridConfig
}

export type SheetRecord = SheetMeta & {
  originalBlob: Blob
  processedBlob: Blob | null
}

export function createUniformStops(cellCount: number): number[] {
  if (cellCount <= 1) {
    return []
  }

  return Array.from({ length: cellCount - 1 }, (_, index) => (index + 1) / cellCount)
}

export function createDefaultGridConfig(): GridConfig {
  return {
    columns: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS,
    horizontalLines: createUniformStops(DEFAULT_ROWS),
    verticalLines: createUniformStops(DEFAULT_COLUMNS),
    cellNames: {},
    dimensions: null,
  }
}
