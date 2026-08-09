import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    ExamEntryInviteMetadata,
    ExamEntryInviteRawUrlState,
} from "./examEntryInviteLifecycle";
import { resolveInviteCapability } from "./examEntryInviteLifecycle";
import { normalizeDistributionShareResult } from "./distributionInviteRotation";

const actionControls = vi.hoisted(() => ({
    role: "teacher" as "owner" | "admin" | "teacher" | "assistant" | "viewer",
}));

const actionMocks = vi.hoisted(() => ({
    getMetadata: vi.fn(),
    revoke: vi.fn(),
    rotate: vi.fn(),
}));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ host: "omr.example", origin: "https://omr.example" }),
    cookies: async () => ({ get: () => ({ value: "signed-session" }) }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => true,
}));

vi.mock("@/lib/teacherServerSession", () => ({
    resolveAuthorizedTeacherSessionCookie: async () => ({
        teacherId: "teacher-1",
        organizationId: "org-1",
        organizationName: "교실",
        memberRole: actionControls.role,
    }),
    TEACHER_SERVER_SESSION_COOKIE: "omr_teacher_server_session",
}));

vi.mock("@/lib/workspaceContext", () => ({
    workspaceContextFromTeacherSession: (session: { memberRole: typeof actionControls.role }) => ({
        organizationId: "org-1",
        organizationName: "교실",
        actorUserId: "teacher-1",
        memberRole: session.memberRole,
    }),
}));

vi.mock("@/lib/supabaseServerAdmin", () => ({
    createSupabaseAdminClient: () => ({ rpc: vi.fn() }),
    getSupabaseServerConfigFromEnv: () => ({
        url: "https://supabase.example",
        serviceRoleKey: "service-role",
        backendTimeoutMs: 5_000,
    }),
}));

vi.mock("@/lib/reportServerError", () => ({ reportServerError: vi.fn() }));

vi.mock("@/lib/examEntryInviteGateway", () => ({
    getExamEntryInviteMetadataWithGateway: actionMocks.getMetadata,
    revokeExamEntryInviteWithGateway: actionMocks.revoke,
    rotateExamEntryInviteWithGateway: actionMocks.rotate,
}));

