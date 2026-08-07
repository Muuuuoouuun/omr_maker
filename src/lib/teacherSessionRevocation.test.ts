import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TeacherAccountGatewayClient } from "./teacherAccountGateway";
import * as teacherServerSession from "./teacherServerSession";

const TOKEN = "tkn_abc123_0123456789abcdef0123456789abcdef";
const ENV = {
    NODE_ENV: "production",
    TEACHER_SESSION_SECRET: "teacher-session-revocation-secret-at-least-32-bytes",
};

type SessionResolver = (
    rawCookie: string | null | undefined,
    options?: {
        env?: Record<string, string | undefined>;
        now?: number;
        accountClient?: TeacherAccountGatewayClient | null;
    },
) => Promise<ReturnType<typeof teacherServerSession.parseSignedTeacherSessionCookie>>;

function clientWith(data: unknown, error: { message?: string } | null = null) {
    return {
        rpc: vi.fn(async () => ({ data, error })),
    } satisfies TeacherAccountGatewayClient & { rpc: ReturnType<typeof vi.fn> };
}

describe("teacher account session revocation", () => {
    it("rejects an otherwise valid signed cookie when its account generation is stale", async () => {
        const resolveAuthorizedTeacherSessionCookie = (
            teacherServerSession as typeof teacherServerSession & {
                resolveAuthorizedTeacherSessionCookie?: SessionResolver;
            }
        ).resolveAuthorizedTeacherSessionCookie;
        expect(resolveAuthorizedTeacherSessionCookie).toBeTypeOf("function");
        if (!resolveAuthorizedTeacherSessionCookie) return;

        const cookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
            email: "teacher@example.com",
            displayName: "김선생",
            accountSessionGeneration: 7,
        }, ENV, 1_000);
        const client = clientWith(false);

        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: ENV,
            now: 1_000,
            accountClient: client,
        })).resolves.toBeNull();
        expect(client.rpc).toHaveBeenCalledWith("omr_validate_teacher_session_v1", {
            p_account_id: "teacher_0123456789abcdef",
            p_session_generation: 7,
        });
    });

    it("accepts only an active account at the exact generation and fails closed on gateway outage", async () => {
        const resolveAuthorizedTeacherSessionCookie = (
            teacherServerSession as typeof teacherServerSession & {
                resolveAuthorizedTeacherSessionCookie?: SessionResolver;
            }
        ).resolveAuthorizedTeacherSessionCookie;
        expect(resolveAuthorizedTeacherSessionCookie).toBeTypeOf("function");
        if (!resolveAuthorizedTeacherSessionCookie) return;

        const cookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
            accountSessionGeneration: 3,
        }, ENV, 1_000);
        const activeClient = clientWith(true);
        const outageClient = clientWith(null, { message: "database unavailable" });

        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: ENV,
            now: 1_000,
            accountClient: activeClient,
        })).resolves.toMatchObject({
            teacherId: "teacher_0123456789abcdef",
            accountSessionGeneration: 3,
            sessionAuthority: "account",
        });
        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: ENV,
            now: 1_000,
            accountClient: outageClient,
        })).resolves.toBeNull();
        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: ENV,
            now: 1_000,
            accountClient: null,
        })).resolves.toBeNull();
    });

    it("keeps explicitly bootstrap and demo sessions independent of the account RPC", async () => {
        const resolveAuthorizedTeacherSessionCookie = (
            teacherServerSession as typeof teacherServerSession & {
                resolveAuthorizedTeacherSessionCookie?: SessionResolver;
            }
        ).resolveAuthorizedTeacherSessionCookie;
        expect(resolveAuthorizedTeacherSessionCookie).toBeTypeOf("function");
        if (!resolveAuthorizedTeacherSessionCookie) return;

        const cookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "deployment-fixture",
            email: "fixture@example.com",
            displayName: "Fixture",
        }, ENV, 1_000);
        const client = clientWith(false);

        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: ENV,
            now: 1_000,
            accountClient: client,
        })).resolves.toMatchObject({
            teacherId: "deployment-fixture",
            sessionAuthority: "bootstrap",
        });
        expect(client.rpc).not.toHaveBeenCalled();
    });

    it("rejects pre-generation legacy cookies instead of preserving a 12-hour bypass", async () => {
        const resolveAuthorizedTeacherSessionCookie = (
            teacherServerSession as typeof teacherServerSession & {
                resolveAuthorizedTeacherSessionCookie?: SessionResolver;
            }
        ).resolveAuthorizedTeacherSessionCookie;
        expect(resolveAuthorizedTeacherSessionCookie).toBeTypeOf("function");
        if (!resolveAuthorizedTeacherSessionCookie) return;

        const currentCookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
        }, ENV, 1_000)!;
        const [encodedPayload] = currentCookie.split(".");
        const legacyPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
        delete legacyPayload.sessionAuthority;
        delete legacyPayload.accountSessionGeneration;
        const legacyEncodedPayload = Buffer.from(JSON.stringify(legacyPayload), "utf8").toString("base64url");
        const legacySignature = createHmac("sha256", ENV.TEACHER_SESSION_SECRET)
            .update(legacyEncodedPayload, "utf8")
            .digest("base64url");

        await expect(resolveAuthorizedTeacherSessionCookie(
            `${legacyEncodedPayload}.${legacySignature}`,
            { env: ENV, now: 1_000, accountClient: clientWith(true) },
        )).resolves.toBeNull();
    });
});
