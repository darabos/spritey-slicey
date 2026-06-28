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

const DEFAULT_COLUMNS = 6
const DEFAULT_ROWS = 4
const MIN_GAP = 0.02
const STORAGE_KEY = 'sprite-cutter-state-v1'

type Axis = 'horizontal' | 'vertical'

type ImageEntry = {
  id: string
  filename: string
  displayName: string
  src: string
}

type ImageDimensions = {
  width: number
  height: number
}

type ImageGridConfig = {
  columns: number
  rows: number
  horizontalLines: number[]
  verticalLines: number[]
  cellNames: Record<string, string>
  dimensions: ImageDimensions | null
}

type DragState = {
  axis: Axis
  index: number
}

type PersistedState = {
  activeImageId: string | null
  configs: Record<
    string,
    {
      columns?: unknown
      rows?: unknown
      horizontalLines?: unknown
      verticalLines?: unknown
      cellNames?: unknown
      dimensions?: { width?: unknown; height?: unknown } | null
    }
  >
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

const imageModules = import.meta.glob('../images/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>

function toImageId(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function createUniformStops(cellCount: number): number[] {
  if (cellCount <= 1) {
    return []
  }

  return Array.from(
    { length: cellCount - 1 },
    (_, index) => (index + 1) / cellCount,
  )
}

function createDefaultConfig(): ImageGridConfig {
  return {
    columns: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS,
    horizontalLines: createUniformStops(DEFAULT_ROWS),
    verticalLines: createUniformStops(DEFAULT_COLUMNS),
    cellNames: {},
    dimensions: null,
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function clampLineValue(value: number, values: number[], index: number): number {
  const minBoundary = index === 0 ? MIN_GAP : values[index - 1] + MIN_GAP
  const maxBoundary =
    index === values.length - 1 ? 1 - MIN_GAP : values[index + 1] - MIN_GAP

  const bounded = Math.max(minBoundary, Math.min(maxBoundary, value))
  return Number.isFinite(bounded) ? bounded : values[index]
}

function toCellKey(row: number, column: number): string {
  return `${row}:${column}`
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

function getCellBounds(config: ImageGridConfig): Array<{
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

function App() {
  const images = useMemo<ImageEntry[]>(() => {
    return Object.entries(imageModules)
      .map(([rawPath, src]) => {
        const filename = decodeURIComponent(rawPath.split('/').pop() ?? rawPath)
        return {
          id: toImageId(filename),
          filename,
          displayName: filename.replace(/\.[^.]+$/, ''),
          src,
        }
      })
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName, 'hu-HU'),
      )
  }, [])

  const [activeImageId, setActiveImageId] = useState<string | null>(
    images[0]?.id ?? null,
  )
  const [configs, setConfigs] = useState<Record<string, ImageGridConfig>>({})
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null)
  const [importMessage, setImportMessage] = useState('')
  const [isHydrated, setIsHydrated] = useState(false)
  const [nameClipboard, setNameClipboard] = useState<CellNamesClipboard | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const cellNameInputRef = useRef<HTMLInputElement | null>(null)

  const activeImage = useMemo(
    () => images.find((image) => image.id === activeImageId) ?? null,
    [activeImageId, images],
  )

  const activeConfig = activeImageId
    ? configs[activeImageId] ?? createDefaultConfig()
    : createDefaultConfig()

  const cellBounds = useMemo(() => getCellBounds(activeConfig), [activeConfig])
  const selectedCellKey = selectedCell
    ? toCellKey(selectedCell.row, selectedCell.column)
    : null
  const selectedCellName = selectedCellKey
    ? activeConfig.cellNames[selectedCellKey] ?? ''
    : ''

  const sanitizeConfig = useCallback(
    (
      rawConfig: {
        columns?: unknown
        rows?: unknown
        horizontalLines?: unknown
        verticalLines?: unknown
        cellNames?: unknown
        dimensions?: { width?: unknown; height?: unknown } | null
      },
      fallback: ImageGridConfig,
    ): ImageGridConfig => {
      const columns = Math.max(
        1,
        Math.min(30, Number(rawConfig.columns) || fallback.columns),
      )
      const rows = Math.max(1, Math.min(30, Number(rawConfig.rows) || fallback.rows))

      const width = Number(rawConfig.dimensions?.width)
      const height = Number(rawConfig.dimensions?.height)
      const nextCellNames: Record<string, string> = {}

      if (rawConfig.cellNames && typeof rawConfig.cellNames === 'object') {
        for (const [key, value] of Object.entries(rawConfig.cellNames)) {
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
        horizontalLines: normalizeStops(rawConfig.horizontalLines, rows),
        verticalLines: normalizeStops(rawConfig.verticalLines, columns),
        cellNames: nextCellNames,
        dimensions:
          Number.isFinite(width) && Number.isFinite(height)
            ? { width, height }
            : fallback.dimensions,
      }
    },
    [],
  )

  const updateConfig = useCallback(
    (imageId: string, updater: (previous: ImageGridConfig) => ImageGridConfig) => {
      setConfigs((previous) => {
        const current = previous[imageId] ?? createDefaultConfig()
        return {
          ...previous,
          [imageId]: updater(current),
        }
      })
    },
    [],
  )

  useEffect(() => {
    try {
      const serialized = localStorage.getItem(STORAGE_KEY)
      if (!serialized) {
        setIsHydrated(true)
        return
      }

      const parsed = JSON.parse(serialized) as PersistedState
      const knownImageIds = new Set(images.map((image) => image.id))
      const rawConfigs = parsed?.configs ?? {}
      const hydratedConfigs: Record<string, ImageGridConfig> = {}

      for (const [imageId, rawConfig] of Object.entries(rawConfigs)) {
        if (!knownImageIds.has(imageId) || !rawConfig) {
          continue
        }

        hydratedConfigs[imageId] = sanitizeConfig(rawConfig, createDefaultConfig())
      }

      setConfigs(hydratedConfigs)

      const persistedActive = parsed?.activeImageId
      if (persistedActive && knownImageIds.has(persistedActive)) {
        setActiveImageId(persistedActive)
      }
    } catch {
      setImportMessage('Local state could not be restored. Starting with defaults.')
    } finally {
      setIsHydrated(true)
    }
  }, [images, sanitizeConfig])

  useEffect(() => {
    if (!isHydrated) {
      return
    }

    try {
      const payload = {
        activeImageId,
        configs,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      setImportMessage('Local save failed. Check browser storage availability.')
    }
  }, [activeImageId, configs, isHydrated])

  useEffect(() => {
    if (!dragState || !activeImageId) {
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

      updateConfig(activeImageId, (previous) => {
        const key =
          dragState.axis === 'vertical' ? 'verticalLines' : 'horizontalLines'
        const next = [...previous[key]]
        next[dragState.index] = clampLineValue(progress, next, dragState.index)

        return {
          ...previous,
          [key]: next,
        }
      })
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
  }, [activeImageId, dragState, updateConfig])

  useEffect(() => {
    setSelectedCell(null)
  }, [activeImageId])

  useEffect(() => {
    if (!selectedCell) {
      return
    }

    if (
      selectedCell.row >= activeConfig.rows ||
      selectedCell.column >= activeConfig.columns
    ) {
      setSelectedCell(null)
    }
  }, [activeConfig.columns, activeConfig.rows, selectedCell])

  useLayoutEffect(() => {
    if (!selectedCell) {
      return
    }

    const rafId = window.requestAnimationFrame(() => {
      cellNameInputRef.current?.focus({ preventScroll: true })
      cellNameInputRef.current?.select()
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [selectedCell])

  const handleRowsChange = (rows: number) => {
    if (!activeImageId) {
      return
    }

    updateConfig(activeImageId, (previous) => ({
      ...sanitizeConfig(
        {
          ...previous,
          rows,
          horizontalLines: createUniformStops(rows),
          verticalLines: previous.verticalLines,
          cellNames: previous.cellNames,
          dimensions: previous.dimensions,
        },
        previous,
      ),
    }))
  }

  const handleColumnsChange = (columns: number) => {
    if (!activeImageId) {
      return
    }

    updateConfig(activeImageId, (previous) => ({
      ...sanitizeConfig(
        {
          ...previous,
          columns,
          verticalLines: createUniformStops(columns),
          horizontalLines: previous.horizontalLines,
          cellNames: previous.cellNames,
          dimensions: previous.dimensions,
        },
        previous,
      ),
    }))
  }

  const handleImageLoad = (imageId: string, width: number, height: number) => {
    updateConfig(imageId, (previous) => ({
      ...previous,
      dimensions: { width, height },
    }))
  }

  const exportJson = () => {
    const payload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      defaults: {
        columns: DEFAULT_COLUMNS,
        rows: DEFAULT_ROWS,
      },
      images: images.map((image) => {
        const config = configs[image.id] ?? createDefaultConfig()
        return {
          id: image.id,
          filename: image.filename,
          dimensions: config.dimensions,
          grid: {
            columns: config.columns,
            rows: config.rows,
            horizontalLines: config.horizontalLines.map(round4),
            verticalLines: config.verticalLines.map(round4),
            cellNames: config.cellNames,
          },
        }
      }),
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'grid-setups.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    try {
      const jsonText = await file.text()
      const parsed = JSON.parse(jsonText) as {
        images?: Array<{
          id?: unknown
          filename?: unknown
          dimensions?: { width?: unknown; height?: unknown } | null
          grid?: {
            columns?: unknown
            rows?: unknown
            horizontalLines?: unknown
            verticalLines?: unknown
            cellNames?: unknown
          }
        }>
      }

      if (!Array.isArray(parsed.images)) {
        throw new Error('Invalid file format: missing images array')
      }

      const imagesById = new Map(images.map((image) => [image.id, image]))
      let appliedCount = 0

      setConfigs((previous) => {
        const next = { ...previous }

        for (const importedImage of parsed.images ?? []) {
          const importedId =
            typeof importedImage.id === 'string' ? importedImage.id : null
          const importedFilename =
            typeof importedImage.filename === 'string'
              ? importedImage.filename
              : null
          const fallbackId = importedFilename ? toImageId(importedFilename) : null
          const targetId = imagesById.has(importedId ?? '')
            ? importedId
            : fallbackId && imagesById.has(fallbackId)
              ? fallbackId
              : null

          if (!targetId) {
            continue
          }

          const columns = Math.max(
            1,
            Math.min(30, Number(importedImage.grid?.columns) || DEFAULT_COLUMNS),
          )
          const rows = Math.max(
            1,
            Math.min(30, Number(importedImage.grid?.rows) || DEFAULT_ROWS),
          )

          const existing = next[targetId] ?? createDefaultConfig()

          next[targetId] = sanitizeConfig(
            {
              columns,
              rows,
              horizontalLines: importedImage.grid?.horizontalLines,
              verticalLines: importedImage.grid?.verticalLines,
              cellNames: importedImage.grid?.cellNames,
              dimensions: importedImage.dimensions,
            },
            existing,
          )

          appliedCount += 1
        }

        return next
      })

      setImportMessage(
        appliedCount > 0
          ? `Imported setups for ${appliedCount} image(s).`
          : 'No matching image entries were found in this file.',
      )
    } catch {
      setImportMessage('Import failed. Please select a valid exported JSON file.')
    }
  }

  const handleCopyCellNames = () => {
    const copiedNames = { ...activeConfig.cellNames }
    setNameClipboard({
      sourceRows: activeConfig.rows,
      sourceColumns: activeConfig.columns,
      cellNames: copiedNames,
    })
    setImportMessage(
      `Copied ${Object.keys(copiedNames).length} cell name(s) from this sheet.`,
    )
  }

  const handlePasteCellNames = () => {
    if (!activeImageId) {
      return
    }

    if (!nameClipboard) {
      setImportMessage('Clipboard is empty. Copy names from another sheet first.')
      return
    }

    let keptCount = 0
    updateConfig(activeImageId, (previous) => {
      const nextNames: Record<string, string> = {}

      for (const [key, value] of Object.entries(nameClipboard.cellNames)) {
        const parsed = parseCellKey(key)
        if (!parsed) {
          continue
        }
        if (parsed.row >= previous.rows || parsed.column >= previous.columns) {
          continue
        }

        nextNames[key] = value
        keptCount += 1
      }

      return {
        ...previous,
        cellNames: nextNames,
      }
    })

    const sourceLabel = `${nameClipboard.sourceColumns}x${nameClipboard.sourceRows}`
    const targetLabel = `${activeConfig.columns}x${activeConfig.rows}`
    if (sourceLabel === targetLabel) {
      setImportMessage(`Pasted ${keptCount} cell name(s).`)
    } else {
      setImportMessage(
        `Pasted ${keptCount} cell name(s) with size remap (${sourceLabel} -> ${targetLabel}).`,
      )
    }
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>Sprite Cutter</h1>
          <p>Switch images, tune the grid, drag lines, export once.</p>
        </div>

        <label className="field" htmlFor="columns-input">
          Columns
          <input
            id="columns-input"
            type="number"
            min={1}
            max={30}
            value={activeConfig.columns}
            onChange={(event) =>
              handleColumnsChange(
                Math.max(1, Math.min(30, Number(event.target.value) || 1)),
              )
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
            onChange={(event) =>
              handleRowsChange(
                Math.max(1, Math.min(30, Number(event.target.value) || 1)),
              )
            }
          />
        </label>

        {selectedCell ? (
          <label className="field" htmlFor="cell-name-input">
            Cell Name ({selectedCell.row + 1}, {selectedCell.column + 1})
            <input
              ref={cellNameInputRef}
              id="cell-name-input"
              type="text"
              value={selectedCellName}
              placeholder="Type a name for this cell"
              onChange={(event) => {
                if (!activeImageId || !selectedCell) {
                  return
                }

                const nextValue = event.target.value
                const cellKey = toCellKey(selectedCell.row, selectedCell.column)

                updateConfig(activeImageId, (previous) => {
                  const nextNames = { ...previous.cellNames }
                  if (!nextValue.trim()) {
                    delete nextNames[cellKey]
                  } else {
                    nextNames[cellKey] = nextValue
                  }

                  return {
                    ...previous,
                    cellNames: nextNames,
                  }
                })
              }}
            />
          </label>
        ) : (
          <p className="cell-helper">Click any cell in the image to name it.</p>
        )}

        <div className="button-row">
          <button type="button" className="import-btn" onClick={handleCopyCellNames}>
            Copy Names
          </button>
          <button type="button" className="import-btn" onClick={handlePasteCellNames}>
            Paste Names
          </button>
          <button
            type="button"
            className="import-btn"
            onClick={() => importInputRef.current?.click()}
          >
            Import JSON
          </button>
          <button type="button" className="export-btn" onClick={exportJson}>
            Download JSON
          </button>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="file-input"
          onChange={handleImportFile}
        />
        {importMessage ? <p className="import-message">{importMessage}</p> : null}

        <ul className="image-list">
          {images.map((image) => {
            const isActive = image.id === activeImageId
            return (
              <li key={image.id}>
                <button
                  type="button"
                  className={`image-tab ${isActive ? 'active' : ''}`}
                  onClick={() => setActiveImageId(image.id)}
                >
                  {image.displayName}
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      <main className="editor">
        {!activeImage ? (
          <div className="empty">No PNG files found in the images folder.</div>
        ) : (
          <>
            <header className="editor-head">
              <h2>{activeImage.displayName}</h2>
              <p>
                {activeConfig.columns} x {activeConfig.rows} cells |{' '}
                {activeConfig.verticalLines.length} vertical and{' '}
                {activeConfig.horizontalLines.length} horizontal cut lines
              </p>
            </header>

            <div className="canvas-wrap" data-grid-canvas="true">
              <img
                src={activeImage.src}
                alt={activeImage.displayName}
                className="sheet-image"
                onLoad={(event) => {
                  handleImageLoad(
                    activeImage.id,
                    event.currentTarget.naturalWidth,
                    event.currentTarget.naturalHeight,
                  )
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
                    <span className="cell-label">
                      {activeConfig.cellNames[cell.key] ?? ''}
                    </span>
                  </button>
                ))}

                {activeConfig.verticalLines.map((value, index) => (
                  <div
                    key={`v-${index}`}
                    className={`grid-line vertical ${
                      dragState?.axis === 'vertical' && dragState.index === index
                        ? 'dragging'
                        : ''
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
                      dragState?.axis === 'horizontal' && dragState.index === index
                        ? 'dragging'
                        : ''
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
                  Source size: {activeConfig.dimensions.width} x{' '}
                  {activeConfig.dimensions.height}
                </span>
              ) : (
                <span>Loading dimensions...</span>
              )}
              <button
                type="button"
                className="reset-btn"
                onClick={() => {
                  if (!activeImageId) {
                    return
                  }

                  updateConfig(activeImageId, (previous) => ({
                    ...previous,
                    horizontalLines: createUniformStops(previous.rows),
                    verticalLines: createUniformStops(previous.columns),
                    cellNames: previous.cellNames,
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
