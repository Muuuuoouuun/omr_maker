import { describe, expect, it } from "vitest";
import { resolveTeacherIdentityMode } from "./teacherIdentityMode";

describe("teacher identity mode", () => {
    it("locks production to provisioned-only for every configured value", () => {
        for (const configuredMode of [undefined, "provisioned_only", "self_service", " SELF_SERVICE "]) {
            expect(resolveTeacherIdentityMode({
                NODE_ENV: "production",
                OMR_TEACHER_IDENTITY_MODE: configuredMode,
            })).toBe("provisioned_only");
        }
    });

    it("enables self-service only from an explicit normalized nonproduction value", () => {
        expect(resolveTeacherIdentityMode({
            NODE_ENV: "development",
            OMR_TEACHER_IDENTITY_MODE: "self_service",
        })).toBe("self_service");
        expect(resolveTeacherIdentityMode({
            NODE_ENV: "test",
            OMR_TEACHER_IDENTITY_MODE: " SELF_SERVICE ",
        })).toBe("self_service");
    });

    it("fails missing and invalid nonproduction values to provisioned-only", () => {
        for (const configuredMode of [undefined, "", "provisioned_only", "self-service", "enabled"]) {
            expect(resolveTeacherIdentityMode({
                NODE_ENV: "development",
                OMR_TEACHER_IDENTITY_MODE: configuredMode,
            })).toBe("provisioned_only");
        }
    });
});
