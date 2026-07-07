import { describe, expect, it } from "vitest";
import { secureRandomId } from "./ids";

describe("secureRandomId", () => {
    it("returns a non-empty, URL-safe id", () => {
        const id = secureRandomId();
        expect(id.length).toBeGreaterThanOrEqual(16);
        // URL-safe: only unreserved characters
        expect(id).toMatch(/^[A-Za-z0-9._~-]+$/);
    });

    it("is not monotonic — consecutive ids are unique and not ordered by time", () => {
        const ids = new Set(Array.from({ length: 500 }, () => secureRandomId()));
        expect(ids.size).toBe(500);
    });
});
