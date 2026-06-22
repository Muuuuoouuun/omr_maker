import { describe, expect, it } from "vitest";
import { parseCsvRows, serializeCsvRows } from "./csv";

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
