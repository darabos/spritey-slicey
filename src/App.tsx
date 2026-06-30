import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import './App.css'
import {
  deleteSheet,
  getActiveSheetId,
  listSheets,
  putSheetBlobs,
  putSheetMeta,
  setActiveSheetId,
} from './lib/indexedDb'
import { preprocessImage } from './lib/imageProcessingClient'
import type { GridConfig, SheetMeta, SheetRecord } from './lib/types'
import {
  createDefaultGridConfig,
  createUniformStops,
  MIN_GAP,
} from './lib/types'
import { exportSheetsAsZip } from './lib/zipExport'

const DEFAULT_WHITE_BG_THRESHOLD = 70
const MIN_WHITE_BG_THRESHOLD = 0
const MAX_WHITE_BG_THRESHOLD = 255
const THRESHOLD_STORAGE_KEY = 'sprite-cutter-thresholds-v1'
const EXPORT_SCALE_ENABLED_STORAGE_KEY = 'sprite-cutter-export-scale-enabled-v1'
const EXPORT_HEIGHT_STORAGE_KEY = 'sprite-cutter-export-height-v1'
const DEFAULT_EXPORT_SCALE_ENABLED = true
const DEFAULT_EXPORT_HEIGHT = 1600
const MIN_EXPORT_HEIGHT = 1
const MAX_EXPORT_HEIGHT = 10000

type Axis = 'horizontal' | 'vertical'

type DragState = {
  axis: Axis
  index: number
}

type SelectedCell = {
  row: number
  column: number
}

type CellNamesClipboard = {
  sourceRows: number
  sourceColumns: number
  cellNames: Record<string, string>
}

type WorkerStage = 'decode' | 'floodfill' | 'dilate' | 'alpha'

type UploadSummary = {
  succeeded: number
  failed: number
}

type ThresholdMap = Record<string, number>

function sanitizeThreshold(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WHITE_BG_THRESHOLD
  }

  return Math.max(
    MIN_WHITE_BG_THRESHOLD,
    Math.min(MAX_WHITE_BG_THRESHOLD, Math.round(parsed)),
  )
}

function loadThresholdMap(): ThresholdMap {
  try {
    const serialized = localStorage.getItem(THRESHOLD_STORAGE_KEY)
    if (!serialized) {
      return {}
    }
    const parsed = JSON.parse(serialized) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const next: ThresholdMap = {}
    for (const [sheetId, threshold] of Object.entries(parsed)) {
      next[sheetId] = sanitizeThreshold(threshold)
    }
    return next
  } catch {
    return {}
  }
}

function sanitizeExportHeight(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_EXPORT_HEIGHT
  }

  return Math.max(MIN_EXPORT_HEIGHT, Math.min(MAX_EXPORT_HEIGHT, Math.round(parsed)))
}

function loadExportScaleEnabled(): boolean {
  try {
    const serialized = localStorage.getItem(EXPORT_SCALE_ENABLED_STORAGE_KEY)
    if (serialized === null) {
      return DEFAULT_EXPORT_SCALE_ENABLED
    }

    return serialized === 'true'
  } catch {
    return DEFAULT_EXPORT_SCALE_ENABLED
  }
}

function loadExportHeight(): number {
  try {
    const serialized = localStorage.getItem(EXPORT_HEIGHT_STORAGE_KEY)
    if (!serialized) {
      return DEFAULT_EXPORT_HEIGHT
    }

    return sanitizeExportHeight(serialized)
  } catch {
    return DEFAULT_EXPORT_HEIGHT
  }
}

function toSheetMeta(sheet: SheetRecord): SheetMeta {
  return {
    id: sheet.id,
    filename: sheet.filename,
    displayName: sheet.displayName,
    createdAt: sheet.createdAt,
    updatedAt: sheet.updatedAt,
    status: sheet.status,
    errorMessage: sheet.errorMessage,
    grid: sheet.grid,
  }
}

