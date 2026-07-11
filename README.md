# Persistent Computer

A persistent Windows workspace runtime that continuously observes the desktop, builds context from workspace files, and intervenes when it detects meaningful visual or structural anomalies.

The goal is not another dashboard. The goal is a local computer layer that can say:

> This action conflicts with what I know about your project. Here is the evidence, and here are reversible options.

## What It Does

- Continuously captures the Windows primary screen and runs Gemini multimodal analysis every cycle
- Detects visual breakdowns, contextual conflicts, and structural issues with grounded evidence
- Pushes intervention cards into a live sidebar with screenshot-grounded Nano Banana images
- Maintains a deduplicated issue history so the same problem is never surfaced twice
- Stores persistent memory: facts, episodes, and cross-surface associations used in every Gemini interaction
- Provides a native companion arrow that follows the real cursor outside the browser window
- Exposes workspace agents for notes, gallery, files, downloads, dependency graph, clipboard, and notifications
- Supports multilingual voice output via Gemini-powered translation, with natural TTS playback
- Accepts microphone input routed through the Gemini API for conversational interaction with the desktop agent

## Architecture

```
Windows primary screen
  -> PowerShell screen capture (PrimaryScreen bounds)
  -> Node observer daemon
  -> Gemini 3.5 Flash reasoning / Nano Banana image generation
  -> WebSocket broadcast
  -> React workspace (Vite)
  -> Native PowerShell companion overlay
```

## Configuration

Copy `.env.example` to `backend/.env`.

```
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
GEMINI_IMAGE_LITE_MODEL=gemini-3.1-flash-lite-image
GEMINI_OMNI_MODEL=gemini-omni-flash-preview
GEMINI_AGENT=antigravity-preview-05-2026

OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3n:e4b

PORT=3000
POWERSHELL_EXE=powershell.exe
OBSERVER_INTERVAL_MS=3500
OBSERVER_ANALYSIS_COOLDOWN_MS=15000

VITE_BACKEND_URL=http://127.0.0.1:3000
```

Runtime memory is written to `backend/data/memory.json` and is intentionally not tracked by git.

## Running

Install dependencies in both the root and backend:

```powershell
npm install
cd backend && npm install
```

Start the backend observer:

```powershell
cd backend
node server.js
```

In a separate shell, start the frontend:

```powershell
npm run dev
```

Open the workspace at `http://127.0.0.1:5173`.

To launch the native cursor companion, use the `Desktop cursor` button in the UI. It invokes `backend/nativeCompanion.ps1` and runs it detached from the main process.

## Local Model

The backend is ready for Ollama but does not install it for you.

```powershell
ollama pull gemma3n:e4b
```

If your local model has a different tag, set `OLLAMA_MODEL` in the environment. The app exposes:

- `GET /api/local-model/status`
- `POST /api/local-model/test`

## Voice and Microphone

Click the mic button in the top bar to record audio. The recording is captured as a WebM blob and sent directly to the Gemini API for transcription and response. The response is played back via natural TTS. If a non-English language is selected, the response text is first translated through Gemini before playback.

## Notes

- The screen capture targets the primary monitor specifically, resolving DPI scaling issues on multi-monitor Windows setups.
- Intervention deduplication is title-based. An issue with the same title will not be shown again while it remains in the active history.
- Issue history caps at 50 items and is maintained in memory for the session.
