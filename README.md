# Persistent Computer

A persistent Windows workspace prototype that watches the desktop, remembers context, and turns files, notes, slides, clipboard contents, downloads, notifications, and project state into computational objects.

The goal is not another dashboard. The goal is a local computer layer that can say:

> This action conflicts with what I know about your project. Here is the evidence, and here are reversible options.

## Current Capabilities

- Continuous Windows screen capture with Gemini Interactions analysis.
- Tiny native Windows companion arrow that follows the real cursor outside the browser.
- Glass workspace UI with agents for screen, system map, rigor, memory, slides, notes, gallery, files, downloads, dependency graph, clipboard, and notifications.
- Persistent memory store for facts, episodes, and cross-surface associations.
- Import-aware dependency snapshot for JS, TS, TSX, Python, notebooks, markdown, and JSON files.
- Ollama readiness checks for local private reasoning.
- Gemini cloud fallback for reasoning when local Ollama is unavailable.

## Architecture

```txt
Windows desktop
  -> PowerShell screen capture
  -> Node observer daemon
  -> Gemini Interactions / Ollama local model
  -> WebSocket events
  -> React workspace
  -> Native companion overlay
```

## Configuration

Copy `.env.example` to `backend/.env` or project-root `.env`.

```txt
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash
GEMINI_IMAGE_MODEL=gemini-3.1-flash-lite-image
GEMINI_AGENT=antigravity-preview-05-2026

OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3n:e4b

PORT=3000
POWERSHELL_EXE=powershell.exe
OBSERVER_INTERVAL_MS=3500
OBSERVER_ANALYSIS_COOLDOWN_MS=15000

VITE_BACKEND_URL=http://127.0.0.1:3000
```

Runtime memory is written to `backend/data/memory.json` and is intentionally ignored by git.

## Running

```powershell
npm install
cd backend
npm install
node server.js
```

In another shell:

```powershell
npm run dev
```

Open the workspace at the Vite URL, usually `http://127.0.0.1:5173`.

To launch the native companion, use the `Desktop cursor` button in the UI. It starts `backend/nativeCompanion.ps1`.

## Ollama

The backend is ready for Ollama, but it does not install it for you.

```powershell
ollama pull gemma3n:e4b
```

The app exposes:

- `GET /api/local-model/status`
- `POST /api/local-model/test`

If your local model has a different tag, set `OLLAMA_MODEL` in the environment.

