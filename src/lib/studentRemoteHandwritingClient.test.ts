import { describe, expect, it, vi } from "vitest";
import {
    REMOTE_HANDWRITING_DOWNLOAD_MAX_BYTES,
    downloadRemoteStudentHandwriting,
} from "./studentRemoteHandwritingClient";

describe("remote student handwriting client", () => {
    it("downloads and validates the signed JSON drawing archive without credentials or caching", async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ 1: ["stroke-a"] }), {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "18" },
        }));

        await expect(downloadRemoteStudentHandwriting("https://storage.example/signed", fetcher))
            .resolves.toEqual({ 1: ["stroke-a"] });
        expect(fetcher).toHaveBeenCalledWith("https://storage.example/signed", {
            cache: "no-store",
            credentials: "omit",
        });
    });

    it("rejects oversized, non-JSON, and structurally invalid responses", async () => {
        const oversized = vi.fn().mockResolvedValue(new Response("{}", {
            headers: { "content-type": "application/json", "content-length": String(REMOTE_HANDWRITING_DOWNLOAD_MAX_BYTES + 1) },
        }));
        const html = vi.fn().mockResolvedValue(new Response("<html></html>", {
            headers: { "content-type": "text/html" },
        }));
        const invalid = vi.fn().mockResolvedValue(new Response(JSON.stringify({ 1: [123] }), {
            headers: { "content-type": "application/json" },
        }));

        await expect(downloadRemoteStudentHandwriting("https://storage.example/large", oversized)).resolves.toBeNull();
        await expect(downloadRemoteStudentHandwriting("https://storage.example/html", html)).resolves.toBeNull();
        await expect(downloadRemoteStudentHandwriting("https://storage.example/invalid", invalid)).resolves.toBeNull();
    });
});
