import { describe, expect, it } from "vitest";
import {
    isMockupTeacherIdentity,
    MOCKUP_TEACHER_ID,
    MOCKUP_TEACHER_IDENTITY,
} from "./mockupAccount";

describe("mockup account", () => {
    it("exposes one stable, premium showcase identity", () => {
        expect(MOCKUP_TEACHER_IDENTITY).toEqual({
            teacherId: MOCKUP_TEACHER_ID,
            email: "demo@omrmaker.kr",
            displayName: "김하늘 선생님",
            plan: "academy",
        });
    });

    it("recognizes only the dedicated showcase teacher id", () => {
        expect(isMockupTeacherIdentity({ teacherId: MOCKUP_TEACHER_ID })).toBe(true);
        expect(isMockupTeacherIdentity({ teacherId: ` ${MOCKUP_TEACHER_ID.toUpperCase()} ` })).toBe(true);
        expect(isMockupTeacherIdentity({ teacherId: "admin" })).toBe(false);
        expect(isMockupTeacherIdentity(null)).toBe(false);
    });
});
