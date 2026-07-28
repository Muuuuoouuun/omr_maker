import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignedTeacherSessionCookie } from "./teacherServerSession";

const controls = vi.hoisted(() => ({
    headers: new Headers(),
    cookieValue: undefined as string | undefined,
    cookieReads: 0,
}));

const probe = vi.hoisted(() => vi.fn(async () => ({
    ready: true,
    version: "test-probe",
    failedChecks: [],
})));

const authorizedSummary = vi.hoisted(() => ({
    label: "authorized readiness",
    detail: "authorized detail",
    credentialCount: 1,
    readyCount: 1,
    totalCount: 1,
    checks: [],
}));

const buildReadiness = vi.hoisted(() => vi.fn(() => authorizedSummary));

vi.mock("next/headers", () => ({
    headers: async () => controls.headers,
    cookies: async () => {
        controls.cookieReads += 1;
        return {
            get: (name: string) => name === "omr_teacher_server_session" && controls.cookieValue
                ? { value: controls.cookieValue }
                : undefined,
        };
    },
}));

vi.mock("@/lib/supabaseReadinessProbe", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/supabaseReadinessProbe")>();
    return {
        ...actual,
        probeSupabaseDeploymentWithServiceRole: probe,
    };
});

vi.mock("@/lib/deploymentReadiness", () => ({
    buildDeploymentReadiness: buildReadiness,
}));

import { getTeacherDeploymentReadiness } from "@/app/actions/auth";

const TOKEN = "tkn_readiness_0123456789abcdef0123456789abcdef";
const SESSION_SECRET = "readiness-action-test-secret";
const BLOCKED_SUMMARY = {
    label: "배포 상태 확인 불가",
    detail: "인증된 교사 세션에서만 배포 상태를 확인할 수 있습니다.",
    credentialCount: 0,
    readyCount: 0,
    totalCount: 1,
    checks: [{
        key: "deployment_readiness_access",
        label: "배포 상태 접근",
        detail: "요청 권한을 확인한 뒤 다시 시도하세요.",
        tone: "error",
    }],
};

function sameOriginHeaders(client = "203.0.113.10"): Headers {
    return new Headers({
        host: "app.example.com",
        origin: "https://app.example.com",
        "x-forwarded-for": client,
    });
}

function signTeacher(
    teacherId: string,
    memberRole: "owner" | "admin" | "teacher" | "assistant" | "viewer",
): string {
    const cookie = createSignedTeacherSessionCookie(
        TOKEN,
        { teacherId, memberRole },
        { NODE_ENV: "production", TEACHER_SESSION_SECRET: SESSION_SECRET },
    );
    if (!cookie) throw new Error("test teacher session was not signed");
    return cookie;
}

describe("teacher deployment readiness server action", () => {
    beforeEach(() => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("TEACHER_SESSION_SECRET", SESSION_SECRET);
        controls.headers = sameOriginHeaders();
        controls.cookieValue = undefined;
        controls.cookieReads = 0;
        probe.mockClear();
        buildReadiness.mockClear();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("rejects a cross-origin request before reading cookies or calling the service-role probe", async () => {
        controls.headers = new Headers({
            host: "app.example.com",
            origin: "https://private-teacher-id.evil.example",
        });
        controls.cookieValue = signTeacher("teacher-cross-origin", "owner");

        const result = await getTeacherDeploymentReadiness();

        expect(result).toEqual(BLOCKED_SUMMARY);
        expect(JSON.stringify(result)).not.toContain("private-teacher-id");
        expect(controls.cookieReads).toBe(0);
        expect(probe).not.toHaveBeenCalled();
        expect(buildReadiness).not.toHaveBeenCalled();
    });

    it("rejects a missing or invalid signed session without calling the service-role probe", async () => {
        for (const cookie of [undefined, "teacher@example.com.not-a-valid-signature"]) {
            controls.cookieValue = cookie;

            await expect(getTeacherDeploymentReadiness()).resolves.toEqual(BLOCKED_SUMMARY);
        }

        expect(probe).not.toHaveBeenCalled();
        expect(buildReadiness).not.toHaveBeenCalled();
    });

    it("allows a signed read-only viewer session to inspect readiness", async () => {
        controls.cookieValue = signTeacher("viewer-readiness", "viewer");

        await expect(getTeacherDeploymentReadiness()).resolves.toEqual(authorizedSummary);

        expect(probe).toHaveBeenCalledTimes(1);
        expect(buildReadiness).toHaveBeenCalledTimes(1);
    });

    it("bounds readiness probes per signed actor and client without leaking actor data", async () => {
        controls.headers = sameOriginHeaders("198.51.100.72");
        controls.cookieValue = signTeacher("teacher-rate-limit-private", "viewer");

        for (let request = 0; request < 12; request += 1) {
            await expect(getTeacherDeploymentReadiness()).resolves.toEqual(authorizedSummary);
        }
        const blocked = await getTeacherDeploymentReadiness();

        expect(blocked).toEqual(BLOCKED_SUMMARY);
        expect(JSON.stringify(blocked)).not.toContain("teacher-rate-limit-private");
        expect(JSON.stringify(blocked)).not.toContain("198.51.100.72");
        expect(probe).toHaveBeenCalledTimes(12);
        expect(buildReadiness).toHaveBeenCalledTimes(12);
    });
});
