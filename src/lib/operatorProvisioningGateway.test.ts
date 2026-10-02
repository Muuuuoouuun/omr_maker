import { describe, expect, it, vi } from "vitest";
import {
    provisionPilotTeacher,
    provisionPilotTeacherWithEncodedVerifier,
    type OperatorProvisioningGatewayClient,
} from "./operatorProvisioningGateway.server";

const PASSWORD = "Correct-Horse-2026!";
const VERIFIER = `pbkdf2-sha256:120000:${"a".repeat(32)}:${"b".repeat(64)}`;
const INPUT = {
    organizationName: "서울 파일럿",
    email: "Teacher@Example.com",
    displayName: "김교사",
    initialPassword: PASSWORD,
    plan: "pro" as const,
    expiresAt: "2026-09-08T00:00:00.000Z",
    actor: "operator:launch",
    reason: "initial_pilot",
    idempotencyKey: `prov_${"A".repeat(32)}`,
};

const RPC_ROW = {
    organizationId: `pilot_org_${"a".repeat(24)}`,
    accountId: `teacher_${"b".repeat(16)}`,
    grantId: `pilot_grant_${"c".repeat(24)}`,
    plan: "pro",
    expiresAt: "2026-09-08T00:00:00.000000Z",
    replayed: false,
};

function client(result: { data: unknown; error: { message?: string } | null } = { data: RPC_ROW, error: null }) {
    return {
        rpc: vi.fn(async (functionName: string, args: Record<string, unknown>) => {
            void functionName;
            void args;
            return result;
        }),
    } satisfies OperatorProvisioningGatewayClient;
}

