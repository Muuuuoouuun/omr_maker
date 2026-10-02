import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("group invite rotation distribution surface", () => {
    it("warns before replacing an existing group QR and labels the destructive CTA", () => {
        const modal = read("src/components/DistributeModal.tsx");

        expect(modal).toContain("confirmExistingGroupInviteRotation");
        expect(modal).toContain("기존 링크와 QR은 즉시 무효화됩니다");
        expect(modal).toContain("새 링크 발급하기");
    });

    it("carries the authoritative invite expiry from the action result into the modal", () => {
        const modal = read("src/components/DistributeModal.tsx");
        const createPage = read("src/app/create/page.tsx");

        expect(createPage).toContain("expiresAt: inviteExpiresAt");
        expect(modal).toContain("링크 만료 시각");
        expect(modal).toContain("shareResult.expiresAt");
    });
});