function parseCellKey(key: string): SelectedCell | null {
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

function toCellKey(row: number, column: number): string {
  return `${row}:${column}`
}

function clampLineValue(value: number, values: number[], index: number): number {
  const minBoundary = index === 0 ? MIN_GAP : values[index - 1] + MIN_GAP
  const maxBoundary =
    index === values.length - 1 ? 1 - MIN_GAP : values[index + 1] - MIN_GAP

  const bounded = Math.max(minBoundary, Math.min(maxBoundary, value))
  return Number.isFinite(bounded) ? bounded : values[index]
}

function normalizeStops(rawValues: unknown, cellCount: number): number[] {
  const expected = Math.max(0, cellCount - 1)
  if (expected === 0) {
    return []
  }

  if (!Array.isArray(rawValues)) {
    return createUniformStops(cellCount)
  }

  const parsed = rawValues
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))

  if (parsed.length !== expected) {
    return createUniformStops(cellCount)
  }

  parsed.sort((left, right) => left - right)

  const adjusted: number[] = []
  for (let index = 0; index < parsed.length; index += 1) {
    const minBoundary = index === 0 ? MIN_GAP : adjusted[index - 1] + MIN_GAP
    const maxBoundary = 1 - MIN_GAP * (parsed.length - index)
    adjusted.push(Math.max(minBoundary, Math.min(parsed[index], maxBoundary)))
  }

  return adjusted
}

function sanitizeGrid(rawGrid: Partial<GridConfig>, fallback: GridConfig): GridConfig {
  const columns = Math.max(1, Math.min(30, Number(rawGrid.columns) || fallback.columns))
  const rows = Math.max(1, Math.min(30, Number(rawGrid.rows) || fallback.rows))

  const width = Number(rawGrid.dimensions?.width)
  const height = Number(rawGrid.dimensions?.height)
  const nextCellNames: Record<string, string> = {}

  if (rawGrid.cellNames && typeof rawGrid.cellNames === 'object') {
    for (const [key, value] of Object.entries(rawGrid.cellNames)) {
      const parsed = parseCellKey(key)
      if (!parsed) {
        continue
      }
      if (parsed.row >= rows || parsed.column >= columns) {
        continue
      }
      if (typeof value !== 'string') {
        continue
      }
      const trimmed = value.trim()
      if (!trimmed) {
        continue
      }
      nextCellNames[key] = trimmed
    }
  }

  return {
    columns,
    rows,
    horizontalLines: normalizeStops(rawGrid.horizontalLines, rows),
    verticalLines: normalizeStops(rawGrid.verticalLines, columns),
    cellNames: nextCellNames,
    dimensions:
      Number.isFinite(width) && Number.isFinite(height)
        ? { width, height }
        : fallback.dimensions,
  }
}

function buildDisplayName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function getCellBounds(config: GridConfig): Array<{
  row: number
  column: number
  left: number
  top: number
  width: number
  height: number
  key: string
}> {
  const verticalStops = [0, ...config.verticalLines, 1]
  const horizontalStops = [0, ...config.horizontalLines, 1]
  const cells: Array<{
    row: number
    column: number
    left: number
    top: number
    width: number
    height: number
    key: string
  }> = []

  for (let row = 0; row < horizontalStops.length - 1; row += 1) {
    for (let column = 0; column < verticalStops.length - 1; column += 1) {
      const left = verticalStops[column]
      const right = verticalStops[column + 1]
      const top = horizontalStops[row]
      const bottom = horizontalStops[row + 1]
      cells.push({
        row,
        column,
        left,
        top,
        width: right - left,
        height: bottom - top,
        key: toCellKey(row, column),
      })
    }
  }

  return cells
}

function statusLabel(status: SheetRecord['status']): string {
  if (status === 'processing') {
    return 'Processing'
  }
  if (status === 'error') {
    return 'Error'
  }
  return 'Ready'
}

function stageLabel(stage: WorkerStage): string {
  switch (stage) {
    case 'decode':
      return 'Decoding image'
    case 'floodfill':
      return 'Flood filling background'
    case 'dilate':
      return 'Expanding mask'
    case 'alpha':
      return 'Applying alpha cleanup'
    default:
      return 'Processing'
  }
}

