import { describe, expect, it } from "vitest";
import { decodeCsvBytes, formatCsvCell, parseCsvRows, serializeCsvRows } from "./csv";

describe("decodeCsvBytes", () => {
    it("decodes UTF-8 bytes directly", () => {
        const bytes = new TextEncoder().encode("이름,반\n김민준,3학년 A반");
        expect(decodeCsvBytes(bytes)).toBe("이름,반\n김민준,3학년 A반");
    });

    it("falls back to EUC-KR/CP949 when the bytes are not valid UTF-8", () => {
        // "가" is 0xB0 0xA1 in EUC-KR — an invalid UTF-8 lead byte, so a strict
        // UTF-8 decode fails and we must fall back to EUC-KR instead of mojibake.
        expect(decodeCsvBytes(new Uint8Array([0xb0, 0xa1]))).toBe("가");
    });

    it("accepts an ArrayBuffer as well as a Uint8Array", () => {
        const bytes = new TextEncoder().encode("name\nvalue");
        expect(decodeCsvBytes(bytes.buffer)).toBe("name\nvalue");
    });
});

describe("parseCsvRows", () => {
    it("parses basic CSV rows", () => {
        expect(parseCsvRows("name,email,group\n김민준,kim@example.com,A반")).toEqual([
            ["name", "email", "group"],
            ["김민준", "kim@example.com", "A반"],
        ]);
    });

    it("keeps commas and escaped quotes inside quoted cells", () => {
        expect(parseCsvRows('name,email,group\n"김, 민준","kim@example.com","A ""심화""반"')).toEqual([
            ["name", "email", "group"],
            ["김, 민준", "kim@example.com", 'A "심화"반'],
        ]);
    });

    it("trims BOM and supports CRLF files exported from spreadsheets", () => {
        expect(parseCsvRows("\uFEFFname,email,group\r\n이서연,lee@example.com,B반\r\n")).toEqual([
            ["name", "email", "group"],
            ["이서연", "lee@example.com", "B반"],
        ]);
    });

    it("neutralizes spreadsheet formula injection from student-typed names", () => {
        // Excel/Sheets evaluate cells starting with = + - @ (or a control char) as
        // formulas, even when quoted. Prefix a single quote and force-quote them.
        expect(formatCsvCell('=HYPERLINK("http://evil.example","click")'))
            .toBe('"\'=HYPERLINK(""http://evil.example"",""click"")"');
        expect(formatCsvCell("+1")).toBe('"\'+1"');
        expect(formatCsvCell("-1")).toBe('"\'-1"');
        expect(formatCsvCell("@cmd")).toBe('"\'@cmd"');
        expect(formatCsvCell("\tstart")).toBe('"\'\tstart"');
    });

    it("leaves ordinary values untouched", () => {
        expect(formatCsvCell("김민준")).toBe("김민준");
        expect(formatCsvCell(42)).toBe("42");
        expect(formatCsvCell("a-b")).toBe("a-b");
        expect(formatCsvCell("")).toBe("");
    });

    it("serializes rows with commas, quotes, and line breaks safely", () => {
        const csv = serializeCsvRows([
            ["문항", "라벨", "메모"],
            [1, '문학, "현대시"', "첫 줄\n둘째 줄"],
        ]);

        expect(parseCsvRows(csv)).toEqual([
            ["문항", "라벨", "메모"],
            ["1", '문학, "현대시"', "첫 줄\n둘째 줄"],
        ]);
    });
});
