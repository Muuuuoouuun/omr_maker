import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("durable exam PIN integration", () => {
    it.each([
        "src/app/actions/studentExam.ts",
        "src/lib/studentExamServerGateway.ts",
    ])("reserves the global budget before verification and refunds only a correct attempt in %s", path => {
        const text = source(path);
        const start = text.indexOf('namespace: "exam-pin-global"');
        const end = text.indexOf("return access", start) >= 0
            ? text.indexOf("return access", start)
            : text.indexOf("const decision = evaluateExamAccess", start);
        const gate = text.slice(start, end);

        expect(gate).toContain('operation: "consume"');
        expect(gate.match(/operation: "refund"/g)).toHaveLength(2);
        expect(gate).not.toContain('operation: "check"');
        expect(gate).not.toContain('operation: "failure"');
        expect(gate.indexOf('operation: "consume"')).toBeLessThan(gate.indexOf("verifyExamPin"));
        expect(gate.lastIndexOf('operation: "refund"')).toBeGreaterThan(gate.indexOf("verifyExamPin"));
    });
});
