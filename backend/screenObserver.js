import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

async function fetchOllama(path, options = {}) {
    const response = await fetch(`http://127.0.0.1:11434${path}`, {
        ...options,
        signal: AbortSignal.timeout(options.timeout || 8000)
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    return response.json();
}

export async function detectLocalModel() {
    try {
        const data = await fetchOllama('/api/tags', { timeout: 2500 });
        const models = (data.models || []).map((item) => item.name);
        const preferred = models.find((name) => /gemma3|gemma-3/i.test(name))
            || models.find((name) => /llava|minicpm-v|qwen.*vl/i.test(name))
            || models.find((name) => /gemma/i.test(name))
            || models[0];

        return {
            connected: true,
            model: preferred || null,
            models,
            visionCapable: Boolean(preferred && /gemma3|gemma-3|llava|minicpm-v|qwen.*vl/i.test(preferred))
        };
    } catch (error) {
        return { connected: false, model: null, models: [], visionCapable: false, error: error.message };
    }
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

    const body = {
        model,
        stream: false,
        format: 'json',
        messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
        options: { temperature: 0.15 }
    };

    const data = await fetchOllama('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 45000
    });

    return JSON.parse(data.message?.content || '{}');
}

