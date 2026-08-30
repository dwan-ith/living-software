import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { Ollama } from 'ollama';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load backend/.env first, then repo-root .env without clobbering.
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });
dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

export const BACKEND_DIR = __dirname;
export const PROJECT_ROOT_DIR = PROJECT_ROOT;
export const DATA_DIR = process.env.LIVING_DATA_DIR
    ? path.resolve(process.env.LIVING_DATA_DIR)
    : path.join(__dirname, 'data');

function numberFromEnv(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function listFromEnv(name, fallback = []) {
    const value = process.env[name];
    if (!value) return fallback;
    return value.split(';').map((item) => item.trim()).filter(Boolean);
}

function booleanFromEnv(name, fallback) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export const PORT = numberFromEnv('PORT', 3000);
export const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

// Browser origins allowed to drive this runtime. WebSockets are not subject to
// CORS and state-changing cross-site requests bypass CORS reads entirely, so
// this allowlist must be enforced on both HTTP and WS handshakes.
export const ALLOWED_ORIGINS = Object.freeze(new Set(
    (process.env.ALLOWED_ORIGINS || 'http://localhost:5173;http://127.0.0.1:5173;http://localhost:5174;http://127.0.0.1:5174')
        .split(';').map((item) => item.trim().replace(/\/$/, '')).filter(Boolean)
));

/** No Origin header (curl/Electron/same-origin tools) is trusted; browsers must match. */
export function originAllowed(originHeader) {
    if (!originHeader) return true;
    try {
        const url = new URL(originHeader);
        return ALLOWED_ORIGINS.has(`${url.protocol}//${url.host}`);
    } catch {
        return false;
    }
}
export const POWERSHELL_EXE = process.env.POWERSHELL_EXE || 'powershell.exe';
export const OBSERVER_INTERVAL_MS = numberFromEnv('OBSERVER_INTERVAL_MS', 3500);
export const OBSERVER_ANALYSIS_COOLDOWN_MS = numberFromEnv('OBSERVER_ANALYSIS_COOLDOWN_MS', 15000);
export const OBSERVER_FAILURE_BACKOFF_MS = numberFromEnv('OBSERVER_FAILURE_BACKOFF_MS', 300000);
export const OBSERVER_PREFER_LOCAL_VISION = booleanFromEnv('OBSERVER_PREFER_LOCAL_VISION', false);
export const LIVING_CYCLE_INTERVAL_MS = numberFromEnv('LIVING_CYCLE_INTERVAL_MS', 60000);
export const LIVING_AUTOSTART = booleanFromEnv('LIVING_AUTOSTART', true);
export const MODEL_INFERENCE_ENABLED = booleanFromEnv('MODEL_INFERENCE_ENABLED', false);

export const GEMINI_API_KEY = MODEL_INFERENCE_ENABLED ? (process.env.GEMINI_API_KEY || '').trim() : '';
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
export const GEMINI_IMAGE_LITE_MODEL = process.env.GEMINI_IMAGE_LITE_MODEL || 'gemini-3.1-flash-lite-image';
export const GEMINI_OMNI_MODEL = process.env.GEMINI_OMNI_MODEL || 'gemini-omni-flash-preview';
export const GEMINI_AGENT = process.env.GEMINI_AGENT || 'antigravity-preview-05-2026';

export const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3n:e4b';
export const OLLAMA_BINARY_CANDIDATES = listFromEnv('OLLAMA_BINARY_CANDIDATES', [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Ollama', 'ollama.exe') : null,
    'C:\\Program Files\\Ollama\\ollama.exe'
].filter(Boolean));

export const ollama = new Ollama({ host: OLLAMA_HOST });

// Ollama can unload/reload large text and vision components between requests.
// Keep local inference serialized so screen perception cannot race capability
// synthesis and exhaust the machine while both models are being prepared.
let localModelQueue = Promise.resolve();

export function runLocalModelTask(task) {
    const result = localModelQueue.then(task, task);
    localModelQueue = result.catch(() => undefined);
    return result;
}

let _ai = null;

export function hasGemini() {
    return MODEL_INFERENCE_ENABLED && Boolean(GEMINI_API_KEY);
}

/**
 * Lazy Gemini client. Prefer default API routing (v1beta) so managed agents work.
 * Explicit apiVersion: 'v1' breaks antigravity and some image models.
 * A client-wide HTTP timeout keeps a hung inference request from freezing the
 * runtime's serialized mutation queue.
 */
export function getGemini() {
    if (!hasGemini()) {
        throw new Error('GEMINI_API_KEY is not set. Add it to backend/.env or the project root .env.');
    }
    if (!_ai) {
        _ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { timeout: 60_000 } });
    }
    return _ai;
}

export async function pathExists(target) {
    try {
        await access(target);
        return true;
    } catch {
        return false;
    }
}

/**
 * Hard metabolic limit for any provider call. A hung local or cloud model must
 * never wedge a queue permanently; the runtime kills the wait and moves on.
 */
export function withTimeout(promise, ms, label = 'operation') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** Default wall-clock budget for local model calls (Ollama can stall indefinitely). */
export const LOCAL_MODEL_TIMEOUT_MS = numberFromEnv('LOCAL_MODEL_TIMEOUT_MS', 90_000);

/** Pull text out of model replies that wrap JSON in markdown fences. */
export function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : raw).trim();

    try {
        return JSON.parse(candidate);
    } catch {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}
