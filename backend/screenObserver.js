import 'dotenv/config';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';

const execFileAsync = promisify(execFile);
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1' } });

const CAPTURE_SCRIPT = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)',
    '$stream = New-Object System.IO.MemoryStream',
    '$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
    '$graphics.Dispose()',
    '$bitmap.Dispose()',
    '[Convert]::ToBase64String($stream.ToArray())',
    '$stream.Dispose()'
].join('; ');

export async function captureDesktop() {
    if (process.platform !== 'win32') {
        throw new Error('The current observer implementation requires Windows.');
    }

    const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', CAPTURE_SCRIPT
    ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });

    const imageBase64 = stdout.trim();
    return {
        imageBase64,
        fingerprint: createHash('sha256').update(imageBase64).digest('hex'),
        capturedAt: new Date().toISOString()
    };
}

export async function detectLocalModel() {
    return {
        connected: Boolean(apiKey),
        provider: 'google-interactions',
        model: 'gemini-3.5-flash',
        models: ['gemini-3.5-flash', 'antigravity-preview-05-2026'],
        visionCapable: Boolean(apiKey)
    };
}

export async function analyzeDesktop(imageBase64, model) {
    const prompt = `You are the local perception layer of Living Software. Inspect this Windows desktop screenshot.
Return only JSON with this schema:
{
  "shouldIntervene": boolean,
  "severity": "quiet" | "notice" | "warning" | "critical",
  "application": "short app name",
  "title": "short factual headline",
  "reason": "what changed or appears risky, grounded only in visible evidence",
  "evidence": ["up to 3 visible facts"],
  "actions": ["up to 3 safe next actions"],
  "spoken": "one concise sentence to say aloud"
}
Intervene only for a visible inconsistency, destructive action, error, broken workflow, or a clear cross-document question. Do not invent hidden dependencies. If there is no grounded reason, set shouldIntervene false and severity quiet.`;

    try {
        const response = await ai.interactions.create({
            model: 'gemini-3.5-flash',
            input: [
                { type: 'text', text: prompt },
                { type: 'image', data: imageBase64, mime_type: 'image/jpeg' }
            ],
            store: false,
            generation_config: { temperature: 0.15 }
        });

        return JSON.parse(response.output_text || '{}');
    } catch (e) {
        throw new Error(`Gemini Interactions analysis failed: ${e.message}`);
    }
}
