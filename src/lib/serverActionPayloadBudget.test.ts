import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import {
    isRemoteAssetUploadByteSizeAllowed,
    REMOTE_HANDWRITING_MAX_BYTES,
    REMOTE_PDF_MAX_BYTES,
} from "./remoteAssetContract.server";

function configuredActionLimitBytes(): number {
    const configured = nextConfig.experimental?.serverActions?.bodySizeLimit;
    if (typeof configured !== "string") throw new Error("Server Action body limit must be explicit");
    const matched = /^(\d+)mb$/i.exec(configured);
    if (!matched) throw new Error(`Unsupported Server Action body limit: ${configured}`);
    return Number(matched[1]) * 1024 * 1024;
}

describe("Server Action payload budget", () => {
    it("keeps the global parser at the smallest safe 12 MiB budget", () => {
        expect(configuredActionLimitBytes()).toBe(12 * 1024 * 1024);
    });

    it("keeps legal 10 MiB handwriting below the parser budget", () => {
        expect(REMOTE_HANDWRITING_MAX_BYTES).toBe(10 * 1024 * 1024);
        expect(isRemoteAssetUploadByteSizeAllowed("attempt_handwriting", REMOTE_HANDWRITING_MAX_BYTES)).toBe(true);
        expect(isRemoteAssetUploadByteSizeAllowed("attempt_handwriting", REMOTE_HANDWRITING_MAX_BYTES + 1)).toBe(false);
        expect(configuredActionLimitBytes()).toBeGreaterThan(REMOTE_HANDWRITING_MAX_BYTES);
    });

    it.each(["problem_pdf", "answer_key_pdf"] as const)(
        "never permits a legal maximum %s PDF body through a Server Action",
        () => {
            expect(REMOTE_PDF_MAX_BYTES).toBe(50 * 1024 * 1024);
            expect(configuredActionLimitBytes()).toBeLessThan(REMOTE_PDF_MAX_BYTES);
        },
    );
});
