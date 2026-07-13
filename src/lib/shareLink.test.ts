import { describe, expect, it } from "vitest";

import { buildSolveShareUrl, isShareUrlReachableByStudents, resolveShareBaseUrl } from "./shareLink";

describe("resolveShareBaseUrl", () => {
    it("prefers the configured public base url over the current origin", () => {
        expect(
            resolveShareBaseUrl({ envBaseUrl: "https://omr.example.com/", origin: "http://127.0.0.1:52341" }),
        ).toBe("https://omr.example.com");
    });

    it("falls back to the current origin when no base url is configured", () => {
        expect(resolveShareBaseUrl({ envBaseUrl: null, origin: "https://app.omr.kr" })).toBe("https://app.omr.kr");
    });

    it("ignores malformed base urls", () => {
        expect(resolveShareBaseUrl({ envBaseUrl: "omr.example.com", origin: "https://app.omr.kr" })).toBe(
            "https://app.omr.kr",
        );
    });

    it("returns an empty string when nothing is available", () => {
        expect(resolveShareBaseUrl({ envBaseUrl: null, origin: null })).toBe("");
    });
});

describe("buildSolveShareUrl", () => {
    it("builds an absolute solve url for an exam", () => {
        expect(buildSolveShareUrl("exam-1", { envBaseUrl: "https://omr.example.com", origin: null })).toBe(
            "https://omr.example.com/solve/exam-1",
        );
    });
});

describe("isShareUrlReachableByStudents", () => {
    it("flags loopback origins that students cannot open from their devices", () => {
        expect(isShareUrlReachableByStudents("http://127.0.0.1:52341/solve/exam-1")).toBe(false);
        expect(isShareUrlReachableByStudents("http://localhost:3003/solve/exam-1")).toBe(false);
    });

    it("accepts non-loopback origins", () => {
        expect(isShareUrlReachableByStudents("https://omr.example.com/solve/exam-1")).toBe(true);
        expect(isShareUrlReachableByStudents("http://192.168.0.12:3003/solve/exam-1")).toBe(true);
    });
});
