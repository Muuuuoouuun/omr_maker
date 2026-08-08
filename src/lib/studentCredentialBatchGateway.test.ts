import { describe, expect, it, vi } from "vitest";
import {
    issueStudentCredentialBatch,
    validateCredentialBatch,
    type StudentCredentialBatchGatewayClient,
} from "./studentCredentialBatchGateway.server";

const IDENTITY = {
    sessionAuthority: "account" as const,
    accountId: `teacher_${"a".repeat(16)}`,
    accountSessionGeneration: 7,
    organizationId: `pilot_org_${"b".repeat(24)}`,
    actorUserId: `teacher_${"a".repeat(16)}`,
};
const IDEMPOTENCY_KEY = `batch_${"C".repeat(32)}`;
const VERIFIER = `pbkdf2-sha256:120000:${"d".repeat(32)}:${"e".repeat(64)}`;
const VERIFIER_2 = `pbkdf2-sha256:120000:${"f".repeat(32)}:${"a".repeat(64)}`;

function client(result: { data: unknown; error: { message?: string } | null } = {
    data: { status: "issued", count: 2, studentIds: ["student-1", "student-2"] },
    error: null,
}) {
    return {
        rpc: vi.fn(async () => result),
    } satisfies StudentCredentialBatchGatewayClient;
}

function dependencies() {
    let codeIndex = 0;
    const codes = ["AB2CD3", "EF4GH5"];
    return {
        generateCode: vi.fn(() => codes[codeIndex++] || "JK6MN7"),
        hashCode: vi.fn(async (code: string) => code === "AB2CD3" ? VERIFIER : VERIFIER_2),
        generateIdempotencyKey: vi.fn(() => IDEMPOTENCY_KEY),
        hashConcurrency: 2,
    };
}

