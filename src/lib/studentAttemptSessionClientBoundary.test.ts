import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("student attempt session client boundary", () => {
    it("keeps Node crypto out of the client-safe contract", () => {
        const contract = readFileSync(join(process.cwd(), "src/lib/studentAttemptSessionContract.ts"), "utf8");
        expect(contract).not.toContain('from "node:crypto"');
        expect(contract).not.toContain("leaseTokenHash");

        const crypto = readFileSync(join(process.cwd(), "src/lib/studentAttemptSessionCrypto.server.ts"), "utf8");
        expect(crypto).toContain('from "node:crypto"');
    });
});
