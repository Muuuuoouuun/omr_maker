import { describe, expect, it } from "vitest";
import {
    DESKTOP_AUDIT_WAIVER_EXPIRES_AT,
    evaluateDesktopDependencyAudit,
} from "../../scripts/desktop-dependency-audit-policy.mjs";

const waiverAdvisory = {
    source: 1124334,
    name: "brace-expansion",
    dependency: "brace-expansion",
    title: "brace-expansion OOM",
    url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
    severity: "high",
    range: "<=5.0.7",
};

function auditPayload(vulnerabilities: Record<string, unknown>) {
    return {
        auditReportVersion: 2,
        vulnerabilities,
        metadata: {
            vulnerabilities: {
                info: 0,
                low: 0,
                moderate: 0,
                high: Object.keys(vulnerabilities).length,
                critical: 0,
                total: Object.keys(vulnerabilities).length,
            },
        },
    };
}

describe("desktop dependency audit policy", () => {
    it("accepts only the exact temporary brace-expansion advisory and its transitive effects", () => {
        const result = evaluateDesktopDependencyAudit(
            auditPayload({
                "brace-expansion": {
                    name: "brace-expansion",
                    severity: "high",
                    via: [waiverAdvisory],
                    nodes: ["node_modules/minimatch/node_modules/brace-expansion"],
                },
                minimatch: {
                    name: "minimatch",
                    severity: "high",
                    via: ["brace-expansion"],
                    nodes: ["node_modules/minimatch"],
                },
                "app-builder-lib": {
                    name: "app-builder-lib",
                    severity: "high",
                    via: ["dmg-builder", "minimatch"],
                    nodes: ["node_modules/app-builder-lib"],
                },
                "dmg-builder": {
                    name: "dmg-builder",
                    severity: "high",
                    via: ["app-builder-lib"],
                    nodes: ["node_modules/dmg-builder"],
                },
            }),
            new Date("2026-08-31T23:59:59.000Z"),
        );

        expect(result.ok).toBe(true);
        expect(result.waiverUsed).toBe(true);
        expect(result.waivedNodes).toEqual([
            "node_modules/minimatch/node_modules/brace-expansion",
        ]);
    });

    it("rejects an additional high-severity advisory", () => {
        const result = evaluateDesktopDependencyAudit(
            auditPayload({
                "brace-expansion": {
                    name: "brace-expansion",
                    severity: "high",
                    via: [waiverAdvisory],
                    nodes: [],
                },
                "other-package": {
                    name: "other-package",
                    severity: "high",
                    via: [{
                        ...waiverAdvisory,
                        name: "other-package",
                        dependency: "other-package",
                    }],
                    nodes: [],
                },
            }),
            new Date("2026-08-01T00:00:00.000Z"),
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("other-package");
    });

    it("rejects critical severity even for the waived advisory", () => {
        const result = evaluateDesktopDependencyAudit(
            auditPayload({
                "brace-expansion": {
                    name: "brace-expansion",
                    severity: "critical",
                    via: [{ ...waiverAdvisory, severity: "critical" }],
                    nodes: [],
                },
            }),
            new Date("2026-08-01T00:00:00.000Z"),
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("critical");
    });

    it("rejects the waiver at its exact expiry", () => {
        const result = evaluateDesktopDependencyAudit(
            auditPayload({
                "brace-expansion": {
                    name: "brace-expansion",
                    severity: "high",
                    via: [waiverAdvisory],
                    nodes: [],
                },
            }),
            new Date(DESKTOP_AUDIT_WAIVER_EXPIRES_AT),
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("expired");
    });

    it.each([
        ["wrong advisory", "brace-expansion", { ...waiverAdvisory, url: "https://github.com/advisories/GHSA-wrong" }],
        ["wrong package", "other-package", waiverAdvisory],
    ])("rejects %s identity", (_label, packageName, advisory) => {
        const result = evaluateDesktopDependencyAudit(
            auditPayload({
                [packageName]: {
                    name: packageName,
                    severity: "high",
                    via: [advisory],
                    nodes: [],
                },
            }),
            new Date("2026-08-01T00:00:00.000Z"),
        );

        expect(result.ok).toBe(false);
    });

    it("rejects a malformed audit payload", () => {
        const result = evaluateDesktopDependencyAudit(
            { vulnerabilities: [] },
            new Date("2026-08-01T00:00:00.000Z"),
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("Malformed npm audit JSON");
    });
});