function source(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const metadata: ExamEntryInviteMetadata = {
    inviteId: "exam_invite_0123456789abcdef0123456789abcdef",
    examId: "exam-1",
    targetType: "groups",
    targetIds: ["group-1"],
    generation: 2,
    issuedAt: "2026-08-08T11:00:00.000Z",
    expiresAt: "2026-08-08T13:00:00.000Z",
    revokedAt: null,
};
const rawUrl: ExamEntryInviteRawUrlState = {
    url: "https://omr.example/solve/exam-1#invite=opaque",
    examId: "exam-1",
    generation: 2,
    issuedAt: "2026-08-08T11:00:00.000Z",
};

describe("distribution invite lifecycle surface", () => {
    beforeEach(() => {
        actionControls.role = "teacher";
        vi.clearAllMocks();
        actionMocks.getMetadata.mockResolvedValue({ status: "found", metadata });
        actionMocks.revoke.mockResolvedValue({
            status: "revoked",
            metadata: { ...metadata, revokedAt: "2026-08-08T12:10:00.000Z" },
        });
        actionMocks.rotate.mockResolvedValue({
            status: "issued",
            token: "a".repeat(43),
            expiresAt: metadata.expiresAt,
            metadata,
        });
    });

    it("renders honest active-without-raw and destructive reissue copy", () => {
        const modal = source("src/components/DistributeModal.tsx");

        expect(modal).toContain("활성 링크가 있습니다");
        expect(modal).toContain("이 기기에는 링크 원문이 없습니다");
        expect(modal).toContain("새 링크 발급");
        expect(modal).toContain("기존 링크와 QR은 즉시 무효화됩니다");
    });

    it("surfaces invite lifecycle state only while the group distribution mode is selected", () => {
        const modal = source("src/components/DistributeModal.tsx");

        expect(modal).toMatch(
            /accessType === "group" && inviteMetadataLoad\.status === "loading"/,
        );
        expect(modal).toMatch(
            /accessType === "group" && inviteMetadataLoad\.status === "found"/,
        );
    });

    it("preserves the atomic metadata generation while normalizing a one-time raw link", () => {
        expect(normalizeDistributionShareResult({
            shareUrl: rawUrl.url,
            examId: metadata.examId,
            expiresAt: metadata.expiresAt,
            metadata,
        })).toEqual({
            shareUrl: rawUrl.url,
            examId: metadata.examId,
            expiresAt: metadata.expiresAt,
            metadata,
        });
    });

    it("uses the pure capability resolver for every QR and copy decision", () => {
        const modal = source("src/components/DistributeModal.tsx");
        expect(modal).toContain("resolveInviteCapability");

        expect(resolveInviteCapability({ metadata, rawUrl, now: NOW })).toBe("copyable_here");
        expect(resolveInviteCapability({ metadata, rawUrl: null, now: NOW }))
            .toBe("active_but_raw_unavailable");
        expect(resolveInviteCapability({
            metadata,
            rawUrl: { ...rawUrl, generation: 1 },
            now: NOW,
        })).toBe("active_but_raw_unavailable");
        expect(resolveInviteCapability({
            metadata,
            rawUrl: { ...rawUrl, examId: "exam-2" },
            now: NOW,
        })).toBe("active_but_raw_unavailable");
        expect(resolveInviteCapability({
            metadata: { ...metadata, expiresAt: "2026-08-08T11:59:59.000Z" },
            rawUrl,
            now: NOW,
        })).toBe("expired");
        expect(resolveInviteCapability({
            metadata: { ...metadata, revokedAt: "2026-08-08T11:30:00.000Z" },
            rawUrl,
            now: NOW,
        })).toBe("revoked");
    });

    it("keeps dependency failure distinct from a missing invite and exposes an alert retry", () => {
        const modal = source("src/components/DistributeModal.tsx");
        const action = source("src/app/actions/teacherExam.ts");

        expect(action).toContain('status: "dependency_unavailable"');
        expect(action).toContain('status: "not_found"');
        expect(modal).toContain("dependency_unavailable");
        expect(modal).toContain('role="alert"');
        expect(modal).toContain("다시 시도");
    });

    it("blocks group rotation until an existing exam lifecycle read is authoritative", () => {
        const modal = source("src/components/DistributeModal.tsx");

        expect(modal).toContain("inviteLifecycleBlocksIssuance");
        expect(modal).toMatch(
            /if \(accessType === "group" && inviteLifecycleBlocksIssuance\)[\s\S]{0,320}return;/,
        );
        expect(modal).toMatch(
            /disabled=\{[^}]*inviteLifecycleBlocksIssuance/,
        );
    });

    it("discards a hidden stale raw URL when authoritative metadata says no invite exists", () => {
        const modal = source("src/components/DistributeModal.tsx");

        expect(modal).toMatch(
            /inviteMetadataLoad\.status === "not_found"[\s\S]{0,240}onInviteRawUrlStateChange\(null\)/,
        );
    });

    it("also discards the group-derived share URL before another access mode can expose it", () => {
        const modal = source("src/components/DistributeModal.tsx");

        expect(modal).toContain("isGroupInviteShareUrl");
        expect(modal).toMatch(
            /inviteCapability !== "copyable_here"[\s\S]{0,360}setShareUrl\(null\)/,
        );
    });

    it("validates an existing exam independently from rotate result and metadata ids", () => {
        const modal = source("src/components/DistributeModal.tsx");

        expect(modal).toContain("resolveInviteRotationExamId");
        expect(modal).toContain("shareResult, examId");
    });

    it("keeps the one-time raw URL in React memory and guards late metadata responses by exam", () => {
        const createPage = source("src/app/create/page.tsx");
        const modal = source("src/components/DistributeModal.tsx");

        expect(createPage).toContain("ExamEntryInviteRawUrlState");
        expect(createPage).toContain("setDistributionInviteRawUrl");
        expect(modal).toContain("inviteMetadataLoadGenerationRef");
        expect(modal).toContain("expectedExamId");
        expect(modal).toContain("metadata.examId !== expectedExamId");
        expect(`${createPage}\n${modal}`).not.toMatch(
            /(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:inviteRaw|rawUrl|shareUrl)/i,
        );
    });

    it.each(["assistant", "viewer"] as const)(
        "fails closed for %s at every teacher invite Server Action boundary",
        async role => {
            actionControls.role = role;
            const actions = await import("@/app/actions/teacherExam");

            await expect(actions.getTeacherExamEntryInviteMetadata("exam-1"))
                .resolves.toEqual({ status: "forbidden" });
            await expect(actions.revokeTeacherExamEntryInvite("exam-1"))
                .resolves.toEqual({ status: "forbidden" });
            await expect(actions.rotateTeacherExamEntryInvite("exam-1"))
                .resolves.toEqual({ status: "forbidden" });
            expect(actionMocks.getMetadata).not.toHaveBeenCalled();
            expect(actionMocks.revoke).not.toHaveBeenCalled();
            expect(actionMocks.rotate).not.toHaveBeenCalled();
        },
    );

    it("maps gateway dependency errors without claiming there is no invite", async () => {
        const actions = await import("@/app/actions/teacherExam");
        actionMocks.getMetadata.mockResolvedValue({ status: "service_unavailable" });

        await expect(actions.getTeacherExamEntryInviteMetadata("exam-1"))
            .resolves.toEqual({ status: "dependency_unavailable" });
    });

    it("installs page and console error capture before the first E2E navigation", () => {
        const e2e = source("e2e/exam-invite-lifecycle.spec.ts");
        const reset = e2e.indexOf("await resetBrowserState(page, context)");

        expect(e2e.indexOf('page.on("pageerror"')).toBeGreaterThan(-1);
        expect(e2e.indexOf('page.on("pageerror"')).toBeLessThan(reset);
        expect(e2e.indexOf('message.type() === "error"')).toBeGreaterThan(-1);
        expect(e2e.indexOf('message.type() === "error"')).toBeLessThan(reset);
        expect(e2e).toContain("expect(browserErrors).toEqual([])");
    });
});
