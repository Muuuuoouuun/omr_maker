import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const E2E_SECRET = "omr-maker-e2e-teacher-session-secret-2026";
const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const fixtures = [{
    organizationId: "default",
    examId: "e2e-invite-exam-a",
    actorUserIds: ["teacher_0en845w"],
    groups: [{ id: "e2e-group-a", name: "E2E A반", region: "서울" }],
}, {
    organizationId: "default",
    examId: "e2e-invite-exam-b",
    actorUserIds: ["teacher_0en845w"],
    groups: [{ id: "e2e-group-b", name: "E2E B반", region: "부산" }],
}];

function enabledEnv(extra: Record<string, string | undefined> = {}) {
    return {
        NODE_ENV: "test",
        OMR_E2E_EXAM_INVITE_SIMULATION: "1",
        TEACHER_SESSION_SECRET: E2E_SECRET,
        OMR_E2E_EXAM_INVITE_FIXTURES: JSON.stringify(fixtures),
        ...extra,
    };
}

async function simulationModule() {
    return import("./examEntryInviteE2eSimulation");
}

describe("exam entry invite E2E RPC simulation", () => {
    afterEach(async () => {
        const simulation = await simulationModule().catch(() => null);
        simulation?.resetExamEntryInviteE2eSimulationForTests();
    });

    it("is impossible to enable in production or with the wrong explicit E2E authority", async () => {
        const simulation = await simulationModule();

        expect(simulation.createExamEntryInviteE2eSimulationClient(enabledEnv({ NODE_ENV: "production" })))
            .toBeNull();
        expect(simulation.createExamEntryInviteE2eSimulationClient(enabledEnv({ TEACHER_SESSION_SECRET: "wrong" })))
            .toBeNull();
        expect(simulation.createExamEntryInviteE2eSimulationClient(enabledEnv({ OMR_E2E_EXAM_INVITE_SIMULATION: "0" })))
            .toBeNull();
        expect(simulation.createExamEntryInviteE2eSimulationClient(enabledEnv({ OMR_E2E_EXAM_INVITE_FIXTURES: "{}" })))
            .toBeNull();
    });

    it("stores only hashes, rotates generation, and invalidates old and cross-exam capabilities", async () => {
        const simulation = await simulationModule();
        const client = simulation.createExamEntryInviteE2eSimulationClient(enabledEnv(), () => NOW);
        expect(client).not.toBeNull();
        if (!client) throw new Error("simulation did not enable");
        const firstHash = createHash("sha256").update("a".repeat(43)).digest("hex");
        const secondHash = createHash("sha256").update("b".repeat(43)).digest("hex");
        const expiresAt = new Date(NOW + 30 * 60 * 1000).toISOString();
        const base = {
            p_organization_id: "default",
            p_exam_id: "e2e-invite-exam-a",
            p_actor_user_id: "teacher_0en845w",
        };

        const first = await client.rpc("omr_rotate_exam_entry_invite_v1", {
            ...base,
            p_token_hash: firstHash,
            p_expires_at: expiresAt,
        });
        expect(first.error).toBeNull();
        expect(first.data).toEqual({
            status: "issued",
            metadata: expect.objectContaining({
                examId: "e2e-invite-exam-a",
                generation: 1,
                targetIds: ["e2e-group-a"],
            }),
        });
        expect(JSON.stringify(first.data)).not.toMatch(/token|hash/i);

        await expect(client.rpc("omr_get_exam_entry_invite_metadata_v1", base))
            .resolves.toEqual({ data: first.data && { status: "found", metadata: (first.data as { metadata: unknown }).metadata }, error: null });
        await expect(client.rpc("omr_resolve_exam_entry_invite_v1", {
            p_token_hash: firstHash,
            p_exam_id: "e2e-invite-exam-a",
        })).resolves.toEqual({
            data: {
                status: "resolved",
                organizationId: "default",
                examId: "e2e-invite-exam-a",
                groupIds: ["e2e-group-a"],
                expiresAt,
            },
            error: null,
        });

        const second = await client.rpc("omr_rotate_exam_entry_invite_v1", {
            ...base,
            p_token_hash: secondHash,
            p_expires_at: expiresAt,
        });
        expect(second.data).toEqual({
            status: "issued",
            metadata: expect.objectContaining({ generation: 2 }),
        });
        await expect(client.rpc("omr_resolve_exam_entry_invite_v1", {
            p_token_hash: firstHash,
            p_exam_id: "e2e-invite-exam-a",
        })).resolves.toEqual({ data: { status: "invalid" }, error: null });
        await expect(client.rpc("omr_resolve_exam_entry_invite_v1", {
            p_token_hash: secondHash,
            p_exam_id: "e2e-invite-exam-b",
        })).resolves.toEqual({ data: { status: "invalid" }, error: null });
    });

    it("revokes idempotently and never resolves an expired or revoked hash", async () => {
        const simulation = await simulationModule();
        let clock = NOW;
        const client = simulation.createExamEntryInviteE2eSimulationClient(enabledEnv(), () => clock);
        if (!client) throw new Error("simulation did not enable");
        const tokenHash = createHash("sha256").update("c".repeat(43)).digest("hex");
        const expiresAt = new Date(NOW + 20 * 60 * 1000).toISOString();
        const base = {
            p_organization_id: "default",
            p_exam_id: "e2e-invite-exam-a",
            p_actor_user_id: "teacher_0en845w",
        };
        await client.rpc("omr_rotate_exam_entry_invite_v1", {
            ...base,
            p_token_hash: tokenHash,
            p_expires_at: expiresAt,
        });

        const firstRevoke = await client.rpc("omr_revoke_exam_entry_invite_v1", base);
        const secondRevoke = await client.rpc("omr_revoke_exam_entry_invite_v1", base);
        expect(secondRevoke).toEqual(firstRevoke);
        expect(JSON.stringify(firstRevoke.data)).not.toMatch(/token|hash/i);
        await expect(client.rpc("omr_resolve_exam_entry_invite_v1", {
            p_token_hash: tokenHash,
            p_exam_id: "e2e-invite-exam-a",
        })).resolves.toEqual({ data: { status: "invalid" }, error: null });

        const newHash = createHash("sha256").update("d".repeat(43)).digest("hex");
        await client.rpc("omr_rotate_exam_entry_invite_v1", {
            ...base,
            p_token_hash: newHash,
            p_expires_at: expiresAt,
        });
        clock = Date.parse(expiresAt);
        await expect(client.rpc("omr_resolve_exam_entry_invite_v1", {
            p_token_hash: newHash,
            p_exam_id: "e2e-invite-exam-a",
        })).resolves.toEqual({ data: { status: "invalid" }, error: null });
    });

    it("fails closed on actor, TTL, and fixture bounds while exposing only trusted fixture groups", async () => {
        const simulation = await simulationModule();
        const client = simulation.createExamEntryInviteE2eSimulationClient(enabledEnv(), () => NOW);
        if (!client) throw new Error("simulation did not enable");
        const tokenHash = createHash("sha256").update("e".repeat(43)).digest("hex");
        const base = {
            p_organization_id: "default",
            p_exam_id: "e2e-invite-exam-a",
            p_token_hash: tokenHash,
            p_expires_at: new Date(NOW + 30 * 60 * 1000).toISOString(),
        };

        await expect(client.rpc("omr_rotate_exam_entry_invite_v1", {
            ...base,
            p_actor_user_id: "teacher_untrusted",
        })).resolves.toEqual({ data: { status: "unauthorized" }, error: null });
        await expect(client.rpc("omr_rotate_exam_entry_invite_v1", {
            ...base,
            p_actor_user_id: "teacher_0en845w",
            p_expires_at: new Date(NOW + 91 * 24 * 60 * 60 * 1000).toISOString(),
        })).resolves.toEqual({ data: { status: "invalid" }, error: null });

        expect(simulation.getExamEntryInviteE2eFixtureGroups(
            enabledEnv(),
            "default",
            ["e2e-group-a", "injected-group"],
        )).toEqual([{ id: "e2e-group-a", name: "E2E A반", region: "서울" }]);
        expect(simulation.getExamEntryInviteE2eFixtureGroups(
            enabledEnv(),
            "other-org",
            ["e2e-group-a"],
        )).toEqual([]);
    });

    it("bounds independent fixture stores and evicts the oldest simulation state", async () => {
        const simulation = await simulationModule();
        const tokenHash = createHash("sha256").update("f".repeat(43)).digest("hex");
        const expiresAt = new Date(NOW + 30 * 60 * 1000).toISOString();
        const envs = Array.from({ length: 9 }, (_, index) => enabledEnv({
            OMR_E2E_EXAM_INVITE_FIXTURES: JSON.stringify([{
                ...fixtures[0],
                groups: [{ ...fixtures[0].groups[0], name: `E2E A반 ${index}` }],
            }]),
        }));
        for (const env of envs) {
            const client = simulation.createExamEntryInviteE2eSimulationClient(env, () => NOW);
            if (!client) throw new Error("simulation did not enable");
            await client.rpc("omr_rotate_exam_entry_invite_v1", {
                p_organization_id: "default",
                p_exam_id: "e2e-invite-exam-a",
                p_actor_user_id: "teacher_0en845w",
                p_token_hash: tokenHash,
                p_expires_at: expiresAt,
            });
        }

        const firstClient = simulation.createExamEntryInviteE2eSimulationClient(envs[0], () => NOW);
        if (!firstClient) throw new Error("simulation did not enable");
        await expect(firstClient.rpc("omr_get_exam_entry_invite_metadata_v1", {
            p_organization_id: "default",
            p_exam_id: "e2e-invite-exam-a",
            p_actor_user_id: "teacher_0en845w",
        })).resolves.toEqual({ data: { status: "not_found" }, error: null });
    });

    it("keeps the simulator behind authenticated invite-only fallbacks and always prefers real Supabase", () => {
        const teacherAction = readFileSync(
            path.join(process.cwd(), "src/app/actions/teacherExam.ts"),
            "utf8",
        );
        const studentAction = readFileSync(
            path.join(process.cwd(), "src/app/actions/studentSession.ts"),
            "utf8",
        );
        const teacherGuard = teacherAction.indexOf("isExamEntryInviteRoleAuthorized(session)");
        const teacherConfig = teacherAction.indexOf("getSupabaseServerConfigFromEnv()", teacherGuard);
        const teacherSimulation = teacherAction.indexOf("createExamEntryInviteE2eSimulationClient", teacherConfig);

        expect(teacherGuard).toBeGreaterThan(-1);
        expect(teacherConfig).toBeGreaterThan(teacherGuard);
        expect(teacherSimulation).toBeGreaterThan(teacherConfig);
        expect(teacherAction).toMatch(/config\s*\?\s*createSupabaseAdminClient\(config\)[\s\S]{0,180}createExamEntryInviteE2eSimulationClient/);
        expect(studentAction).toContain("inviteSimulationClient");
        expect(studentAction).toMatch(/typeof input !== "string"[\s\S]{0,240}createExamEntryInviteE2eSimulationClient/);
        expect(studentAction).toContain("getExamEntryInviteE2eFixtureGroups");
    });
});
