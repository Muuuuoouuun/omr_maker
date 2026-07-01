/** URL-encode an inline SVG for use in a CSS `cursor: url(...)` value. */
function encodeSvg(svg: string): string {
    return svg
        .replace(/"/g, "'")
        .replace(/%/g, "%25")
        .replace(/#/g, "%23")
        .replace(/</g, "%3C")
        .replace(/>/g, "%3E")
        .replace(/ /g, "%20");
}

/**
 * CSS `cursor` value showing a pen glyph tinted with `color`, hotspot at the
 * nib (bottom-left). Falls back to `crosshair`.
 */
export function buildPenCursor(color: string): string {
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>` +
        `<path d='M22 3 L29 10 L12 27 L5 27 L5 20 Z' fill='${color}' stroke='white' stroke-width='1.5' stroke-linejoin='round'/>` +
        `<path d='M5 27 L5 23 L9 27 Z' fill='#1f2937'/>` +
        `</svg>`;
    return `url("data:image/svg+xml,${encodeSvg(svg)}") 5 27, crosshair`;
}

/**
 * CSS `cursor` value showing a highlighter glyph, hotspot at the tip.
 * Falls back to `crosshair`.
 */
export function buildHighlighterCursor(): string {
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>` +
        `<path d='M23 4 L28 9 L14 23 L8 23 L8 17 Z' fill='rgba(250,204,21,0.95)' stroke='white' stroke-width='1.5' stroke-linejoin='round'/>` +
        `</svg>`;
    return `url("data:image/svg+xml,${encodeSvg(svg)}") 8 23, crosshair`;
}
