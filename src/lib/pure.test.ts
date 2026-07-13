import { describe, it, expect } from "vitest";
import {
    hashString, pickFromList,
    csvEscape, toCsv,
    isValidEmail,
    recomputeGroupStats,
    countAnswered, mapAttemptStatus, computeProgress,
    getTimeGreeting,
    formatLimit, usagePct,
    formatKoreanDate, formatKoreanDateTime,
} from "./pure";

describe("hashString", () => {
    it("is deterministic", () => {
        expect(hashString("foo")).toBe(hashString("foo"));
    });
    it("differs for different inputs", () => {
        expect(hashString("a")).not.toBe(hashString("b"));
    });
    it("returns a non-negative integer", () => {
        for (const s of ["", "x", "한글", "mixed-123"]) {
            const h = hashString(s);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(h)).toBe(true);
        }
    });
});

describe("pickFromList", () => {
    it("returns the same element for the same seed", () => {
        const list = [1, 2, 3, 4, 5];
        expect(pickFromList(list, "seed-a")).toBe(pickFromList(list, "seed-a"));
    });
    it("throws on empty list", () => {
        expect(() => pickFromList([], "x")).toThrow();
    });
});

describe("csvEscape", () => {
    it("leaves plain text alone", () => {
        expect(csvEscape("hello")).toBe("hello");
    });
    it("wraps quotes and commas", () => {
        expect(csvEscape("a,b")).toBe('"a,b"');
        expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    });
    it("wraps newlines", () => {
        expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    });
});

describe("toCsv", () => {
    it("joins headers and rows", () => {
        const out = toCsv(["a", "b"], [["1", "2"], ["3", "4"]]);
        expect(out).toBe("a,b\n1,2\n3,4");
    });
    it("escapes commas inside cells", () => {
        const out = toCsv(["name"], [["Last, First"]]);
        expect(out).toBe('name\n"Last, First"');
    });
});

describe("isValidEmail", () => {
    it.each([
        ["a@b.c", true],
        ["user@domain.co.kr", true],
        ["  trim@me.com  ", true],
        ["no-at-sign", false],
        ["", false],
        ["a@b", false],
        ["a @b.c", false],
    ])("isValidEmail(%s) === %s", (input, expected) => {
        expect(isValidEmail(input)).toBe(expected);
    });
});

describe("recomputeGroupStats", () => {
    const students = [
        { group: "A", avgScore: 80 },
        { group: "A", avgScore: 90 },
        { group: "B", avgScore: 70 },
    ];
    const groups = [
        { name: "A", count: 0, avgScore: 0, color: "#111" },
        { name: "B", count: 0, avgScore: 0, color: "#222" },
        { name: "C", count: 0, avgScore: 0, color: "#333" },
    ];
    it("counts members per group", () => {
        const out = recomputeGroupStats(students, groups);
        expect(out.map(g => g.count)).toEqual([2, 1, 0]);
    });
    it("averages scores and rounds", () => {
        const out = recomputeGroupStats(students, groups);
        expect(out[0].avgScore).toBe(85);
        expect(out[1].avgScore).toBe(70);
        expect(out[2].avgScore).toBe(0);
    });
    it("preserves extra fields", () => {
        const out = recomputeGroupStats(students, groups);
        expect(out[0].color).toBe("#111");
    });
});

describe("countAnswered", () => {
    it("ignores 0 and undefined", () => {
        expect(countAnswered({ 1: 3, 2: 0, 3: 5 })).toBe(2);
    });
    it("returns 0 for undefined", () => {
        expect(countAnswered(undefined)).toBe(0);
    });
});

describe("mapAttemptStatus", () => {
    it("maps completed → submitted", () => {
        expect(mapAttemptStatus("completed")).toBe("submitted");
    });
    it("maps in_progress → in_progress", () => {
        expect(mapAttemptStatus("in_progress")).toBe("in_progress");
    });
    it("anything else → not_started", () => {
        expect(mapAttemptStatus(undefined)).toBe("not_started");
        expect(mapAttemptStatus("weird")).toBe("not_started");
    });
});