function App() {
  const [sheets, setSheets] = useState<SheetRecord[]>([])
  const [activeSheetId, setActiveSheetIdState] = useState<string | null>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null)
  const [infoMessage, setInfoMessage] = useState('')
  const [nameClipboard, setNameClipboard] = useState<CellNamesClipboard | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isExportScalingEnabled, setIsExportScalingEnabled] = useState(() =>
    loadExportScaleEnabled(),
  )
  const [exportHeight, setExportHeight] = useState(() =>
    loadExportHeight(),
  )
  const [thresholdBySheetId, setThresholdBySheetId] = useState<ThresholdMap>(() =>
    loadThresholdMap(),
  )
  const [workerStageBySheetId, setWorkerStageBySheetId] = useState<Record<string, WorkerStage>>(
    {},
  )

  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const cellNameInputRef = useRef<HTMLInputElement | null>(null)
  const dirtySheetIdsRef = useRef<Set<string>>(new Set())
  const processingVersionBySheetIdRef = useRef<Record<string, number>>({})
  const thresholdDebounceTimerBySheetIdRef = useRef<Record<string, number>>({})

  const activeSheet = useMemo(
    () => sheets.find((sheet) => sheet.id === activeSheetId) ?? null,
    [activeSheetId, sheets],
  )

  const activeConfig = activeSheet?.grid ?? createDefaultGridConfig()
  const activeThreshold = activeSheet
    ? thresholdBySheetId[activeSheet.id] ?? DEFAULT_WHITE_BG_THRESHOLD
    : DEFAULT_WHITE_BG_THRESHOLD

  const activeBlob = activeSheet
    ? activeSheet.processedBlob ?? activeSheet.originalBlob
    : null

  const activeImageUrl = useMemo(() => {
    if (!activeBlob) {
      return null
    }
    return URL.createObjectURL(activeBlob)
  }, [activeBlob])

  useEffect(() => {
    return () => {
      if (activeImageUrl) {
        URL.revokeObjectURL(activeImageUrl)
      }
    }
  }, [activeImageUrl])

  const effectiveSelectedCell =
    selectedCell &&
    selectedCell.row < activeConfig.rows &&
    selectedCell.column < activeConfig.columns
      ? selectedCell
      : null

  const cellBounds = useMemo(() => getCellBounds(activeConfig), [activeConfig])
  const selectedCellKey = effectiveSelectedCell
    ? toCellKey(effectiveSelectedCell.row, effectiveSelectedCell.column)
    : null
  const selectedCellName = selectedCellKey
    ? activeConfig.cellNames[selectedCellKey] ?? ''
    : ''

  useEffect(() => {
    let mounted = true

    const hydrate = async () => {
      try {
        const [storedSheets, storedActiveSheetId] = await Promise.all([
          listSheets(),
          getActiveSheetId(),
        ])

        if (!mounted) {
          return
        }

        setSheets(storedSheets)

        if (
          storedActiveSheetId &&
          storedSheets.some((sheet) => sheet.id === storedActiveSheetId)
        ) {
          setActiveSheetIdState(storedActiveSheetId)
        } else {
          setActiveSheetIdState(storedSheets[0]?.id ?? null)
        }
      } catch {
        if (mounted) {
          setInfoMessage('Could not load browser storage. You can still upload new files.')
        }
      } finally {
        if (mounted) {
          setIsHydrated(true)
        }
      }
    }

    void hydrate()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!isHydrated) {
      return
    }
    void setActiveSheetId(activeSheetId)
  }, [activeSheetId, isHydrated])

  useEffect(() => {
    if (!isHydrated) {
      return
    }
    if (dirtySheetIdsRef.current.size === 0) {
      return
    }

    const sheetById = new Map(sheets.map((sheet) => [sheet.id, sheet]))
    const dirtyIds = [...dirtySheetIdsRef.current]
    dirtySheetIdsRef.current.clear()

    void Promise.all(
      dirtyIds.map((id) => {
        const sheet = sheetById.get(id)
        if (!sheet) {
          return Promise.resolve()
        }
        return putSheetMeta(toSheetMeta(sheet))
      }),
    ).catch(() => {
      setInfoMessage('Some changes were not persisted to browser storage.')
    })
  }, [sheets, isHydrated])

  useEffect(() => {
    try {
      localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(thresholdBySheetId))
    } catch {
      // Ignore localStorage write failures; processing still works in memory.
    }
  }, [thresholdBySheetId])

  useEffect(() => {
    try {
      localStorage.setItem(
        EXPORT_SCALE_ENABLED_STORAGE_KEY,
        String(isExportScalingEnabled),
      )
    } catch {
      // Ignore localStorage write failures; export still works in memory.
    }
  }, [isExportScalingEnabled])

  useEffect(() => {
    try {
      localStorage.setItem(EXPORT_HEIGHT_STORAGE_KEY, String(exportHeight))
    } catch {
      // Ignore localStorage write failures; export still works in memory.
    }
  }, [exportHeight])

  useEffect(() => {
    const timersBySheetId = thresholdDebounceTimerBySheetIdRef.current
    return () => {
      for (const timerId of Object.values(timersBySheetId)) {
        window.clearTimeout(timerId)
      }
    }
  }, [])

  useEffect(() => {
    if (!dragState || !activeSheetId) {
      return
    }

    const onPointerMove = (event: PointerEvent) => {
      const canvas = document.querySelector<HTMLElement>('[data-grid-canvas="true"]')
      if (!canvas) {
        return
      }

      const bounds = canvas.getBoundingClientRect()
      const progress =
        dragState.axis === 'vertical'
          ? (event.clientX - bounds.left) / bounds.width
          : (event.clientY - bounds.top) / bounds.height

      setSheets((previous) =>
        previous.map((sheet) => {
          if (sheet.id !== activeSheetId) {
            return sheet
          }

          const key =
            dragState.axis === 'vertical' ? 'verticalLines' : 'horizontalLines'
          const nextLines = [...sheet.grid[key]]
          nextLines[dragState.index] = clampLineValue(
            progress,
            nextLines,
            dragState.index,
          )

          const nextSheet: SheetRecord = {
            ...sheet,
            updatedAt: Date.now(),
            grid: {
              ...sheet.grid,
              [key]: nextLines,
            },
          }

          dirtySheetIdsRef.current.add(nextSheet.id)
          return nextSheet
        }),
      )
    }

    const onPointerUp = () => {
      setDragState(null)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [activeSheetId, dragState])

  useLayoutEffect(() => {
    if (!effectiveSelectedCell) {
      return
    }

    const rafId = window.requestAnimationFrame(() => {
      cellNameInputRef.current?.focus({ preventScroll: true })
      cellNameInputRef.current?.select()
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [effectiveSelectedCell])

  const updateActiveSheet = useCallback(
    (updater: (current: SheetRecord) => SheetRecord) => {
      if (!activeSheetId) {
        return
      }

      setSheets((previous) =>
        previous.map((sheet) => {
          if (sheet.id !== activeSheetId) {
            return sheet
          }
          const nextSheet = updater(sheet)
          dirtySheetIdsRef.current.add(nextSheet.id)
          return nextSheet
        }),
      )
    },
    [activeSheetId],
  )

  const handleRowsChange = useCallback(
    (rows: number) => {
      updateActiveSheet((sheet) => ({
        ...sheet,
        updatedAt: Date.now(),
        grid: sanitizeGrid(
          {
            ...sheet.grid,
            rows,
            horizontalLines: createUniformStops(rows),
          },
          sheet.grid,
        ),
      }))
    },
    [updateActiveSheet],
  )

  const handleColumnsChange = useCallback(
    (columns: number) => {
      updateActiveSheet((sheet) => ({
        ...sheet,
        updatedAt: Date.now(),
        grid: sanitizeGrid(
          {
            ...sheet.grid,
            columns,
            verticalLines: createUniformStops(columns),
          },
          sheet.grid,
        ),
      }))
    },
    [updateActiveSheet],
  )

  const processSheetWithThreshold = useCallback(
    async (sheetId: string, originalBlob: Blob, threshold: number): Promise<boolean> => {
      const normalizedThreshold = sanitizeThreshold(threshold)
      const nextVersion =
        (processingVersionBySheetIdRef.current[sheetId] ?? 0) + 1
      processingVersionBySheetIdRef.current[sheetId] = nextVersion

      setSheets((previous) =>
        previous.map((sheet) => {
          if (sheet.id !== sheetId) {
            return sheet
          }

          dirtySheetIdsRef.current.add(sheet.id)
          const nextSheet: SheetRecord = {
            ...sheet,
            updatedAt: Date.now(),
            status: 'processing',
            errorMessage: null,
          }
          return nextSheet
        }),
      )

      try {
        const processed = await preprocessImage(originalBlob, normalizedThreshold, (stage) => {
          if (processingVersionBySheetIdRef.current[sheetId] !== nextVersion) {
            return
          }

          setWorkerStageBySheetId((previous) => ({
            ...previous,
            [sheetId]: stage,
          }))
        })

        if (processingVersionBySheetIdRef.current[sheetId] !== nextVersion) {
          return false
        }

        setSheets((previous) =>
          previous.map((sheet) => {
            if (sheet.id !== sheetId) {
              return sheet
            }

            dirtySheetIdsRef.current.add(sheet.id)
            const nextSheet: SheetRecord = {
              ...sheet,
              updatedAt: Date.now(),
              status: 'ready',
              errorMessage: null,
              processedBlob: processed.blob,
              grid: {
                ...sheet.grid,
                dimensions: {
                  width: processed.width,
                  height: processed.height,
                },
              },
            }

            return nextSheet
          }),
        )

        await putSheetBlobs(sheetId, originalBlob, processed.blob)

        return true
      } catch (error) {
        if (processingVersionBySheetIdRef.current[sheetId] !== nextVersion) {
          return false
        }

        const message = error instanceof Error ? error.message : 'Background removal failed'
        setSheets((previous) =>
          previous.map((sheet) => {
            if (sheet.id !== sheetId) {
              return sheet
            }

            dirtySheetIdsRef.current.add(sheet.id)
            const nextSheet: SheetRecord = {
              ...sheet,
              updatedAt: Date.now(),
              status: 'error',
              errorMessage: message,
            }
            return nextSheet
          }),
        )

        return false
      } finally {
        if (processingVersionBySheetIdRef.current[sheetId] === nextVersion) {
          setWorkerStageBySheetId((previous) => {
            const next = { ...previous }
            delete next[sheetId]
            return next
          })
        }
      }
    },
    [],
  )

  const runUploadPipeline = useCallback(async (files: File[], threshold: number): Promise<UploadSummary> => {
    let succeeded = 0
    let failed = 0
    const normalizedThreshold = sanitizeThreshold(threshold)

    const tasks = files.map(async (file, index) => {
      const now = Date.now() + index
      const id = crypto.randomUUID()
      const initialSheet: SheetRecord = {
        id,
        filename: file.name,
        displayName: buildDisplayName(file.name),
        createdAt: now,
        updatedAt: now,
        status: 'processing',
        errorMessage: null,
        grid: createDefaultGridConfig(),
        originalBlob: file,
        processedBlob: null,
      }

      setSheets((previous) => [...previous, initialSheet])
      setThresholdBySheetId((previous) => ({
        ...previous,
        [id]: normalizedThreshold,
      }))
      setActiveSheetIdState((current) => current ?? id)

      await Promise.all([
        putSheetMeta(toSheetMeta(initialSheet)),
        putSheetBlobs(id, file, null),
      ])

      const success = await processSheetWithThreshold(id, file, normalizedThreshold)
      if (success) {
        succeeded += 1
      } else {
        failed += 1
      }
    })

    await Promise.all(tasks)
    return { succeeded, failed }
  }, [processSheetWithThreshold])

  const handleThresholdChange = (nextValue: number) => {
    if (!activeSheet) {
      return
    }

    const threshold = sanitizeThreshold(nextValue)
    const sheetId = activeSheet.id
    setThresholdBySheetId((previous) => ({
      ...previous,
      [sheetId]: threshold,
    }))

    const existingTimerId = thresholdDebounceTimerBySheetIdRef.current[sheetId]
    if (existingTimerId !== undefined) {
      window.clearTimeout(existingTimerId)
    }

    const timerId = window.setTimeout(() => {
      delete thresholdDebounceTimerBySheetIdRef.current[sheetId]
      void processSheetWithThreshold(sheetId, activeSheet.originalBlob, threshold)
    }, 240)

    thresholdDebounceTimerBySheetIdRef.current[sheetId] = timerId
  }

  const handleUploadFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files ? Array.from(event.target.files) : []
    event.target.value = ''

    const files = selectedFiles.filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) {
      setInfoMessage('Please select one or more image files.')
      return
    }

    const inheritedThreshold = activeSheet
      ? thresholdBySheetId[activeSheet.id] ?? DEFAULT_WHITE_BG_THRESHOLD
      : DEFAULT_WHITE_BG_THRESHOLD

    setInfoMessage(
      `Uploading ${files.length} file(s). Background cleanup uses threshold ${inheritedThreshold}.`,
    )

    try {
      const summary = await runUploadPipeline(files, inheritedThreshold)
      if (summary.failed === 0) {
        setInfoMessage(`Uploaded and processed ${summary.succeeded} file(s).`)
      } else {
        setInfoMessage(
          `Processed ${summary.succeeded} file(s), ${summary.failed} failed. Check sheet status for details.`,
        )
      }
    } catch {
      setInfoMessage('Upload pipeline failed unexpectedly.')
    }
  }

  const handleCopyCellNames = () => {
    const copiedNames = { ...activeConfig.cellNames }
    setNameClipboard({
      sourceRows: activeConfig.rows,
      sourceColumns: activeConfig.columns,
      cellNames: copiedNames,
    })
    setInfoMessage(`Copied ${Object.keys(copiedNames).length} cell name(s) from this sheet.`)
  }

  const handlePasteCellNames = () => {
    if (!nameClipboard) {
      setInfoMessage('Clipboard is empty. Copy names from another sheet first.')
      return
    }

    let keptCount = 0
    updateActiveSheet((sheet) => {
      const nextNames: Record<string, string> = {}

      for (const [key, value] of Object.entries(nameClipboard.cellNames)) {
        const parsed = parseCellKey(key)
        if (!parsed) {
          continue
        }
        if (parsed.row >= sheet.grid.rows || parsed.column >= sheet.grid.columns) {
          continue
        }

        nextNames[key] = value
        keptCount += 1
      }

      return {
        ...sheet,
        updatedAt: Date.now(),
        grid: {
          ...sheet.grid,
          cellNames: nextNames,
        },
      }
    })

    const sourceLabel = `${nameClipboard.sourceColumns}x${nameClipboard.sourceRows}`
    const targetLabel = `${activeConfig.columns}x${activeConfig.rows}`
    if (sourceLabel === targetLabel) {
      setInfoMessage(`Pasted ${keptCount} cell name(s).`)
    } else {
      setInfoMessage(
        `Pasted ${keptCount} cell name(s) with size remap (${sourceLabel} -> ${targetLabel}).`,
      )
    }
  }

  const handleDeleteActiveSheet = async () => {
    if (!activeSheet) {
      return
    }

    const shouldDelete = window.confirm(`Delete ${activeSheet.displayName}?`)
    if (!shouldDelete) {
      return
    }

    const deletedId = activeSheet.id
    const nextActiveId =
      activeSheetId === deletedId
        ? sheets.find((sheet) => sheet.id !== deletedId)?.id ?? null
        : activeSheetId

    setSheets((previous) => previous.filter((sheet) => sheet.id !== deletedId))
    setActiveSheetIdState(nextActiveId)
    setSelectedCell(null)
    setThresholdBySheetId((previous) => {
      const next = { ...previous }
      delete next[deletedId]
      return next
    })

    const existingTimerId = thresholdDebounceTimerBySheetIdRef.current[deletedId]
    if (existingTimerId !== undefined) {
      window.clearTimeout(existingTimerId)
      delete thresholdDebounceTimerBySheetIdRef.current[deletedId]
    }

    try {
      await deleteSheet(deletedId)
      setInfoMessage('Sheet deleted.')
    } catch {
      setInfoMessage('Failed to delete sheet from browser storage.')
    }
  }

  const handleExportZip = async () => {
    const processingCount = sheets.filter((sheet) => sheet.status === 'processing').length
    if (processingCount > 0) {
      setInfoMessage(`Please wait: ${processingCount} sheet(s) are still processing.`)
      return
    }

    setIsExporting(true)

    try {
      await exportSheetsAsZip(sheets, {
        scaleEnabled: isExportScalingEnabled,
        targetHeight: sanitizeExportHeight(exportHeight),
      })
      setInfoMessage('ZIP exported successfully.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ZIP export failed.'
      setInfoMessage(message)
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>Sprite Cutter</h1>
          <p>Upload sheets, define cells, and export ZIP. All data stays in your browser.</p>
        </div>

        <label className="field" htmlFor="columns-input">
          Columns
          <input
            id="columns-input"
            type="number"
            min={1}
            max={30}
            value={activeConfig.columns}
            disabled={!activeSheet}
            onChange={(event) =>
              handleColumnsChange(Math.max(1, Math.min(30, Number(event.target.value) || 1)))
            }
          />
        </label>

        <label className="field" htmlFor="rows-input">
          Rows
          <input
            id="rows-input"
            type="number"
            min={1}
            max={30}
            value={activeConfig.rows}
            disabled={!activeSheet}
            onChange={(event) =>
              handleRowsChange(Math.max(1, Math.min(30, Number(event.target.value) || 1)))
            }
          />
        </label>

        <label className="field" htmlFor="threshold-input">
          Background Threshold
          <div className="threshold-row">
            <input
              id="threshold-input"
              type="range"
              min={MIN_WHITE_BG_THRESHOLD}
              max={MAX_WHITE_BG_THRESHOLD}
              value={activeThreshold}
              disabled={!activeSheet}
              onChange={(event) => handleThresholdChange(Number(event.target.value))}
            />
            <span className="threshold-value">{activeThreshold}</span>
          </div>
        </label>

        <label className="field" htmlFor="export-height-input">
          Export Vertical Resolution
          <div className="scale-row">
            <label className="scale-toggle" htmlFor="export-scale-enabled-input">
              <input
                id="export-scale-enabled-input"
                type="checkbox"
                checked={isExportScalingEnabled}
                onChange={(event) => setIsExportScalingEnabled(event.target.checked)}
              />
              Scale
            </label>
            <input
              id="export-height-input"
              type="number"
              min={MIN_EXPORT_HEIGHT}
              max={MAX_EXPORT_HEIGHT}
              value={exportHeight}
              disabled={!isExportScalingEnabled}
              onChange={(event) =>
                setExportHeight(sanitizeExportHeight(Number(event.target.value) || exportHeight))
              }
            />
          </div>
        </label>

        {effectiveSelectedCell && activeSheet ? (
          <label className="field" htmlFor="cell-name-input">
            Cell Name ({effectiveSelectedCell.row + 1}, {effectiveSelectedCell.column + 1})
            <input
              ref={cellNameInputRef}
              id="cell-name-input"
              type="text"
              value={selectedCellName}
              placeholder="Type a name for this cell"
              onChange={(event) => {
                if (!effectiveSelectedCell) {
                  return
                }

                const nextValue = event.target.value
                const cellKey = toCellKey(
                  effectiveSelectedCell.row,
                  effectiveSelectedCell.column,
                )

                updateActiveSheet((sheet) => {
                  const nextNames = { ...sheet.grid.cellNames }
                  if (!nextValue.trim()) {
                    delete nextNames[cellKey]
                  } else {
                    nextNames[cellKey] = nextValue
                  }

                  return {
                    ...sheet,
                    updatedAt: Date.now(),
                    grid: {
                      ...sheet.grid,
                      cellNames: nextNames,
                    },
                  }
                })
              }}
            />
          </label>
        ) : (
          <p className="cell-helper">Upload and select a sheet, then click any cell to name it.</p>
        )}

        <div className="button-row">
          <button
            type="button"
            className="import-btn"
            onClick={() => uploadInputRef.current?.click()}
          >
            Upload Sheets
          </button>
          <button
            type="button"
            className="import-btn"
            onClick={handleCopyCellNames}
            disabled={!activeSheet}
          >
            Copy Names
          </button>
          <button
            type="button"
            className="import-btn"
            onClick={handlePasteCellNames}
            disabled={!activeSheet || !nameClipboard}
          >
            Paste Names
          </button>
          <button
            type="button"
            className="export-btn"
            onClick={handleExportZip}
            disabled={isExporting || sheets.length === 0}
          >
            {isExporting ? 'Exporting ZIP...' : 'Download ZIP'}
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={handleDeleteActiveSheet}
            disabled={!activeSheet}
          >
            Remove Sheet
          </button>
        </div>

        <input
          ref={uploadInputRef}
          type="file"
          accept="image/png,image/*"
          className="file-input"
          multiple
          onChange={handleUploadFiles}
        />

        {infoMessage ? <p className="import-message">{infoMessage}</p> : null}

        <ul className="image-list">
          {sheets.map((sheet) => {
            const isActive = sheet.id === activeSheetId
            const stage = workerStageBySheetId[sheet.id]
            return (
              <li key={sheet.id}>
                <button
                  type="button"
                  className={`image-tab ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedCell(null)
                    setActiveSheetIdState(sheet.id)
                  }}
                >
                  <span>{sheet.displayName}</span>
                  <span className={`status-pill ${sheet.status}`}>{statusLabel(sheet.status)}</span>
                  {stage ? <small>{stageLabel(stage)}</small> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      <main className="editor">
        {!activeSheet || !activeImageUrl ? (
          <div className="empty">No sheet selected. Upload PNG files to start.</div>
        ) : (
          <>
            <header className="editor-head">
              <h2>{activeSheet.displayName}</h2>
              <p>
                {activeConfig.columns} x {activeConfig.rows} cells |{' '}
                {activeConfig.verticalLines.length} vertical and{' '}
                {activeConfig.horizontalLines.length} horizontal cut lines
              </p>
              {activeSheet.status === 'error' && activeSheet.errorMessage ? (
                <p className="sheet-error">{activeSheet.errorMessage}</p>
              ) : null}
            </header>

            <div className="canvas-wrap" data-grid-canvas="true">
              <img
                src={activeImageUrl}
                alt={activeSheet.displayName}
                className="sheet-image"
                onLoad={(event) => {
                  const width = event.currentTarget.naturalWidth
                  const height = event.currentTarget.naturalHeight
                  if (activeSheet.grid.dimensions?.width === width && activeSheet.grid.dimensions?.height === height) {
                    return
                  }

                  updateActiveSheet((sheet) => ({
                    ...sheet,
                    updatedAt: Date.now(),
                    grid: {
                      ...sheet.grid,
                      dimensions: { width, height },
                    },
                  }))
                }}
              />

              <div className="grid-overlay">
                {cellBounds.map((cell) => (
                  <button
                    key={cell.key}
                    type="button"
                    className={`cell-hitbox ${selectedCellKey === cell.key ? 'selected' : ''} ${
                      activeConfig.cellNames[cell.key] ? 'named' : ''
                    }`}
                    style={{
                      left: `${cell.left * 100}%`,
                      top: `${cell.top * 100}%`,
                      width: `${cell.width * 100}%`,
                      height: `${cell.height * 100}%`,
                    }}
                    onPointerDown={(event) => {
                      if (dragState) {
                        return
                      }
                      event.preventDefault()
                      event.stopPropagation()
                      setSelectedCell({ row: cell.row, column: cell.column })
                    }}
                    title={`Cell ${cell.row + 1}, ${cell.column + 1}`}
                  >
                    <span className="cell-label">{activeConfig.cellNames[cell.key] ?? ''}</span>
                  </button>
                ))}

                {activeConfig.verticalLines.map((value, index) => (
                  <div
                    key={`v-${index}`}
                    className={`grid-line vertical ${
                      dragState?.axis === 'vertical' && dragState.index === index ? 'dragging' : ''
                    }`}
                    style={{ left: `${value * 100}%` }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      setDragState({ axis: 'vertical', index })
                    }}
                  />
                ))}

                {activeConfig.horizontalLines.map((value, index) => (
                  <div
                    key={`h-${index}`}
                    className={`grid-line horizontal ${
                      dragState?.axis === 'horizontal' && dragState.index === index ? 'dragging' : ''
                    }`}
                    style={{ top: `${value * 100}%` }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      setDragState({ axis: 'horizontal', index })
                    }}
                  />
                ))}
              </div>
            </div>

            <footer className="editor-foot">
              {activeConfig.dimensions ? (
                <span>
                  Source size: {activeConfig.dimensions.width} x {activeConfig.dimensions.height}
                </span>
              ) : (
                <span>Loading dimensions...</span>
              )}
              <button
                type="button"
                className="reset-btn"
                onClick={() => {
                  updateActiveSheet((sheet) => ({
                    ...sheet,
                    updatedAt: Date.now(),
                    grid: {
                      ...sheet.grid,
                      horizontalLines: createUniformStops(sheet.grid.rows),
                      verticalLines: createUniformStops(sheet.grid.columns),
                    },
                  }))
                }}
              >
                Reset Lines
              </button>
            </footer>
          </>
        )}
      </main>
    </div>
  )
}

export default App