describe("operator provisioning server gateway", () => {
    it.each(["\u0000", "\u0001", "\u007f"])(
        "rejects email control character %j before password hashing or RPC",
        async (controlCharacter) => {
            const current = client();
            const hashPassword = vi.fn(async () => VERIFIER);
            const result = await provisionPilotTeacher(
                { ...INPUT, email: `a${controlCharacter}@b.co` },
                current,
                new Date("2026-08-08T00:00:00.000Z"),
                { hashPassword },
            );
            expect(result).toEqual({ status: "rejected", error: "invalid_input" });
            expect(hashPassword).not.toHaveBeenCalled();
            expect(current.rpc).not.toHaveBeenCalled();
        },
    );

    it("normalizes bounded input, hashes asynchronously, and sends only the encoded verifier", async () => {
        const current = client();

        const result = await provisionPilotTeacher(INPUT, current, new Date("2026-08-08T00:00:00.000Z"));

        expect(result).toEqual({ status: "provisioned", ...RPC_ROW });
        expect(current.rpc).toHaveBeenCalledWith("omr_provision_pilot_teacher_v1", {
            p_organization_name: "서울 파일럿",
            p_email: "teacher@example.com",
            p_display_name: "김교사",
            p_password_hash: expect.stringMatching(/^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$/),
            p_plan: "pro",
            p_expires_at: "2026-09-08T00:00:00.000Z",
            p_actor: "operator:launch",
            p_reason: "initial_pilot",
            p_idempotency_key: `prov_${"A".repeat(32)}`,
        });
        const rpcArgs = current.rpc.mock.calls[0]?.[1];
        expect(JSON.stringify(rpcArgs)).not.toContain(PASSWORD);
        expect(JSON.stringify(result)).not.toContain("pbkdf2-sha256");
    });

    it("reuses an exact precomputed verifier and idempotency key for uncertain retries", async () => {
        const uncertain = client({ data: null, error: { message: "statement timeout secret verifier" } });
        const retry = client({ data: { ...RPC_ROW, replayed: true }, error: null });
        const input = {
            ...INPUT,
            initialPassword: undefined,
            encodedVerifier: VERIFIER,
        };

        expect(await provisionPilotTeacherWithEncodedVerifier(input, uncertain, new Date("2026-08-08T00:00:00.000Z")))
            .toEqual({ status: "unavailable", error: "dependency_unavailable" });
        expect(await provisionPilotTeacherWithEncodedVerifier(input, retry, new Date("2026-08-08T00:00:00.000Z")))
            .toMatchObject({ status: "provisioned", replayed: true });
        expect(uncertain.rpc.mock.calls[0]?.[1]).toEqual(retry.rpc.mock.calls[0]?.[1]);
        expect(uncertain.rpc.mock.calls[0]?.[1]?.p_password_hash).toBe(VERIFIER);
    });

    it.each([
        [{ ...INPUT, organizationName: "" }, "invalid_input"],
        [{ ...INPUT, organizationName: "a".repeat(121) }, "invalid_input"],
        [{ ...INPUT, email: "not-an-email" }, "invalid_input"],
        [{ ...INPUT, displayName: "\u0000" }, "invalid_input"],
        [{ ...INPUT, plan: "enterprise" }, "invalid_input"],
        [{ ...INPUT, expiresAt: "soon" }, "invalid_input"],
        [{ ...INPUT, expiresAt: "2026-08-07T23:59:59.999Z" }, "invalid_input"],
        [{ ...INPUT, expiresAt: "2027-08-10T00:00:00.000Z" }, "invalid_input"],
        [{ ...INPUT, actor: "admin" }, "invalid_input"],
        [{ ...INPUT, reason: "Bad reason" }, "invalid_input"],
        [{ ...INPUT, idempotencyKey: "prov_short" }, "invalid_input"],
        [{ ...INPUT, initialPassword: "short" }, "invalid_input"],
    ])("rejects invalid input before resolving the RPC %#", async (input, error) => {
        const current = client();
        await expect(provisionPilotTeacher(input as typeof INPUT, current, new Date("2026-08-08T00:00:00.000Z")))
            .resolves.toEqual({ status: "rejected", error });
        expect(current.rpc).not.toHaveBeenCalled();
    });

    it.each([
        ["invalid_provisioning_request", { status: "rejected", error: "invalid_input" }],
        ["idempotency_conflict", { status: "rejected", error: "conflict" }],
        ["provisioning_conflict", { status: "rejected", error: "conflict" }],
        ["capacity_exceeded", { status: "rejected", error: "capacity_exceeded" }],
        ["provisioning_serialization_failure", { status: "unavailable", error: "dependency_unavailable" }],
        ["secret database error teacher@example.com pbkdf2-sha256", { status: "unavailable", error: "dependency_unavailable" }],
    ])("maps the exact database error %s without returning raw detail", async (message, expected) => {
        const result = await provisionPilotTeacherWithEncodedVerifier(
            { ...INPUT, initialPassword: undefined, encodedVerifier: VERIFIER },
            client({ data: null, error: { message } }),
            new Date("2026-08-08T00:00:00.000Z"),
        );
        expect(result).toEqual(expected);
        if (message.includes("secret")) expect(JSON.stringify(result)).not.toContain(message);
        expect(JSON.stringify(result)).not.toContain("teacher@example.com");
        expect(JSON.stringify(result)).not.toContain("pbkdf2-sha256");
    });

    it("fails unavailable on thrown dependencies and malformed success envelopes", async () => {
        const throwing = { rpc: vi.fn(async () => { throw new Error(`${PASSWORD} ${VERIFIER}`); }) };
        const malformed = client({ data: { ...RPC_ROW, accountId: "../../secret" }, error: null });
        const mismatched = client({ data: { ...RPC_ROW, plan: "academy" }, error: null });

        await expect(provisionPilotTeacherWithEncodedVerifier(
            { ...INPUT, initialPassword: undefined, encodedVerifier: VERIFIER },
            throwing,
            new Date("2026-08-08T00:00:00.000Z"),
        )).resolves.toEqual({ status: "unavailable", error: "dependency_unavailable" });
        await expect(provisionPilotTeacherWithEncodedVerifier(
            { ...INPUT, initialPassword: undefined, encodedVerifier: VERIFIER },
            malformed,
            new Date("2026-08-08T00:00:00.000Z"),
        )).resolves.toEqual({ status: "unavailable", error: "dependency_unavailable" });
        await expect(provisionPilotTeacherWithEncodedVerifier(
            { ...INPUT, initialPassword: undefined, encodedVerifier: VERIFIER },
            mismatched,
            new Date("2026-08-08T00:00:00.000Z"),
        )).resolves.toEqual({ status: "unavailable", error: "dependency_unavailable" });
    });

    it.each([
        ["one-row array", [RPC_ROW]],
        ["multiple-row array", [RPC_ROW, RPC_ROW]],
        ["extra key", { ...RPC_ROW, secret: `${PASSWORD} ${VERIFIER}` }],
        ["missing key", {
            organizationId: RPC_ROW.organizationId,
            accountId: RPC_ROW.accountId,
            grantId: RPC_ROW.grantId,
            plan: RPC_ROW.plan,
            replayed: RPC_ROW.replayed,
        }],
        ["null", null],
        ["nonplain", Object.assign(new Date(), RPC_ROW)],
    ])("rejects a %s success envelope without leaking it", async (_label, data) => {
        const result = await provisionPilotTeacherWithEncodedVerifier(
            { ...INPUT, initialPassword: undefined, encodedVerifier: VERIFIER },
            client({ data, error: null }),
            new Date("2026-08-08T00:00:00.000Z"),
        );
        expect(result).toEqual({ status: "unavailable", error: "dependency_unavailable" });
        expect(JSON.stringify(result)).not.toContain(PASSWORD);
        expect(JSON.stringify(result)).not.toContain(VERIFIER);
    });

    it("rejects accessor envelopes without invoking getters or toJSON", async () => {
        const getter = vi.fn(() => RPC_ROW.accountId);
        const toJSON = vi.fn(() => ({ secret: PASSWORD }));
        const data = {
            organizationId: RPC_ROW.organizationId,
            get accountId() { return getter(); },
            grantId: RPC_ROW.grantId,
            plan: RPC_ROW.plan,
            expiresAt: RPC_ROW.expiresAt,
            replayed: RPC_ROW.replayed,
        };
        Object.defineProperty(data, "toJSON", { value: toJSON, enumerable: false });

        const result = await provisionPilotTeacherWithEncodedVerifier(
            { ...INPUT, initialPassword: undefined, encodedVerifier: VERIFIER },
            client({ data, error: null }),
            new Date("2026-08-08T00:00:00.000Z"),
        );

        expect(result).toEqual({ status: "unavailable", error: "dependency_unavailable" });
        expect(getter).not.toHaveBeenCalled();
        expect(toJSON).not.toHaveBeenCalled();
    });
});
