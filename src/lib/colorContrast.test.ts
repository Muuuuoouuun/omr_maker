import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function channel(value: number): number {
    const normalized = value / 255;
    return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
    const value = hex.replace("#", "");
    const [red, green, blue] = [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16));
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(first: string, second: string): number {
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return (lighter + 0.05) / (darker + 0.05);
}

function cssVariables(block: string): Record<string, string> {
    return Object.fromEntries(
        [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)]
            .map(match => [match[1], match[2].toLowerCase()]),
    );
}

describe("semantic text color contrast", () => {
    const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
    const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || "";
    const darkBlock = css.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] || "";
    const light = cssVariables(rootBlock);
    const dark = { ...light, ...cssVariables(darkBlock) };
    const semanticTextTokens = ["text-primary", "text-secondary", "text-success", "text-error", "text-warning"];

    it.each([
        ["light", light],
        ["dark", dark],
    ] as const)("keeps %s semantic text at WCAG AA contrast on the surface", (_theme, variables) => {
        for (const token of semanticTextTokens) {
            expect(
                contrast(variables[token], variables.surface),
                `${token} must be at least 4.5:1 against surface`,
            ).toBeGreaterThanOrEqual(4.5);
        }
    });
});
