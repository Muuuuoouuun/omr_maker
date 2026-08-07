import { describe, expect, it } from "vitest";
import { mayRunMutatingE2E } from "../../e2e/mutationSafety";

describe("mutating browser journey safety", () => {
    it.each([
        "http://localhost:3003",
        "http://127.0.0.1:3003",
        "http://[::1]:3003",
    ])("allows local test servers without an external opt-in: %s", baseURL => {
        expect(mayRunMutatingE2E(baseURL, undefined)).toBe(true);
    });

    it("fails closed for malformed or external URLs", () => {
        expect(mayRunMutatingE2E("not a url", undefined)).toBe(false);
        expect(mayRunMutatingE2E("https://omr-maker-eight.vercel.app", undefined)).toBe(false);
    });

    it("requires an exact explicit opt-in for an external fixture environment", () => {
        const baseURL = "https://omr-e2e.example.test";
        expect(mayRunMutatingE2E(baseURL, "true")).toBe(false);
        expect(mayRunMutatingE2E(baseURL, "1")).toBe(true);
    });
});
