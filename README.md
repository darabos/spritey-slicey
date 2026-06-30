# Sprite Cutter (Frontend-Only)

Sprite sheet cutter running fully in the browser.

## What It Does

- Upload one or more sprite sheet images directly in the UI.
- Removes white background immediately after upload in a dedicated Web Worker.
- Resizes each sheet to a fixed height to make it easy to work with sheets of different resolutions.
- Stores sheets and grid setup data in IndexedDB (browser persistence, no backend).
- Lets you define rows/columns, drag cut lines, and name cells.
- Exports all named cells as one ZIP file.

## Output ZIP Structure

- One directory per character.
- Character name is the first word of the sheet filename, lowercased.
- Files are PNGs named as: `<character> <cellName>.png`.
- If a filename collision occurs, a numeric suffix is added.

## Persistence

- Data is saved in IndexedDB stores for sheet metadata, blobs, and active sheet selection.
- Refreshing/reopening the app restores uploaded sheets and grid edits.

## Development

```bash
npm install
npm run dev
```

## Validation

```bash
npm run lint
npm run build
```
