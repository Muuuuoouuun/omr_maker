import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
    probeConfiguredProvisionedTeacherCanary,
    resolveProvisionedTeacherCanaryAccountId,
} from "./provisionedTeacherCanary.server";

describe("provisioned teacher release canary", () => {
    it("is a server-only service-role boundary", () => {
        expect(readFileSync(new URL("./provisionedTeacherCanary.server.ts", import.meta.url), "utf8"))
            .toContain('import "next/dist/compiled/server-only"');
    });
    it("accepts only an exact configured account id", () => {
        expect(resolveProvisionedTeacherCanaryAccountId({
            OMR_PROVISIONED_TEACHER_CANARY_ACCOUNT_ID: "teacher_0123456789abcdef",
        })).toBe("teacher_0123456789abcdef");
        for (const value of [undefined, "", " teacher_0123456789abcdef ", "teacher_0123456789abcdeF", "teacher_bad"]) {
            expect(resolveProvisionedTeacherCanaryAccountId({
                OMR_PROVISIONED_TEACHER_CANARY_ACCOUNT_ID: value,
            })).toBeNull();
        }
    });

    it("returns one redacted status and never exposes the configured id", async () => {
        const accountId = "teacher_0123456789abcdef";
        const client = { rpc: vi.fn(async () => ({ data: { ready: true }, error: null })) };
        await expect(probeConfiguredProvisionedTeacherCanary({
            OMR_PROVISIONED_TEACHER_CANARY_ACCOUNT_ID: accountId,
        }, undefined, client)).resolves.toBe("ready");
        expect(client.rpc).toHaveBeenCalledTimes(1);
        await expect(probeConfiguredProvisionedTeacherCanary({}, undefined, client)).resolves.toBe("not_configured");
        expect(client.rpc).toHaveBeenCalledTimes(1);
        const failed = { rpc: vi.fn(async () => { throw new Error(accountId); }) };
        await expect(probeConfiguredProvisionedTeacherCanary({
            OMR_PROVISIONED_TEACHER_CANARY_ACCOUNT_ID: accountId,
        }, undefined, failed)).resolves.toBe("not_ready");
    });
});
