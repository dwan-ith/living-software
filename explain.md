# Persistent Computer — Full Explanation

## The Core Idea

Every computer today is stateless in practice. You open a file, delete it, rename a folder, paste something — and nothing in the environment knows whether that action contradicts what you were doing three minutes ago. The computer does not remember. It does not object. It just executes.

Persistent Computer is built on a different premise: the computer should be watching, building context over time, and intervening only when it has grounded visual evidence that something is wrong.

This is not a copilot or an autocomplete. It does not help you write faster. It watches the desktop continuously, reasons about what it sees, and speaks up when it detects a real inconsistency — with screen-level evidence to back it up.

The design goal is a single spoken sentence delivered at the right moment:

> You are deleting `train.py` but it is imported in four other notebooks that are currently open.

That sentence requires several things to be true at once: real screen capture, a vision model that can reason about what it sees, a persistent memory of past sessions, file-system awareness, and the restraint to stay quiet unless the evidence is solid. All of these are built here.

---

## System Architecture

The system is divided into a Node.js backend that runs permanently and a React frontend that connects to it over WebSocket.

```
Windows primary screen
    -> PowerShell capture (PrimaryScreen.Bounds)
    -> screenObserver.js (captureDesktop + analyzeDesktop)
    -> Gemini 3.5 Flash multimodal vision (gemini-3.5-flash)
    -> observerTick loop (every 3.5 seconds capture, every 15 seconds analysis)
    -> WebSocket broadcast to all connected React clients
    -> React workspace receives: frame, analysis, intervention, memory events
    -> Intervention card rendered in Pushback panel
    -> Nano Banana grounded image generation (gemini-3.1-flash-image)
```

The frontend never scrapes the screen. All perception happens in Node.

---

## The Observer Loop

The heart of the system is a continuous tick function that runs every second. It enforces two separate timers:

- Capture interval: every 3.5 seconds by default (configurable via `OBSERVER_INTERVAL_MS`)
- Analysis cooldown: every 15 seconds by default (configurable via `OBSERVER_ANALYSIS_COOLDOWN_MS`)

Every tick, the observer calls `captureDesktop()`, which runs a PowerShell one-liner that uses `System.Windows.Forms.Screen.PrimaryScreen.Bounds` to grab the exact pixel dimensions of the primary monitor, copies it into an in-memory bitmap, compresses it as JPEG, and returns a base64 string. This is DPI-aware and correctly handles the right edge of the screen, which virtual-screen coordinate methods often cut off.

The base64 JPEG is broadcast over WebSocket as a `screen` event. Every connected React client renders this as its live screen preview — essentially a low-latency real-time screencast served locally.

When the analysis cooldown has passed, the observer sends the base64 image along with a structured prompt to Gemini multimodal. The model is instructed to return structured JSON only, in this exact shape:

```json
{
  "shouldIntervene": false,
  "severity": "quiet",
  "application": "VS Code",
  "title": "Short factual headline",
  "reason": "What changed or appears risky, grounded in visible evidence only",
  "evidence": ["up to 3 visible facts from the screenshot"],
  "actions": ["up to 3 safe reversible next steps"],
  "spoken": "One concise sentence to say aloud"
}
```

The model is explicitly instructed: do not invent hidden dependencies. If there is no grounded reason to intervene, set `shouldIntervene` to false and severity to quiet. This is the core restraint. Most ticks return nothing.

When `shouldIntervene` is true, the backend broadcasts an `intervention` event over WebSocket, which the React frontend catches and adds to the active Pushback panel. The backend simultaneously writes the intervention to the persistent memory store as an episode, so future conversations can recall that this screen event happened.

---

## Nano Banana Image Generation

When an intervention fires, the backend immediately makes two parallel fetch calls:

**Broken Future** (`POST /api/dream/broken-future`)
This hits the Nano Banana 2 image model (`gemini-3.1-flash-image`) with the current desktop screenshot attached as inline image data, and asks it to generate a visual of what the screen will look like if this error goes unaddressed. The image is injected directly into the intervention card and can be clicked to open full-screen in a lightbox modal.

**Video Preview** (`POST /api/dream/video-preview`)
This calls Gemini Omni Flash (`gemini-omni-flash-preview`), which operates through the Interactions API rather than the standard content API. If the API returns video binary data, it is embedded as an autoplay MP4. This requires preview API access. If not available, nothing is shown — the system degrades cleanly.

These visual outputs serve a specific purpose: making the pushback legible at a glance. Rather than requiring the user to read a paragraph of JSON, they see a screenshot-grounded image of what could go wrong.

---

## Intervention Deduplication

The frontend maintains two lists: `interventions` (active, displayed in the sidebar) and `issueHistory` (the full session record, accessible from the Issues History page).

When a new intervention arrives over WebSocket, before doing anything, the system checks whether an entry with the same title already exists in `issueHistory`. If it does, the new event is silently dropped. This prevents the observer from flooding the interface with the same alert every 15 seconds just because the user has not dismissed it yet.

An intervention is only dismissed when the user explicitly clicks Dismiss. If they click Investigate, the app navigates to the Screen page to show the live capture.

---

## Persistent Memory

The memory store is a flat JSON file at `backend/data/memory.json`. It stores three kinds of records:

