import type { SheetMeta, SheetRecord } from './types'

const DB_NAME = 'sprite-cutter-db'
const DB_VERSION = 1
const SHEETS_STORE = 'sheets'
const BLOBS_STORE = 'sheetBlobs'
const UI_STORE = 'ui'
const ACTIVE_SHEET_KEY = 'activeSheetId'

type SheetBlobRecord = {
  id: string
  originalBlob: Blob
  processedBlob: Blob | null
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SHEETS_STORE)) {
        db.createObjectStore(SHEETS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(UI_STORE)) {
        db.createObjectStore(UI_STORE)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export async function listSheets(): Promise<SheetRecord[]> {
  const db = await openDb()
  try {
    const tx = db.transaction([SHEETS_STORE, BLOBS_STORE], 'readonly')
    const sheetsStore = tx.objectStore(SHEETS_STORE)
    const blobsStore = tx.objectStore(BLOBS_STORE)

    const [metas, blobs] = await Promise.all([
      requestToPromise(sheetsStore.getAll() as IDBRequest<SheetMeta[]>),
      requestToPromise(blobsStore.getAll() as IDBRequest<SheetBlobRecord[]>),
    ])

    await transactionComplete(tx)

    const blobById = new Map(blobs.map((entry) => [entry.id, entry]))

    return metas
      .map((meta) => {
        const blobEntry = blobById.get(meta.id)
        if (!blobEntry) {
          return null
        }
        return {
          ...meta,
          originalBlob: blobEntry.originalBlob,
          processedBlob: blobEntry.processedBlob,
        }
      })
      .filter((entry): entry is SheetRecord => entry !== null)
      .sort((left, right) => left.createdAt - right.createdAt)
  } finally {
    db.close()
  }
}

export async function putSheetMeta(meta: SheetMeta): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(SHEETS_STORE, 'readwrite')
    tx.objectStore(SHEETS_STORE).put(meta)
    await transactionComplete(tx)
  } finally {
    db.close()
  }
}

export async function putSheetBlobs(
  id: string,
  originalBlob: Blob,
  processedBlob: Blob | null,
): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(BLOBS_STORE, 'readwrite')
    tx.objectStore(BLOBS_STORE).put({ id, originalBlob, processedBlob } satisfies SheetBlobRecord)
    await transactionComplete(tx)
  } finally {
    db.close()
  }
}

export async function deleteSheet(id: string): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction([SHEETS_STORE, BLOBS_STORE], 'readwrite')
    tx.objectStore(SHEETS_STORE).delete(id)
    tx.objectStore(BLOBS_STORE).delete(id)
    await transactionComplete(tx)
  } finally {
    db.close()
  }
}

export async function getActiveSheetId(): Promise<string | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(UI_STORE, 'readonly')
    const value = await requestToPromise(tx.objectStore(UI_STORE).get(ACTIVE_SHEET_KEY))
    await transactionComplete(tx)
    return typeof value === 'string' ? value : null
  } finally {
    db.close()
  }
}

export async function setActiveSheetId(activeSheetId: string | null): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(UI_STORE, 'readwrite')
    if (activeSheetId) {
      tx.objectStore(UI_STORE).put(activeSheetId, ACTIVE_SHEET_KEY)
    } else {
      tx.objectStore(UI_STORE).delete(ACTIVE_SHEET_KEY)
    }
    await transactionComplete(tx)
  } finally {
    db.close()
  }
}