describe("student credential batch gateway", () => {
    it("rejects empty, oversized, duplicate, trim-colliding, malformed, and unbounded IDs before work", () => {
        expect(validateCredentialBatch([])).toEqual({ ok: false, error: "invalid_input" });
        expect(validateCredentialBatch(Array.from({ length: 101 }, (_, index) => `student-${index}`)))
            .toEqual({ ok: false, error: "capacity_exceeded" });
        expect(validateCredentialBatch(["student-1", "student-1"]))
            .toEqual({ ok: false, error: "invalid_input" });
        expect(validateCredentialBatch(["student-1", " student-1 "]))
            .toEqual({ ok: false, error: "invalid_input" });
        expect(validateCredentialBatch(["student-1", ""])).toEqual({ ok: false, error: "invalid_input" });
        expect(validateCredentialBatch(["student-1", "x".repeat(257)]))
            .toEqual({ ok: false, error: "invalid_input" });
        expect(validateCredentialBatch(["student-1", "bad\u0000id"]))
            .toEqual({ ok: false, error: "invalid_input" });
        expect(validateCredentialBatch({ studentId: "student-1" })).toEqual({ ok: false, error: "invalid_input" });
    });

    it("generates unique six-character codes, hashes asynchronously, and calls one canonical ordered RPC", async () => {
        const current = client();
        const deps = dependencies();

        const result = await issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-2", "student-1"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, current, deps);

        expect(result).toEqual({
            status: "issued",
            credentials: [
                { studentId: "student-2", startCode: "AB2CD3" },
                { studentId: "student-1", startCode: "EF4GH5" },
            ],
            idempotencyKey: IDEMPOTENCY_KEY,
        });
        expect(deps.hashCode).toHaveBeenCalledTimes(2);
        expect(current.rpc).toHaveBeenCalledTimes(1);
        expect(current.rpc).toHaveBeenCalledWith("omr_issue_student_start_code_batch_v1", {
            p_session_authority: "account",
            p_account_id: `teacher_${"a".repeat(16)}`,
            p_session_generation: 7,
            p_organization_id: `pilot_org_${"b".repeat(24)}`,
            p_actor_user_id: `teacher_${"a".repeat(16)}`,
            p_items: [
                { studentId: "student-1", verifier: VERIFIER_2 },
                { studentId: "student-2", verifier: VERIFIER },
            ],
            p_idempotency_key: IDEMPOTENCY_KEY,
        });
        expect(JSON.stringify(current.rpc.mock.calls[0])).not.toContain("AB2CD3");
        expect(JSON.stringify(current.rpc.mock.calls[0])).not.toContain("EF4GH5");
    });

    it("bounds asynchronous hashing concurrency", async () => {
        let active = 0;
        let maximum = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const current = client({
            data: { status: "issued", count: 8, studentIds: Array.from({ length: 8 }, (_, index) => `s-${index}`) },
            error: null,
        });
        const allowedCodes = ["AA2AA2", "BB3BB3", "CC4CC4", "DD5DD5", "EE6EE6", "FF7FF7", "GG8GG8", "HH9HH9"];
        const deps = {
            generateCode: vi.fn((() => {
                let index = 0;
                return () => allowedCodes[index++];
            })()),
            hashCode: vi.fn(async () => {
                active += 1;
                maximum = Math.max(maximum, active);
                await gate;
                active -= 1;
                return VERIFIER;
            }),
            generateIdempotencyKey: () => IDEMPOTENCY_KEY,
            hashConcurrency: 3,
        };

        const pending = issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: Array.from({ length: 8 }, (_, index) => `s-${index}`),
            idempotencyKey: IDEMPOTENCY_KEY,
        }, current, deps);
        await vi.waitFor(() => expect(active).toBe(3));
        expect(maximum).toBe(3);
        release();
        await pending;
        expect(maximum).toBe(3);
    });

    it("returns secrets only for an exact first-issued envelope with the exact ID set and count", async () => {
        const malformed = [
            { status: "issued", count: 1, studentIds: ["student-1"] },
            { status: "issued", count: 2, studentIds: ["student-1", "student-x"] },
            { status: "issued", count: 2, studentIds: ["student-1", "student-2"], extra: "secret" },
            [{ status: "issued", count: 2, studentIds: ["student-1", "student-2"] }],
        ];
        for (const data of malformed) {
            const result = await issueStudentCredentialBatch({
                ...IDENTITY,
                studentIds: ["student-1", "student-2"],
                idempotencyKey: IDEMPOTENCY_KEY,
            }, client({ data, error: null }), dependencies());
            expect(result).toEqual({
                status: "outcome_unknown",
                error: "outcome_unknown",
                idempotencyKey: IDEMPOTENCY_KEY,
            });
            expect(JSON.stringify(result)).not.toContain("AB2CD3");
        }
    });

    it("never returns regenerated codes for an exact replay", async () => {
        const result = await issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-1", "student-2"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, client({
            data: { status: "already_applied", count: 2, studentIds: ["student-1", "student-2"] },
            error: null,
        }), dependencies());

        expect(result).toEqual({
            status: "already_applied",
            error: "replayed_without_credentials",
            idempotencyKey: IDEMPOTENCY_KEY,
        });
        expect(JSON.stringify(result)).not.toContain("AB2CD3");
        expect(JSON.stringify(result)).not.toContain(VERIFIER);
    });

    it("returns outcome_unknown on a thrown RPC and does not retry automatically", async () => {
        const current = { rpc: vi.fn(async () => { throw new Error(`secret ${VERIFIER}`); }) };
        const result = await issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-1"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, current, dependencies());

        expect(result).toEqual({
            status: "outcome_unknown",
            error: "outcome_unknown",
            idempotencyKey: IDEMPOTENCY_KEY,
        });
        expect(current.rpc).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).not.toContain(VERIFIER);
    });

    it.each([
        ["invalid_request", { status: "rejected", error: "invalid_input" }],
        ["student_unavailable", { status: "rejected", error: "invalid_input" }],
        ["unauthorized", { status: "rejected", error: "forbidden" }],
        ["idempotency_conflict", { status: "rejected", error: "conflict" }],
        ["capacity_exceeded", { status: "rejected", error: "capacity_exceeded" }],
    ])("maps the exact typed database status %s without raw detail", async (status, expected) => {
        const result = await issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-1"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, client({ data: { status }, error: null }), dependencies());

        expect(result).toEqual(expected);
        expect(JSON.stringify(result)).not.toContain(VERIFIER);
    });

    it("treats every RPC error as outcome_unknown without parsing raw messages", async () => {
        for (const message of [
            "invalid_request",
            "unauthorized",
            "idempotency_conflict",
            `raw DB error ${VERIFIER}`,
        ]) {
            const current = client({ data: null, error: { message } });
            const result = await issueStudentCredentialBatch({
                ...IDENTITY,
                studentIds: ["student-1"],
                idempotencyKey: IDEMPOTENCY_KEY,
            }, current, dependencies());
            expect(result).toEqual({
                status: "outcome_unknown",
                error: "outcome_unknown",
                idempotencyKey: IDEMPOTENCY_KEY,
            });
            expect(current.rpc).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(result)).not.toContain(message);
        }
    });

    it("retries generated-code collisions only within a strict bound and never calls RPC on exhaustion", async () => {
        const collisionDeps = dependencies();
        collisionDeps.generateCode
            .mockReturnValueOnce("AB2CD3")
            .mockReturnValueOnce("AB2CD3")
            .mockReturnValueOnce("EF4GH5");
        const successful = client();
        await expect(issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-1", "student-2"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, successful, collisionDeps)).resolves.toMatchObject({ status: "issued" });
        expect(collisionDeps.generateCode).toHaveBeenCalledTimes(3);

        const exhaustedDeps = dependencies();
        exhaustedDeps.generateCode.mockReturnValue("AB2CD3");
        const untouched = client();
        await expect(issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-1", "student-2"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, untouched, exhaustedDeps)).resolves.toEqual({
            status: "unavailable",
            error: "dependency_unavailable",
        });
        expect(exhaustedDeps.generateCode).toHaveBeenCalledTimes(33);
        expect(untouched.rpc).not.toHaveBeenCalled();
    });

    it("rejects forbidden or biased generated characters before hashing", async () => {
        for (const badCode of ["ABC0O1", "ABC1I2", "abc234", "ABCDE", "ABCDEFG"]) {
            const current = client();
            const deps = dependencies();
            deps.generateCode.mockReturnValue(badCode);
            await expect(issueStudentCredentialBatch({
                ...IDENTITY,
                studentIds: ["student-1"],
                idempotencyKey: IDEMPOTENCY_KEY,
            }, current, deps)).resolves.toEqual({
                status: "unavailable",
                error: "dependency_unavailable",
            });
            expect(deps.hashCode).not.toHaveBeenCalled();
            expect(current.rpc).not.toHaveBeenCalled();
        }
    });

    it("does not invoke accessors or serialization hooks on an untrusted response envelope", async () => {
        const getter = vi.fn(() => "issued");
        const toJSON = vi.fn(() => ({ secret: VERIFIER }));
        const response = {
            get status() { return getter(); },
            count: 1,
            studentIds: ["student-1"],
            toJSON,
        };
        const result = await issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-1"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, client({ data: response, error: null }), dependencies());

        expect(result).toEqual({
            status: "outcome_unknown",
            error: "outcome_unknown",
            idempotencyKey: IDEMPOTENCY_KEY,
        });
        expect(getter).not.toHaveBeenCalled();
        expect(toJSON).not.toHaveBeenCalled();
    });

    it("does not invoke nested student ID accessors before deciding whether secrets may be returned", async () => {
        const getter = vi.fn(() => "student-1");
        const studentIds: string[] = [];
        Object.defineProperty(studentIds, "0", { enumerable: true, configurable: true, get: getter });
        Object.defineProperty(studentIds, "length", { value: 1 });
        const result = await issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-1"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, client({ data: { status: "issued", count: 1, studentIds }, error: null }), dependencies());

        expect(result).toEqual({
            status: "outcome_unknown",
            error: "outcome_unknown",
            idempotencyKey: IDEMPOTENCY_KEY,
        });
        expect(getter).not.toHaveBeenCalled();
    });

    it("rejects a sparse oversized nested ID array before proportional allocation", async () => {
        const studentIds: string[] = [];
        studentIds.length = 10_001;
        const result = await issueStudentCredentialBatch({
            ...IDENTITY,
            studentIds: ["student-1"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, client({ data: { status: "issued", count: 1, studentIds }, error: null }), dependencies());

        expect(result).toEqual({
            status: "outcome_unknown",
            error: "outcome_unknown",
            idempotencyKey: IDEMPOTENCY_KEY,
        });
    });

    it("rejects malformed identity and weak idempotency before code generation or RPC", async () => {
        const current = client();
        const deps = dependencies();
        for (const input of [
            { ...IDENTITY, accountSessionGeneration: 0, studentIds: ["student-1"], idempotencyKey: IDEMPOTENCY_KEY },
            { ...IDENTITY, organizationId: "other", studentIds: ["student-1"], idempotencyKey: IDEMPOTENCY_KEY },
            { ...IDENTITY, studentIds: ["student-1"], idempotencyKey: "batch_short" },
        ]) {
            await expect(issueStudentCredentialBatch(input, current, deps)).resolves.toEqual({
                status: "rejected",
                error: "invalid_input",
            });
        }
        expect(deps.generateCode).not.toHaveBeenCalled();
        expect(current.rpc).not.toHaveBeenCalled();
    });

    it("does no idempotency-key generation for a rejected identity or batch", async () => {
        for (const input of [
            { ...IDENTITY, accountSessionGeneration: 0, studentIds: ["student-1"] },
            { ...IDENTITY, studentIds: [] },
        ]) {
            const deps = dependencies();
            await expect(issueStudentCredentialBatch(input, client(), deps)).resolves.toMatchObject({
                status: "rejected",
            });
            expect(deps.generateIdempotencyKey).not.toHaveBeenCalled();
            expect(deps.generateCode).not.toHaveBeenCalled();
        }
    });

    it("maps pre-RPC CSPRNG failures to a stable unavailable result", async () => {
        for (const dependency of ["generateIdempotencyKey", "generateCode"] as const) {
            const current = client();
            const deps = dependencies();
            deps[dependency].mockImplementation(() => {
                throw new Error("raw entropy provider detail");
            });
            const result = await issueStudentCredentialBatch({
                ...IDENTITY,
                studentIds: ["student-1"],
                ...(dependency === "generateCode" ? { idempotencyKey: IDEMPOTENCY_KEY } : {}),
            }, current, deps);
            expect(result).toEqual({ status: "unavailable", error: "dependency_unavailable" });
            expect(JSON.stringify(result)).not.toContain("entropy");
            expect(current.rpc).not.toHaveBeenCalled();
        }
    });

    it("accepts a legacy account whose signed workspace actor differs from its database account", async () => {
        const current = client({
            data: { status: "issued", count: 1, studentIds: ["student-1"] },
            error: null,
        });
        const result = await issueStudentCredentialBatch({
            sessionAuthority: "legacy_account",
            accountId: "teacher_legacyaccount001",
            accountSessionGeneration: 2,
            organizationId: "teacher_sharedqa",
            actorUserId: "teacher_abc1234",
            studentIds: ["student-1"],
            idempotencyKey: IDEMPOTENCY_KEY,
        }, current, dependencies());

        expect(result).toMatchObject({ status: "issued" });
        expect(current.rpc).toHaveBeenCalledWith("omr_issue_student_start_code_batch_v1", expect.objectContaining({
            p_session_authority: "legacy_account",
            p_account_id: "teacher_legacyaccount001",
            p_actor_user_id: "teacher_abc1234",
        }));
    });
});
