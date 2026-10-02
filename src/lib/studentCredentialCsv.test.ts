import { beforeAll, describe, expect, it } from "vitest";

type Row = {
    studentId: string;
    name: string;
    group: string;
    startCode: string;
};

type CsvModule = {
    serializeStudentCredentialCsv(rows: readonly Row[]): string;
};

let csvModule: CsvModule | null = null;

beforeAll(async () => {
    const modulePath = "./studentCredentialCsv";
    csvModule = await import(/* @vite-ignore */ modulePath).catch(() => null) as CsvModule | null;
});

function serialize(rows: readonly Row[]): string {
    expect(csvModule, "student credential CSV module must exist").not.toBeNull();
    return csvModule!.serializeStudentCredentialCsv(rows);
}

function row(index: number, overrides: Partial<Row> = {}): Row {
    return {
        studentId: `student-${String(index).padStart(3, "0")}`,
        name: `학생 ${index}`,
        group: `반 ${index % 4}`,
        startCode: "AB2CD3",
        ...overrides,
    };
}

describe("one-time student credential CSV", () => {
    it("emits a BOM, exact header, stable 100-row order, CRLF rows, and terminal CRLF", () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index + 1));
        const csv = serialize(rows);

        expect(csv.charCodeAt(0)).toBe(0xfeff);
        expect(csv.startsWith("\uFEFFstudent_id,name,group,start_code\r\n")).toBe(true);
        expect(csv.split("\r\n")).toHaveLength(102);
        expect(csv.endsWith("\r\n")).toBe(true);
        expect(csv.indexOf("student-001")).toBeLessThan(csv.indexOf("student-100"));
        expect(csv).not.toMatch(/(^|[^\r])\n/);
    });

    it("quotes commas and quotes, canonicalizes embedded line endings to CRLF, and preserves row order", () => {
        const csv = serialize([
            row(2, { name: "김,학생", group: "A\"반" }),
            row(1, { name: "두\n줄\r끝", group: "B\r\n반", startCode: "EF4GH5" }),
        ]);

        expect(csv).toContain('student-002,"김,학생","A""반",AB2CD3\r\n');
        expect(csv).toContain('student-001,"두\r\n줄\r\n끝","B\r\n반",EF4GH5\r\n');
        expect(csv).not.toMatch(/(^|[^\r])\n/u);
        expect(csv).not.toMatch(/\r(?!\n)/u);
        expect(csv.indexOf("student-002")).toBeLessThan(csv.indexOf("student-001"));
    });

    it("preserves a canonical Korean roster ID and neutralizes a formula-leading ID", () => {
        const csv = serialize([
            row(1, { studentId: "e2e-class-a::김학생" }),
            row(2, { studentId: "=unsafe-student" }),
        ]);

        expect(csv).toContain("e2e-class-a::김학생,학생 1,반 1,AB2CD3\r\n");
        expect(csv).toContain("'=unsafe-student,학생 2,반 2,AB2CD3\r\n");
    });

    it.each([
        "=1+1",
        "+cmd",
        "-2+3",
        "@SUM(A1:A2)",
        "\t=1+1",
        "\r@cmd",
        "  -1+1",
        "\uFEFF\t+cmd",
        "\u0001 @cmd",
        "\tplain-control",
        "\rplain-control",
        " \u0002plain-control",
        "\u0085=cmd",
    ])("neutralizes spreadsheet formulas hidden behind prefixes: %j", dangerous => {
        const csv = serialize([row(1, { name: dangerous, group: dangerous })]);
        const dataLine = csv.split("\r\n")[2 - 1];

        expect(dataLine).not.toContain(`,${dangerous},`);
        expect(dataLine).toContain("'");
    });

    it.each([
        { rows: [] as Row[] },
        { rows: Array.from({ length: 101 }, (_, index) => row(index + 1)) },
        { rows: [row(1), row(2, { studentId: "student-001" })] },
        { rows: [row(1, { studentId: "" })] },
        { rows: [row(1, { name: "   " })] },
        { rows: [row(1, { group: "" })] },
        { rows: [row(1, { startCode: "ABC123" })] },
        { rows: [row(1, { name: "bad\0name" })] },
        { rows: [row(1, { studentId: "x".repeat(257) })] },
        { rows: [row(1, { studentId: "학생\u0085id" })] },
        { rows: [row(1, { studentId: "학생\u009Fid" })] },
        { rows: [row(1, { studentId: "학생\u2028id" })] },
        { rows: [row(1, { studentId: "학생\uFEFFid" })] },
        { rows: [row(1, { studentId: "\u00a0학생" })] },
        { rows: [row(1, { studentId: "학생\u00a0" })] },
        { rows: [row(1, { studentId: "\u1680학생" })] },
        { rows: [row(1, { studentId: "학생\u2000" })] },
        { rows: [row(1, { studentId: "\u200a학생" })] },
        { rows: [row(1, { studentId: "학생\u202f" })] },
        { rows: [row(1, { studentId: "\u205f학생" })] },
        { rows: [row(1, { studentId: "학생\u3000" })] },
    ])("rejects incomplete, duplicate, malformed, or out-of-bound rows", ({ rows }) => {
        expect(() => serialize(rows)).toThrow();
    });

    it("rejects a CSV whose encoded bytes exceed the bounded one-time download size", () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index + 1, {
            name: "가".repeat(85),
            group: "나".repeat(85),
        }));

        expect(() => serialize(rows)).toThrow(/size|크기/i);
    });
});
