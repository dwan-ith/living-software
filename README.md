# Persistent Computer

> **"We believe every software object should be a continuously running process — not static data."**

[![Google DeepMind Bangalore Hackathon](https://img.shields.io/badge/Google%20DeepMind-Hackathon%202026-4285F4?style=flat-square&logo=google)](https://deepmind.google)
[![Built with Gemini](https://img.shields.io/badge/Powered%20by-Gemini%202.5%20Flash-blueviolet?style=flat-square&logo=google)](https://ai.google.dev)
[![Electron](https://img.shields.io/badge/Overlay-Electron-47848F?style=flat-square&logo=electron)](https://www.electronjs.org/)
[![React + Vite](https://img.shields.io/badge/UI-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react)](https://vitejs.dev)

---

## What is this?

Most software today is **event-driven**: you do something, the software reacts, then it goes to sleep.

**Persistent Computer** proposes a new paradigm: a *Continuous Object Runtime* (COR) where every software artifact — a file, a note, a snippet of code — is not static data but a **continuously running process** that thinks, remembers, and reacts even when you're not looking at it.

This is not a notes app.
This is not a file manager.

It is a **new OS-level primitive** — in the same family as the clipboard, drag-and-drop, and the window — that fundamentally changes the relationship between a human and their computer.

---

## The Anti-Clippy: A Semantic Guardian

Clippy interrupted you to be annoying.

**The Persistent Companion** appears silently as a second arrow trailing your OS cursor. It watches everything happening on your screen using local Gemini multimodal reasoning. It stays completely invisible and click-through 99% of the time.

When it detects a **fracture in your computational timeline**, the arrow morphs into a black circle with a dot — and speaks to you.

```
You deleted train.py.

This file is referenced by 8 notebooks,
imported by 3 scripts,
and is the only copy of the experiment in Paper X.

Your presentation, report, and notebook all depend on it.

→ Archive it    → Fork it    → Remove downstream references
```

That is not "Are you sure?" That is software that *understands*.

---

## The 7 Living Primitives

### 1. 🗂️ Dependency Observer (Files)
Delete a file → the system knows its full dependency graph *before* you commit. It shows you exactly what breaks and offers surgical alternatives, not a binary yes/no dialog.

**Autosorting Downloads:** Every download asks "Why do I exist?" — an invoice routes itself to Finance; a dataset attaches itself to the active ML project. The Downloads folder is no longer a graveyard.

### 2. 📋 Intent Buffer (Clipboard)
The clipboard shouldn't store *strings*. It should store *intent*.

Copy a paper title while writing in Word, and the system offers:
- Paste as **APA Citation**
- Paste as **BibTeX**
- Paste as **Markdown link**
- Paste as **LaTeX figure**

### 3. 🔔 Project Clustering (Notifications)
Notifications are not grouped by app. They are grouped by **active context**. Seven scattered pings from Slack, GitHub, and Calendar are merged into one coherent briefing:

> *"These all relate to your Hackathon pitch in 10 minutes."*

### 4. 🖼️ Gallery Guardian
Upload a screenshot that is conceptually incoherent with your current project? The companion notices. Delete the last photo of a kind? It intervenes first.

### 5. 📝 Semantic Notes
Type a new concept into your notes app that you mentioned 3 weeks ago in a completely different context? The companion surfaces the connection. Invent a term that doesn't exist anywhere? It asks: *"What does this mean? I'd like to remember it."*

### 6. 🎞️ Slide Coherence
Working on a presentation — change a slide so it contradicts another? The companion flags the semantic conflict before you send the deck.

### 7. 🔄 Schrödinger Branching
Every significant decision creates **multiple parallel futures** instead of one irreversible state. Fork a computation. Let both versions evolve. Choose the better timeline.

---

## Architecture

```
┌───────────────────────────────────────────────────┐
│                 Windows Desktop                     │
│                                                     │
│  ┌─────────────────────────────────────────────┐  │
│  │        Electron Transparent Overlay          │  │
│  │  (always-on-top, click-through, 60fps scan)  │  │
│  │                                              │  │
│  │   ┌──────────────────────────────────────┐  │  │
│  │   │      React (Vite) Dashboard           │  │  │
│  │   │  Screen · Files · Clipboard · Notifs  │  │  │
│  │   └──────────────────────────────────────┘  │  │
│  │                  ↕ WebSocket                 │  │
│  │   ┌──────────────────────────────────────┐  │  │
│  │   │        Node.js Observer Daemon        │  │  │
│  │   │  PowerShell screen capture  (3.5s)    │  │  │
│  │   │  Gemini 2.5 Flash multimodal vision   │  │  │
│  │   │  Gemini Live API (voice pushback)     │  │  │
│  │   └──────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

### The Companion Dot State Machine

```
Normal               Intervention            Dismissed
  ↓                      ↓                      ↓
[Arrow]  ──trigger──> [●  Circle+Dot]  ──click──> [Arrow]
 (invisible,           (black orb with            (returns to
  click-through)        red dot, speaks)           pass-through)
```

---

## Google AI Stack

| Component | Role |
|---|---|
| **Gemini 2.5 Flash** | Multimodal screen understanding — sees your desktop and reasons about context |
| **Gemini Interactions API** | `/api/interactions/ask` — powers the Files, Clipboard, and Notifications AI responses |
| **Gemini Live API (TTS)** | The companion's voice — speaks the intervention as a natural sentence |
| **Nano Banana 2 Lite / Omni Flash** | Generates visual "broken future" dependency graphs for the intervention panel |

---

## Running Locally

**Prerequisites:** Node.js 18+, Windows (for native screen capture), a `GEMINI_API_KEY`.

```bash
# 1. Clone the repo
git clone https://github.com/dwan-ith/Persistent-Computer.git
cd Persistent-Computer

# 2. Install frontend deps
npm install

# 3. Install backend deps
cd backend && npm install && cd ..

# 4. Create your environment file
cp .env.example .env
# → Add your GEMINI_API_KEY to .env

# 5. Start everything
# Terminal A: Backend observer daemon
cd backend && node server.js

# Terminal B: Vite dev server
npm run dev

# Terminal C: OS-level desktop companion overlay
npm run overlay
```

The React dashboard opens at `http://localhost:5173`.  
The Electron overlay runs on top of your **entire Windows desktop** — open any app and the companion arrow will follow your cursor system-wide.

---

## Demo Script (3 minutes)

1. **Open the overlay** — show the black arrow trailing the real cursor over VS Code or Chrome
2. **Navigate to Files** — hit "Simulate Deleting `train.py`"
3. **Watch the Dot activate** — arrow morphs, companion speaks via Gemini TTS
4. **Show the dependency graph** — evidence panel + action buttons
5. **Click "Investigate"** — companion walks through the breakage
6. **Navigate to Clipboard** — read clipboard → show contextual citation options
7. **Navigate to Notifications** — hit "Ask Gemini to merge" → see project-clustered briefing
8. **Close everything. Wait 30s. Reopen.** → Objects have continued evolving.

That last step is the paradigm shift.

---

## Why This Wins

| What we built | What it actually is |
|---|---|
| A screen observer | The first step toward an OS that never forgets |
| A file dependency watcher | Software that understands causality, not just state |
| A smart clipboard | Intent-aware copy/paste — a new OS primitive |
| An Electron overlay | Proof that this can generalize to every app on earth |

> *"Cursor didn't build a new OS. It built a new primitive inside VS Code. We're doing the same — but for your entire computer."*

---

## Team

Built for the **Google DeepMind Bangalore Hackathon 2026** in a single session.

---

## License

MIT
