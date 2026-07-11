/**
 * Last-resort SVG placeholder when Gemini image generation is unavailable.
 * Returns a real (small) image, not a 1x1 transparent pixel.
 */
export function renderImage(prompt = 'Living Software') {
    const label = String(prompt).replace(/[<>&'"]/g, '').slice(0, 48) || 'Living Software';
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="100%" stop-color="#142033"/>
    </linearGradient>
  </defs>
  <rect width="960" height="540" fill="url(#g)"/>
  <circle cx="180" cy="140" r="70" fill="#4ff0b8" fill-opacity="0.18"/>
  <circle cx="760" cy="400" r="110" fill="#4f8ff0" fill-opacity="0.16"/>
  <rect x="80" y="120" width="800" height="300" rx="28" fill="#101828" stroke="#4ff0b8" stroke-opacity="0.35"/>
  <text x="480" y="250" text-anchor="middle" fill="#e8eef8" font-family="Segoe UI, sans-serif" font-size="36" font-weight="600">${label}</text>
  <text x="480" y="300" text-anchor="middle" fill="#8aa0b8" font-family="Segoe UI, sans-serif" font-size="18">offline visual fallback</text>
</svg>`;
    return Buffer.from(svg).toString('base64');
}
