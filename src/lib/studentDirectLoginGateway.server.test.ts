import { describe, expect, it, vi } from "vitest";
import { INITIAL_OPERATIONS_LIMITS } from "./initialOperationsPolicy";
import {
    hashStudentStartCode,
    STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH,
    STUDENT_START_CODE_MAX_LENGTH,
} from "./studentCredentialVerifier";
import {
    resolveDirectStudentLogin,
    type DirectStudentLoginClient,
    type DirectStudentLoginInput,
} from "./studentDirectLoginGateway.server";

const studentId = "student-1";
const organizationId = "org-1";
const accountId = `student_credential_${"a".repeat(32)}`;
const startCode = "ABC234";
const codeHash = hashStudentStartCode(startCode, 10_000, Buffer.alloc(16, 7));

function profile(overrides: Record<string, unknown> = {}) {
    return {
        id: studentId,
        organization_id: organizationId,
        display_name: "김학생",
        status: "active",
        credential_generation: 3,
        ...overrides,
    };
}

function enrollment(classId = "class-1", overrides: Record<string, unknown> = {}) {
    return {
        class_id: classId,
        organization_id: organizationId,
        student_profile_id: studentId,
        enrollment_status: "active",
        ...overrides,
    };
}

function group(id = "class-1", overrides: Record<string, unknown> = {}) {
    return {
        id,
        organization_id: organizationId,
        name: "수학반",
        campus: "서울",
        status: "active",
        ...overrides,
    };
}

type ReadStage = "lookup" | "credential" | "verified_profile" | "enrollments" | "classes";
type QueryCall = {
    table: string;
    columns?: string;
    filters: Array<[string, string]>;
    inclusions: Array<[string, string[]]>;
    ordering: Array<[string, { ascending?: boolean } | undefined]>;
    limit?: number;
    single?: boolean;
};

function database(options: {
    lookup?: unknown;
    verifiedProfile?: unknown;
    credential?: unknown;
    enrollments?: unknown;
    classes?: unknown;
    failAt?: ReadStage | "validation";
    throwAt?: ReadStage | "validation";
    validation?: unknown;
} = {}) {
    const calls: QueryCall[] = [];
    const events: string[] = [];
    const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const state = {
        lookup: profile(),
        credential: { start_code_hash: codeHash, account_id: accountId, credential_generation: 3 },
        verifiedProfile: profile(),
        enrollments: [enrollment()],
        classes: [group()],
        validation: true,
        ...options,
    };

    function response(stage: ReadStage) {
        events.push(stage);
        if (state.throwAt === stage) throw new Error("private service detail");
        if (state.failAt === stage) return { data: null, error: { message: "private service detail" } };
        const data = stage === "verified_profile" ? state.verifiedProfile : state[stage];
        // Responses intentionally do not apply query filters: the gateway must
        // check returned authority rather than trusting a filtered read alone.
        return { data, error: null };
    }

    const client: DirectStudentLoginClient = {
        from(table) {
            const call: QueryCall = { table, filters: [], inclusions: [], ordering: [] };
            calls.push(call);
            function stage(): ReadStage {
                if (table === "omr_student_profiles") {
                    return call.filters.some(([column]) => column === "organization_id")
                        ? "verified_profile" : "lookup";
                }
                if (table === "omr_student_start_credentials") return "credential";
                if (table === "omr_class_students") return "enrollments";
                if (table === "omr_classes") return "classes";
                throw new Error(`Unexpected table ${table}`);
            }
            const query = {
                eq(column: string, value: string) {
                    call.filters.push([column, value]);
                    return query;
                },
                in(column: string, values: string[]) {
                    call.inclusions.push([column, values]);
                    return query;
                },
                order(column: string, ordering?: { ascending?: boolean }) {
                    call.ordering.push([column, ordering]);
                    return query;
                },
                async maybeSingle() {
                    call.single = true;
                    return response(stage());
                },
                async limit(limit: number) {
                    call.limit = limit;
                    return response(stage()) as { data: unknown[] | null; error: { message?: string } | null };
                },
            };
            return { select(columns) { call.columns = columns; return query; } };
        },
        async rpc(name, params) {
            events.push("validation");
            rpcCalls.push({ name, params });
            if (state.throwAt === "validation") throw new Error("private validation detail");
            return {
                data: state.validation,
                error: state.failAt === "validation" ? { message: "private validation detail" } : null,
            };
        },
    };
    return { client, calls, events, rpcCalls, state };
}

const input: DirectStudentLoginInput = { studentId, startCode };
const verifiedCredential = {
    organizationId,
    studentId,
    studentName: "김학생",
    identityType: "registered",
    accountId,
    credentialGeneration: 3,
};

