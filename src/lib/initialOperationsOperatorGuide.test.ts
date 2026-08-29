import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const guidePath = resolve("docs/operations/initial-operations-qualification.md");
const evidencePath = resolve("docs/operations/release-evidence-template.md");
const runbookPath = resolve("docs/initial-operations-runbook.md");
const auditPath = resolve("docs/initial-ops-user-journey-audit-2026-08-07.md");

function read(path: string) {
    return readFileSync(path, "utf8");
}

describe("initial operations operator qualification documentation", () => {
    it("defines the exact protected qualification, promotion, rollback, and disposal sequence", () => {
        const guide = read(guidePath);

        for (const required of [
            "initial-operations-staging",
            "immutable preview",
            "80 students + 10 teacher live pollers + 10 teacher uploaders",
            "external alert",
            "repository-owned streaming restore",
            "release-quality-score.json",
            "production-readiness",
            "rollback",
            "disposal",
        ]) {
            expect(guide).toContain(required);
        }
        expect(guide).toContain("UNVERIFIED/NO-GO");
        expect(guide).toContain("npm run test:ops:initial -- --run");
        expect(guide).toContain('{"status":"unverified","code":"invalid_staging_config"}');
    });

    it("keeps unavailable external evidence unverified across every operator-facing record", () => {
        const documents = [read(guidePath), read(evidencePath), read(runbookPath), read(auditPath)];

        for (const document of documents) {
            expect(document).toMatch(/UNVERIFIED/i);
            expect(document).toMatch(/NO-GO/i);
        }
        expect(documents[0]).toMatch(/local|로컬/);
        expect(documents[0]).toContain("substitute");
        expect(documents[1]).toContain("initial-operations-qualification-<SHA>");
        expect(documents[1]).toContain("80+10+10");
        expect(documents[2]).toContain("operations/initial-operations-qualification.md");
        expect(documents[3]).toContain("강한 로컬 릴리스 후보");
    });

    it("names every protected input class that must be supplied externally", () => {
        const guide = read(guidePath);
        for (const required of [
            "immutable staging deployment",
            "staging Supabase credentials",
            "disposable restore credentials",
            "external alert adapter credentials",
            "Vercel promotion credentials",
            "physical Android/iOS evidence",
            "operator approvals",
        ]) {
            expect(guide).toContain(required);
        }
    });

    it("blocks qualification completion and promotion without fresh exact-SHA Android and iOS evidence", () => {
        const guide = read(guidePath);

        expect(guide).toContain("Android와 iOS 모두의 exact-SHA 물리 기기 증거");
        expect(guide).toContain("24시간 freshness");
        expect(guide).toMatch(/wrong-SHA이면 `QUALIFICATION_COMPLETE`를 게시하지 않습니다/);
        expect(guide).toContain("물리 기기 artifact digest와 exact SHA를 다시 검증");
    });

    it("documents the exact trusted physical-device attestor schema and dispatch inputs", () => {
        const guide = read(guidePath);
        const packageJson = JSON.parse(read(resolve("package.json")));

        expect(packageJson.scripts["ops:device:attest"]).toBe("node scripts/attest-physical-device-evidence.mjs");
        expect(guide).toContain("npm run ops:device:attest -- --input=/absolute/private/physical-device-input.json --output=/absolute/private/physical-device-evidence.json");
        expect(guide).toContain("omr.physical-device-evidence:v1\\0");
        expect(guide).toContain("physical_device_evidence_b64");
        expect(guide).toContain("physical_device_evidence_sha256");
        expect(guide).toContain("shell history");
        expect(guide).toContain("`set -x`");
        expect(guide).toContain("다른 credential과 재사용하지");
        expect(guide).toContain("즉시 rotate");
        for (const field of [
            "schemaVersion", "status", "buildSha", "previewArtifactDigest", "generatedAt",
            "android", "ios", "platform", "checkedAt", "installed", "takeover",
            "handwriting", "submission", "feedback", "reportSha256", "integrity", "attestation",
        ]) {
            expect(guide).toContain(field);
        }
    });

    it("uses the enforced 24-hour freshness for external alert qualification evidence", () => {
        const evidence = read(evidencePath);
        const alertSection = evidence.slice(
            evidence.indexOf("## 외부 합성 경보 전달 훈련"),
            evidence.indexOf("## ", evidence.indexOf("## 외부 합성 경보 전달 훈련") + 3),
        );

        expect(alertSection).toContain("24시간 이내");
        expect(alertSection).not.toContain("30일 이내");
    });
});