- **Facts**: Standing truths about the project or the user's context. For example: `"This project uses gemini-3.5-flash for reasoning."`
- **Episodes**: Time-stamped events with surfaces (which agent produced them) and importance weights. Screen interventions are stored as episodes automatically.
- **Associations**: Explicit links between two named concepts with a relationship label.

On every `/api/interactions/ask` call, the backend optionally recalls the most relevant memory items for the query and injects them into the Gemini prompt. The model then has access to context it learned in previous sessions.

This is not a vector database. It is a simple fuzzy text-match recall that scores items against the current query. Good enough for the prototype. The architecture describes the next step clearly: replace recall with embedding-based semantic search.

---

## Workspace Agents

The left navigation rail exposes a set of agents, each of which pulls metadata from the local file system:

| Agent | What it reads | Purpose |
|---|---|---|
| Screen | Live WebSocket frame | Real-time desktop view with analysis |
| Notes | Markdown files in common note locations | Surface note content to Gemini for analysis |
| Gallery | Recent image/video files | Surface media files for context and analysis |
| Files | Recent downloads and local files | Reference and deletion risk assessment |
| Downloads | Downloads folder | Why does this file exist? What project does it belong to? |
| Graph | Import-aware dependency scan | JS, TS, TSX, Python, notebooks, markdown, JSON |
| Clipboard | System clipboard (read-once consent gate) | Understand clipboard intent before paste |
| Notifications | In-app notification inbox | Group notifications by project rather than by app |

Each agent page renders a list of items with an action button. When you click the button (e.g. "Explain context" on a note file), the frontend calls `askGemini` with the file metadata and asks a targeted question. The result is rendered inline on the agent page.

---

## Voice and Microphone

The voice system has two directions:

**Speaking (output):**
When an intervention fires and has a `spoken` field, the system calls `speakWithGeminiTranslation`. If the selected language is English, the text is sent directly to the Google Translate TTS endpoint, which produces natural-sounding audio significantly better than browser `speechSynthesis`. If the selected language is non-English (Hindi, Mandarin, Spanish, Arabic), the text is first sent to Gemini with a translation-only system instruction, and the translated output is then sent to the TTS endpoint in the correct locale. If the TTS endpoint fails (CORS or rate limit), the system falls back to `speechSynthesis` automatically.

**Listening (input):**
The mic button uses `navigator.mediaDevices.getUserMedia` to request raw microphone access. It records as a `audio/webm` blob using `MediaRecorder`. When you click stop (or the recording ends), the blob is base64-encoded and sent directly to the backend `/api/interactions/ask` endpoint as an `audioBase64` field alongside a text prompt. The backend attaches the audio as `inlineData` to the Gemini content parts. Gemini 3.5 Flash can process audio directly as multimodal input, so it transcribes and responds in one round trip. The text response is then passed through the translation and TTS pipeline.

This is fully Gemini-based. No browser speech recognition API is used at any point.

---

## Language Selection

The dropdown in the top bar selects the TTS/translation target language. This setting affects:
- The locale passed to TTS on voice output
- The language the text is translated to before playback (if non-English)
- The `lang` attribute passed to `MediaRecorder`-derived requests (for regional speech tuning)

The language selector does not currently affect the Gemini analysis or intervention language. Interventions are generated in English by the vision model. Only the `spoken` field is routed through translation.

---

## Native Desktop Companion

Separate from the browser, the system can launch a small PowerShell-based overlay that draws a coloured arrow near your real system cursor. This is started by clicking the `Desktop cursor` button in the top bar. It spawns `backend/nativeCompanion.ps1` as a detached process using Windows Forms.

The companion is currently a passive overlay. The architecture has a planned next step: bridge the intervention state into the companion so it changes shape and colour when the agent detects something. Right now it exists as a proof that the system can cross the boundary from browser to native Windows UI.

---

## Agent Evaluation (Rigor)

The backend has a `projectRigor` function that scores each of the eight internal agents on a scale of 0 to 100. The scoring is based on what physical files exist, whether dependencies are present, and whether the API key is configured. Each agent has an explicit `gaps` list and a `next` field describing what would need to be built to advance from current state.

The current average sits at the "prototype" band, meaning the agent shapes are real but some execution loops are still surface-level.

---

## Models in Use

| Model | Purpose |
|---|---|
| `gemini-3.5-flash` | Screen analysis, reasoning, clipboard understanding, note analysis, dependency risk, translation, audio processing |
| `gemini-3.1-flash-image` | Nano Banana grounded image generation (broken future state visuals) |
| `gemini-3.1-flash-lite-image` | Lighter image generation for high-volume use cases |
| `gemini-omni-flash-preview` | Video generation via Interactions API (requires preview access) |
| Ollama + `gemma3n:e4b` | Local private reasoning, offline fallback |

The system always prefers Gemini if the API key is present. Ollama is a fallback for fully local / air-gapped operation.

---

## What Makes It Different

Most AI desktop tools are query-based. You open them, type a question, get an answer, close them. This system runs continuously in the background. You do not query it. It queries the screen.

The practical implication is that it can catch things you would never have thought to ask about — a broken import right as you are about to delete the file, an error message that appeared while you were reading a different window, a clipboard item that contradicts your current document.

The design principle is: stay silent until the evidence is grounded, then speak exactly once with a single actionable sentence. Do not fill the screen with tooltips. Do not suggest things without citing what was visible. Do not repeat the same intervention.

That restraint is what makes the pushback credible rather than annoying.
