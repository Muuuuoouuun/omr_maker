import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("teacher identity cutover contract", () => {
    it("keeps environment resolution in a compiler-enforced server-only module", () => {
        const serverPath = resolve(process.cwd(), "src/lib/teacherIdentityMode.server.ts");
        expect(existsSync(serverPath)).toBe(true);
        if (!existsSync(serverPath)) return;

        const serverMode = readFileSync(serverPath, "utf8");
        const sharedMode = source("src/lib/teacherIdentityMode.ts");
        const provider = source("src/components/TeacherIdentityModeProvider.tsx");
        const layout = source("src/app/layout.tsx");
        const action = source("src/app/actions/teacherAccount.ts");

        expect(serverMode).toContain('import "next/dist/compiled/server-only"');
        expect(serverMode).toContain("process.env");
        expect(sharedMode).not.toMatch(/process\.env|OMR_TEACHER_IDENTITY_MODE|resolveTeacherIdentityMode/);
        expect(provider).toContain('import type { TeacherIdentityMode } from "@/lib/teacherIdentityMode";');
        expect(provider).not.toContain("teacherIdentityMode.server");
        expect(layout).toContain('from "@/lib/teacherIdentityMode.server"');
        expect(action).toContain('from "@/lib/teacherIdentityMode.server"');
    });

    it("documents the immediate invalidation and operator recovery cutover policy", () => {
        const readiness = source("docs/production-readiness.md");

        expect(readiness).toContain("`provisioned_only` 전환 즉시");
        expect(readiness).toContain("대기 중인 이메일 확인 및 비밀번호 재설정 완료 작업은 무효화");
        expect(readiness).toContain("전환 전에 대기 계정을 통지하고 정합성을 확인");
        expect(readiness).toContain("운영자 계정 발급 또는 비밀번호 재발급");
        expect(readiness).not.toContain("provisioned_only 전환 후 이메일이 발송");
    });
});
