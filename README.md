# The Continuous Object Runtime (COR)

**We believe every software object should be a continuously running process instead of static data.**

COR operates not as an application, but as a **Companion Primitive**. Just as the clipboard, the window, and drag-and-drop became foundational computing primitives, COR introduces the **Continuous Object**, shifting the computing paradigm from *event-driven* to *continuous existence*.

### The Anti-Clippy (Semantic Guardian)
Instead of annoying popups, COR runs continuously in the background (using a highly optimized, privacy-first PowerShell screen capture loop) and leverages agentic reasoning to understand the **context** and **intent** of your actions. When a critical fracture in your computational timeline is detected (e.g., deleting a core dependency), the "Living Dot" (your secondary companion cursor) activates to intervene, negotiate, and repair.

---

## ⚡ Key Primitives Demonstrated

### 1. Contextual Friction (Files & Folders)
* **Dependency Observer:** Delete `train.py`, and the system knows it's the *only* version connected to 8 notebooks and a research paper. It intervenes, showing you the graph breakage and offering to archive or decouple instead of blindly asking "Are you sure?"
* **Autosorting (Downloads):** The Downloads folder is no longer a graveyard. Downloads ask "Why do I exist?" An invoice automatically routes to Finance; a `dataset.zip` is bound to your active ML project context.

### 2. Intent Resolution & Semantic Memory
* **Intent Buffer (Clipboard):** The clipboard stops storing strings and starts storing *intent*. Copying a paper title while the system detects you are authoring in Word offers intelligent options: "Paste as APA Citation" or "Paste as BibTeX".
* **Project Clustering (Notifications):** Notifications aren't grouped blindly by app (Slack, GitHub, Calendar). They are grouped temporally by context. For instance, the "Hackathon Pitch Context" intelligently merges a Slack question, a PR approval, and a Calendar alert together.

---

## 🛠️ Built With (Google AI Stack)

* **Google Gemini 2.5 Flash:** Used as the hyper-fast reasoning engine for continuous, real-time perception analysis (replacing our initial local-Ollama implementation for maximum speed during the hackathon).
* **Gemini Live API (TTS):** Provides the conversational, context-aware voice of the semantic guardian.
* **Nano Banana 2 Lite / Omni Flash:** Fast generative modeling dynamically renders the "Broken Future" visual dependency graphs when a timeline intervention is triggered.
* **React (Vite) + Node.js:** The entire dashboard seamlessly hosts the background daemon logic and transparent overlay UI.

---

## 🚀 Setup & Running

**Prerequisites:** Node.js 18+ and a Windows environment (required for native desktop screen capture).

```bash
# 1. Install frontend dependencies
npm install

# 2. Start the Continuous UI / Companion Canvas
npm run dev

# 3. In a second terminal, install backend dependencies
cd backend
npm install

# 4. Supply your Google API Key and start the Observer Daemon
# Ensure you have set GEMINI_API_KEY in your environment variables.
node server.js
```

### Navigating the Demo
Once both servers are running, access the dashboard at `http://localhost:5173`. 
The Guardian will immediately begin its continuous perception loop (checking the screen every 3.5 seconds). Navigate between the **Screen**, **Files**, **Clipboard**, and **Notifications** tabs to simulate the various triggers!
