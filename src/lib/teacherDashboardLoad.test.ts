import { describe, expect, it } from "vitest";
import { preferLocalDashboardItems } from "./teacherDashboardLoad";

describe("teacher dashboard load fallback", () => {
    const cached = [{ id: "cached" }];

    it("preserves cached items when the canonical read reports an error", () => {
        expect(preferLocalDashboardItems({ items: [], remoteError: "offline" }, cached)).toEqual(cached);
    });

    it("accepts an authoritative empty canonical response", () => {
        expect(preferLocalDashboardItems({ items: [] }, cached)).toEqual([]);
    });

    it("uses successfully loaded canonical items", () => {
        const remote = [{ id: "remote" }];
        expect(preferLocalDashboardItems({ items: remote }, cached)).toEqual(remote);
    });
});
