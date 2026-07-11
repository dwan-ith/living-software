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
export const DATA_DIR = path.join(__dirname, 'data');

function numberFromEnv(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function listFromEnv(name, fallback = []) {
    const value = process.env[name];
    if (!value) return fallback;
    return value.split(';').map((item) => item.trim()).filter(Boolean);
}

export const PORT = numberFromEnv('PORT', 3000);
export const POWERSHELL_EXE = process.env.POWERSHELL_EXE || 'powershell.exe';
export const OBSERVER_INTERVAL_MS = numberFromEnv('OBSERVER_INTERVAL_MS', 3500);
export const OBSERVER_ANALYSIS_COOLDOWN_MS = numberFromEnv('OBSERVER_ANALYSIS_COOLDOWN_MS', 15000);

export const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
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

let _ai = null;

export function hasGemini() {
    return Boolean(GEMINI_API_KEY);
}

/**
 * Lazy Gemini client. Prefer default API routing (v1beta) so managed agents work.
 * Explicit apiVersion: 'v1' breaks antigravity and some image models.
 */
export function getGemini() {
    if (!hasGemini()) {
        throw new Error('GEMINI_API_KEY is not set. Add it to backend/.env or the project root .env.');
    }
    if (!_ai) {
        _ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
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
