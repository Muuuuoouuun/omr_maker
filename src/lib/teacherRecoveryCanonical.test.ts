import { describe, expect, it } from "vitest";
import { buildTeacherRecoveryCanonicalUrl } from "./teacherRecoveryCanonical";

function canonicalUrl(rawUrl: string): string {
    return buildTeacherRecoveryCanonicalUrl(new URL(rawUrl, "https://omr.example"));
}

describe("provisioned teacher recovery canonical URL", () => {
    it("preserves only one exact approved teacher destination", () => {
        expect(canonicalUrl(
            "/?teacherResetToken=secret&role=student&exam=exam-1&next=%2Fteacher%2Fsettings&echo=secret#secret",
        )).toBe("/?role=teacher&teacherRecovery=legacy_link&next=%2Fteacher%2Fsettings");
    });

    it.each([
        "/?teacherResetToken=NESTED_SECRET&next=%2Fteacher%2Fsettings%3FteacherResetToken%3DNESTED_SECRET%26echo%3DNESTED_SECRET#teacherVerifyToken=NESTED_SECRET",
        "/?teacherVerifyToken=ENCODED_SECRET&next=%252Fteacher%252Fsettings%253FteacherVerifyToken%253DENCODED_SECRET&echo=%2574eacherResetToken%253DENCODED_SECRET",
        "/?teacherResetToken=FIRST_SECRET&teacherResetToken=SECOND_SECRET&next=%2Fteacher%2Fsettings&next=%2Fteacher%2Fdashboard%3FteacherResetToken%3DSECOND_SECRET",
        "/?teacherVerifyToken=PATH_SECRET&next=%2Fteacher%2FPATH_SECRET",
        "/?teacherResetToken=OPEN_REDIRECT_SECRET&next=https%3A%2F%2Fevil.example%2Fteacher%2Fsettings",
        "/?teacherVerifyToken=PROTOCOL_RELATIVE_SECRET&next=%2F%2Fevil.example%2Fteacher%2Fsettings",
    ])("drops nested, encoded, duplicate, fragment, and unapproved values from %s", rawUrl => {
        expect(canonicalUrl(rawUrl)).toBe("/?role=teacher&teacherRecovery=legacy_link");
    });
});
