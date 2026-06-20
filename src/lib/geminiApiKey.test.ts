import { describe, expect, it } from "vitest";
import {
    extractGeminiApiKeyFromSettings,
    maskGeminiApiKey,
    resolveGeminiApiKey,
} from "./geminiApiKey";

describe("resolveGeminiApiKey", () => {
    it("uses the personal Gemini key before the server fallback", () => {
        expect(resolveGeminiApiKey("  personal-key  ", "server-key")).toBe("personal-key");
    });

    it("falls back to the server key when no personal key is saved", () => {
        expect(resolveGeminiApiKey("", "  server-key  ")).toBe("server-key");
    });
});

describe("extractGeminiApiKeyFromSettings", () => {
    it("reads the Gemini key from persisted settings JSON", () => {
        expect(extractGeminiApiKeyFromSettings('{"api":{"geminiKey":"  abc123  "}}')).toBe("abc123");
    });

    it("returns an empty string for malformed or missing settings", () => {
        expect(extractGeminiApiKeyFromSettings("{broken")).toBe("");
        expect(extractGeminiApiKeyFromSettings('{"api":{}}')).toBe("");
    });
});

describe("maskGeminiApiKey", () => {
    it("masks long keys while preserving enough context", () => {
        expect(maskGeminiApiKey("1234567890abcdef")).toBe("12345678•••••def");
    });

    it("does not invent a mask for empty keys", () => {
        expect(maskGeminiApiKey("")).toBe("");
    });
});
