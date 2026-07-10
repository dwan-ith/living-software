// Fallback for Nano Banana 2 Lite if the actual endpoint isn't fully active yet.
export function renderImage(_prompt) {
    // Returns a base64 encoded tiny transparent png or a placeholder SVG
    // In a real app we might use a canvas library to generate a cool pattern
    return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
}
