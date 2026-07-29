import { describe, expect, it } from "vitest";
import { isSafeExternalUrl } from "../../electron/navigation-policy.mjs";

describe("Electron external navigation policy", () => {
    it("allows only explicit HTTP and HTTPS external targets", () => {
        expect(isSafeExternalUrl("https://example.com/help")).toBe(true);
        expect(isSafeExternalUrl("http://127.0.0.1:3003/help")).toBe(true);
        expect(isSafeExternalUrl("mailto:support@example.com")).toBe(false);
        expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
        expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
        expect(isSafeExternalUrl("custom-protocol://payload")).toBe(false);
        expect(isSafeExternalUrl("not a url")).toBe(false);
    });
});