describe("direct student login gateway", () => {
    it("authenticates the canonical student ID before selecting its single active class", async () => {
        const { client, calls, events, rpcCalls } = database();

        await expect(resolveDirectStudentLogin(client, {
            studentId: ` ${studentId} `,
            startCode: " abc 234 ",
        })).resolves.toEqual({
            status: "verified",
            credential: verifiedCredential,
            group: { id: "class-1", name: "수학반", region: "서울" },
        });
        expect(events).toEqual([
            "lookup", "credential", "verified_profile", "validation", "enrollments", "classes",
        ]);
        expect(calls[0]).toMatchObject({ table: "omr_student_profiles", filters: [["id", studentId]], single: true });
        expect(calls[0].columns).not.toMatch(/external_id|email|display_name/);
        expect(rpcCalls).toEqual([{
            name: "omr_validate_student_session_v1",
            params: {
                p_account_id: accountId,
                p_organization_id: organizationId,
                p_student_id: studentId,
                p_credential_generation: 3,
            },
        }]);
    });

    it.each([
        { studentId: "", startCode },
        { studentId: "  ", startCode },
        { studentId: "s".repeat(STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH + 1), startCode },
        { studentId, startCode: "" },
        { studentId, startCode: "ABCDE" },
        { studentId, startCode: "ABCDEFG" },
        { studentId, startCode: "ABC0O1" },
        { studentId, startCode: "ABC1I2" },
        { studentId, startCode: `${startCode}${" ".repeat(STUDENT_START_CODE_MAX_LENGTH)}` },
        { studentId, startCode, groupId: "g".repeat(STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH + 1) },
    ])("rejects malformed or unbounded input before account queries: %j", async badInput => {
        const { client, calls, events } = database();
        await expect(resolveDirectStudentLogin(client, badInput)).resolves.toEqual({ status: "invalid_credentials" });
        expect(calls).toEqual([]);
        expect(events).toEqual([]);
    });

    it.each([
        { lookup: null },
        { lookup: profile({ id: "student-other" }) },
        { lookup: profile({ organization_id: "" }) },
        { lookup: profile({ status: "inactive" }) },
        { lookup: profile({ status: "invited" }) },
        { credential: null },
        { credential: { start_code_hash: null } },
        { credential: { start_code_hash: codeHash, account_id: accountId, credential_generation: 2 } },
        { verifiedProfile: profile({ organization_id: "org-other" }) },
        { verifiedProfile: profile({ id: "student-other" }) },
        { verifiedProfile: profile({ status: "inactive" }) },
        { validation: false },
        { validation: "true" },
    ])("returns one generic failure for missing, inactive, foreign, or revoked authority: %j", async options => {
        const { client, events } = database(options);
        await expect(resolveDirectStudentLogin(client, input)).resolves.toEqual({ status: "invalid_credentials" });
        expect(events).not.toContain("enrollments");
        expect(events).not.toContain("classes");
    });

    it("rejects a wrong code before exposing enrollment or class choices", async () => {
        const { client, events } = database();
        await expect(resolveDirectStudentLogin(client, { ...input, startCode: "ABC235" }))
            .resolves.toEqual({ status: "invalid_credentials" });
        expect(events).toEqual(["lookup", "credential"]);
    });

    it("rejects a profile that becomes invited between canonical lookup and credential verification", async () => {
        const { client, events } = database({ verifiedProfile: profile({ status: "invited" }) });
        await expect(resolveDirectStudentLogin(client, input)).resolves.toEqual({ status: "invalid_credentials" });
        expect(events).not.toContain("enrollments");
        expect(events).not.toContain("classes");
    });

    it("re-verifies the start code when a student submits a selected class after code rotation", async () => {
        const { client, state, events } = database({
            enrollments: [enrollment("class-1"), enrollment("class-2")],
            classes: [group("class-1"), group("class-2", { name: "영어반" })],
        });
        await expect(resolveDirectStudentLogin(client, input)).resolves.toMatchObject({ status: "group_required" });
        state.credential = {
            start_code_hash: hashStudentStartCode("XYZ789", 10_000, Buffer.alloc(16, 8)),
            account_id: accountId,
            credential_generation: 4,
        };
        state.verifiedProfile = profile({ credential_generation: 4 });
        events.length = 0;
        await expect(resolveDirectStudentLogin(client, { ...input, groupId: "class-2" }))
            .resolves.toEqual({ status: "invalid_credentials" });
        expect(events).toEqual(["lookup", "credential"]);
    });

    it.each([
        { enrollments: [] },
        { enrollments: [enrollment("class-1", { organization_id: "org-other" })] },
        { enrollments: [enrollment("class-1", { student_profile_id: "student-other" })] },
        { enrollments: [enrollment("class-1", { enrollment_status: "inactive" })] },
        { enrollments: [enrollment("class-1", { enrollment_status: null })] },
        { enrollments: [enrollment("")] },
        { classes: [] },
        { classes: [group("class-1", { organization_id: "org-other" })] },
        { classes: [group("class-other")] },
        { classes: [group("class-1", { status: "archived" })] },
        { classes: [group("class-1", { status: null })] },
    ])("rejects enrollment or class rows that cannot authorize this active student: %j", async options => {
        const { client } = database(options);
        await expect(resolveDirectStudentLogin(client, input)).resolves.toEqual({ status: "invalid_credentials" });
    });

    it("offers only safe enrolled class fields after successful credential validation", async () => {
        const { client } = database({
            enrollments: [enrollment("class-1"), enrollment("class-2")],
            classes: [
                group("class-1", { metadata: { secret: "hidden" } }),
                group("class-2", { name: "영어반", campus: "" }),
            ],
        });
        await expect(resolveDirectStudentLogin(client, input)).resolves.toEqual({
            status: "group_required",
            groups: [
                { id: "class-1", name: "수학반", region: "서울" },
                { id: "class-2", name: "영어반", region: undefined },
            ],
        });
    });

    it("accepts the submitted class only from freshly authenticated active enrollment", async () => {
        const { client } = database({
            enrollments: [enrollment("class-1"), enrollment("class-2")],
            classes: [group("class-1"), group("class-2", { name: "영어반" })],
        });
        await expect(resolveDirectStudentLogin(client, { ...input, groupId: "class-2" })).resolves.toEqual({
            status: "verified",
            credential: verifiedCredential,
            group: { id: "class-2", name: "영어반", region: "서울" },
        });
        await expect(resolveDirectStudentLogin(client, { ...input, groupId: "class-foreign" }))
            .resolves.toEqual({ status: "invalid_credentials" });
    });

    it("rejects a previously offered class once active enrollment changes", async () => {
        const { client, state } = database({
            enrollments: [enrollment("class-1"), enrollment("class-2")],
            classes: [group("class-1"), group("class-2")],
        });
        await expect(resolveDirectStudentLogin(client, input)).resolves.toMatchObject({ status: "group_required" });
        state.enrollments = [enrollment("class-1")];
        state.classes = [group("class-1")];
        await expect(resolveDirectStudentLogin(client, { ...input, groupId: "class-2" }))
            .resolves.toEqual({ status: "invalid_credentials" });
    });

    it("bounds enrollment and class reads within the canonical organization and student", async () => {
        const { client, calls } = database();
        await resolveDirectStudentLogin(client, input);
        expect(calls.find(call => call.table === "omr_class_students")).toMatchObject({
            filters: [
                ["organization_id", organizationId],
                ["student_profile_id", studentId],
                ["enrollment_status", "active"],
            ],
            limit: INITIAL_OPERATIONS_LIMITS.classes + 1,
        });
        expect(calls.find(call => call.table === "omr_classes")).toMatchObject({
            filters: [["organization_id", organizationId], ["status", "active"]],
            inclusions: [["id", ["class-1"]]],
            limit: INITIAL_OPERATIONS_LIMITS.classes + 1,
        });
    });

    it.each(["enrollments", "classes"] as const)("fails closed when %s exceeds the supported class limit", async table => {
        const options = table === "enrollments"
            ? { enrollments: Array.from({ length: INITIAL_OPERATIONS_LIMITS.classes + 1 }, (_, i) => enrollment(`class-${i}`)) }
            : { classes: Array.from({ length: INITIAL_OPERATIONS_LIMITS.classes + 1 }, (_, i) => group(`class-${i}`)) };
        const { client, events } = database(options);
        await expect(resolveDirectStudentLogin(client, input)).resolves.toEqual({ status: "service_unavailable" });
        expect(events.at(-1)).toBe(table);
        if (table === "enrollments") expect(events).not.toContain("classes");
    });

    it.each(["lookup", "credential", "verified_profile", "validation", "enrollments", "classes"] as const)(
        "fails closed without logging private details when %s is unavailable", async failAt => {
            const logger = vi.spyOn(console, "error");
            try {
                for (const options of [{ failAt }, { throwAt: failAt }]) {
                    const { client, events } = database(options);
                    await expect(resolveDirectStudentLogin(client, input))
                        .resolves.toEqual({ status: "service_unavailable" });
                    expect(events.at(-1)).toBe(failAt);
                }
                expect(logger).not.toHaveBeenCalled();
            } finally {
                logger.mockRestore();
            }
        },
    );

    it.each(["enrollments", "classes"] as const)("fails closed for malformed %s list responses", async table => {
        const { client, events } = database({ [table]: { unexpected: true } });
        await expect(resolveDirectStudentLogin(client, input)).resolves.toEqual({ status: "service_unavailable" });
        expect(events.at(-1)).toBe(table);
    });
});
