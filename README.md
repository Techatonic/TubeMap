# Tube Map

Interactive London-style tube map built with Vue 3, Vite, D3, and `d3-tube-map`.

## Features

- Interactive rendered tube map
- Toggle lines on/off
- Toggle stations on/off
- Search lines and stations
- Zoom and pan map view
- Editable map data via JSON (`public/london-tube.json`)

## Tech Stack

- Vue 3 (`<script setup>`)
- Vite 5
- D3 7
- `d3-tube-map` 1.5.0

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Install

```bash
npm install
```

### Run dev server

```bash
npm run dev
```

If dependency optimizations look stale after dependency or patch changes:

```bash
npm run dev -- --force
```

### Build

```bash
npm run build
```

### Preview production build

```bash
npm run preview
```

## Project Structure

```text
.
├── public/
│   └── london-tube.json      # map data (stations + lines + nodes)
├── src/
│   ├── components/
│   │   └── TubeMap.vue       # main map rendering and controls
│   ├── App.vue
│   ├── main.js
│   └── style.css
├── patches/
│   └── d3-tube-map+1.5.0.patch
├── vite.config.js
└── package.json
```

## Map Data Notes

The app reads `public/london-tube.json` at runtime.

- `stations`: metadata keyed by station id
- `lines`: each line has `nodes` with `coords` and optional `name`, `marker`, `labelPos`

### Important geometry rule

`d3-tube-map` only supports specific corner transitions between nodes. Large direct jumps can throw errors like:

- `Cannot draw a corner between coordinates ...`

If this happens, add intermediate nodes and keep transitions to valid step patterns.

## Dependency Patch (Important)

This project includes a `patch-package` patch for `d3-tube-map`:

- `patches/d3-tube-map+1.5.0.patch`

Why:

- Fixes interchange placement for anti-parallel directions (e.g. opposite line directions at interchanges) that could otherwise produce `NaN` transforms.

How it is applied:

- `postinstall` script in `package.json` runs `patch-package` automatically after `npm install`.

## Troubleshooting

- If map looks wrong after changing dependencies:
  - stop dev server
  - run `npm install`
  - run `npm run dev -- --force`
  - hard refresh browser

- If line geometry throws corner errors:
  - check the node sequence in `public/london-tube.json`
  - replace long jumps with intermediate bend nodes

## License

BSD-3-Clause (see `LICENSE`).