describe("computeProgress", () => {
    it("submitted is 100", () => {
        expect(computeProgress("submitted", 0, 20)).toBe(100);
    });
    it("in_progress scales by answered/total", () => {
        expect(computeProgress("in_progress", 5, 20)).toBe(25);
        expect(computeProgress("in_progress", 10, 20)).toBe(50);
    });
    it("handles totalQ=0 gracefully", () => {
        expect(computeProgress("in_progress", 5, 0)).toBe(0);
    });
    it("not_started is 0", () => {
        expect(computeProgress("not_started", 5, 20)).toBe(0);
    });
});

describe("getTimeGreeting", () => {
    it.each([
        [0, "late-night"],
        [5, "late-night"],
        [6, "morning"],
        [11, "morning"],
        [12, "afternoon"],
        [17, "afternoon"],
        [18, "evening"],
        [23, "evening"],
    ] as const)("hour %i → %s", (hour, expected) => {
        expect(getTimeGreeting(hour)).toBe(expected);
    });
});

describe("formatLimit", () => {
    it("shows ∞ for infinity", () => {
        expect(formatLimit(Infinity)).toBe("∞");
    });
    it("locale-formats finite numbers", () => {
        expect(formatLimit(5000)).toBe("5,000");
        expect(formatLimit(100)).toBe("100");
    });
});

describe("stable Korean date formatting", () => {
    it("formats dates with explicit locale and timezone", () => {
        expect(formatKoreanDate("2026-06-12T00:00:00.000Z")).toBe("2026. 6. 12.");
    });

    it("formats date-times with explicit locale and timezone", () => {
        expect(formatKoreanDateTime("2026-06-12T09:30:00.000Z")).toBe("2026. 6. 12. 18:30");
    });

    it("returns a fallback for invalid input", () => {
        expect(formatKoreanDate("not-a-date")).toBe("not-a-date");
        expect(formatKoreanDateTime("")).toBe("");
    });

    it("guards empty and unparseable date-time input", () => {
        // Empty/whitespace → render nothing.
        expect(formatKoreanDateTime("")).toBe("");
        expect(formatKoreanDateTime("   ")).toBe("");
        // @ts-expect-error runtime guard against undefined slipping past types.
        expect(formatKoreanDateTime(undefined)).toBe("");
        // Non-empty but unparseable → "-" fallback, never the raw string.
        expect(formatKoreanDateTime("not-a-date")).toBe("-");
        expect(formatKoreanDateTime("2026-13-99T99:99:99Z")).toBe("-");
    });
});

describe("usagePct", () => {
    it("returns 0 for infinity total", () => {
        expect(usagePct(50, Infinity)).toBe(0);
    });
    it("caps at 100", () => {
        expect(usagePct(150, 100)).toBe(100);
    });
    it("returns 0 for zero total", () => {
        expect(usagePct(5, 0)).toBe(0);
    });
    it("rounds", () => {
        expect(usagePct(1, 3)).toBe(33);
    });
});

describe("splitQuestionsIntoColumns", () => {
    it("keeps OMR print questions flowing down each paper column", async () => {
        const pure = await import("./pure") as typeof import("./pure") & {
            splitQuestionsIntoColumns?: <T>(items: readonly T[], columns: number) => T[][];
        };
        expect(typeof pure.splitQuestionsIntoColumns).toBe("function");

        const questions = Array.from({ length: 13 }, (_, i) => ({ number: i + 1 }));
        const columns = pure.splitQuestionsIntoColumns!(questions, 2);

        expect(columns.map(column => column.map(q => q.number))).toEqual([
            [1, 2, 3, 4, 5, 6, 7],
            [8, 9, 10, 11, 12, 13],
        ]);
    });
});

describe("getCardViewGridMetrics", () => {
    it("defaults card view to one vertical sequence", async () => {
        const pure = await import("./pure") as typeof import("./pure") & {
            getCardViewGridMetrics?: (totalItems: number, columns?: number) => { columns: number; rows: number };
        };
        expect(typeof pure.getCardViewGridMetrics).toBe("function");

        expect(pure.getCardViewGridMetrics!(7)).toEqual({ columns: 1, rows: 7 });
        expect(pure.getCardViewGridMetrics!(7, 2)).toEqual({ columns: 2, rows: 4 });
        expect(pure.getCardViewGridMetrics!(0, 2)).toEqual({ columns: 1, rows: 0 });
    });
});
