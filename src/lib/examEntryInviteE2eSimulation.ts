import { createHash } from "node:crypto";
import {
    EXAM_ENTRY_INVITE_MAX_TTL_MS,
    EXAM_ENTRY_INVITE_MIN_TTL_MS,
} from "@/lib/examEntryInvite";
import type { ExamEntryInviteRpcClient } from "@/lib/examEntryInviteGateway";
import type { ExamEntryInviteMetadata } from "@/lib/examEntryInviteLifecycle";

type Env = Record<string, string | undefined>;

export interface ExamEntryInviteE2eFixtureGroup {
    id: string;
    name: string;
    region?: string;
}

interface ExamEntryInviteE2eFixture {
    organizationId: string;
    examId: string;
    actorUserIds: string[];
    groups: ExamEntryInviteE2eFixtureGroup[];
}

interface SimulatedInviteRow {
    tokenHash: string;
    metadata: ExamEntryInviteMetadata;
}

interface SimulationStore {
    rows: Map<string, SimulatedInviteRow>;
}

const E2E_TEACHER_SESSION_SECRET = "omr-maker-e2e-teacher-session-secret-2026";
const MAX_FIXTURES = 8;
const MAX_GROUPS_PER_FIXTURE = 8;
const MAX_ACTORS_PER_FIXTURE = 4;
const MAX_SIMULATION_STORES = 8;
const SIMULATION_STORES = Symbol.for("omr.exam-entry-invite-e2e-simulation.v1");

function stores(): Map<string, SimulationStore> {
    const root = globalThis as typeof globalThis & {
        [SIMULATION_STORES]?: Map<string, SimulationStore>;
    };
    if (!root[SIMULATION_STORES]) root[SIMULATION_STORES] = new Map();
    return root[SIMULATION_STORES];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
    const keys = Object.keys(value);
    return required.every(key => Object.hasOwn(value, key))
        && keys.every(key => required.includes(key) || optional.includes(key));
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function parseGroup(value: unknown): ExamEntryInviteE2eFixtureGroup | null {
    if (!isRecord(value) || !hasExactKeys(value, ["id", "name"], ["region"])) return null;
    const id = clean(value.id);
    const name = clean(value.name);
    const region = clean(value.region);
    if (!/^e2e-group-[a-z0-9-]{1,48}$/.test(id)
        || !name || name.length > 40
        || region.length > 40) return null;
    return { id, name, ...(region ? { region } : {}) };
}

function parseFixtures(env: Env): ExamEntryInviteE2eFixture[] | null {
    if (env.NODE_ENV === "production"
        || env.OMR_E2E_EXAM_INVITE_SIMULATION !== "1"
        || env.TEACHER_SESSION_SECRET !== E2E_TEACHER_SESSION_SECRET) return null;
    let value: unknown;
    try {
        value = JSON.parse(env.OMR_E2E_EXAM_INVITE_FIXTURES || "");
    } catch {
        return null;
    }
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FIXTURES) return null;

    const fixtures: ExamEntryInviteE2eFixture[] = [];
    const scopes = new Set<string>();
    for (const item of value) {
        if (!isRecord(item)
            || !hasExactKeys(item, ["organizationId", "examId", "actorUserIds", "groups"])) return null;
        const organizationId = clean(item.organizationId).toLowerCase();
        const examId = clean(item.examId);
        if (!/^(?:default|teacher_[a-z0-9]{7,16}|pilot_org_[a-f0-9]{24})$/.test(organizationId)
            || !/^e2e-invite-exam-[a-z0-9-]{1,48}$/.test(examId)
            || !Array.isArray(item.actorUserIds)
            || item.actorUserIds.length < 1
            || item.actorUserIds.length > MAX_ACTORS_PER_FIXTURE
            || !Array.isArray(item.groups)
            || item.groups.length < 1
            || item.groups.length > MAX_GROUPS_PER_FIXTURE) return null;
        const actorUserIds = item.actorUserIds.map(clean);
        if (actorUserIds.some(actor => !/^teacher_[a-z0-9]{7,32}$/.test(actor))
            || new Set(actorUserIds).size !== actorUserIds.length) return null;
        const groups = item.groups.map(parseGroup);
        if (groups.some(group => !group)) return null;
        const trustedGroups = groups as ExamEntryInviteE2eFixtureGroup[];
        if (new Set(trustedGroups.map(group => group.id)).size !== trustedGroups.length) return null;
        const key = `${organizationId}\u0000${examId}`;
        if (scopes.has(key)) return null;
        scopes.add(key);
        fixtures.push({ organizationId, examId, actorUserIds, groups: trustedGroups });
    }
    return fixtures;
}

function fixtureKey(organizationId: string, examId: string): string {
    return `${organizationId}\u0000${examId}`;
}

function fixtureFingerprint(fixtures: ExamEntryInviteE2eFixture[]): string {
    return createHash("sha256").update(JSON.stringify(fixtures)).digest("hex");
}

function metadataFor(
    fixture: ExamEntryInviteE2eFixture,
    generation: number,
    issuedAt: string,
    expiresAt: string,
): ExamEntryInviteMetadata {
    const inviteId = `exam_invite_${createHash("sha256")
        .update(`${fixture.organizationId}\u0000${fixture.examId}\u0000${generation}`)
        .digest("hex")
        .slice(0, 32)}`;
    return {
        inviteId,
        examId: fixture.examId,
        targetType: "groups",
        targetIds: fixture.groups.map(group => group.id),
        generation,
        issuedAt,
        expiresAt,
        revokedAt: null,
    };
}

function cloneMetadata(metadata: ExamEntryInviteMetadata): ExamEntryInviteMetadata {
    return { ...metadata, targetIds: [...metadata.targetIds] };
}

export function createExamEntryInviteE2eSimulationClient(
    env: Env = process.env,
    now: () => number = Date.now,
): ExamEntryInviteRpcClient | null {
    const fixtures = parseFixtures(env);
    if (!fixtures) return null;
    const fixturesByScope = new Map(fixtures.map(fixture => [
        fixtureKey(fixture.organizationId, fixture.examId),
        fixture,
    ]));
    const fingerprint = fixtureFingerprint(fixtures);
    const simulationStores = stores();
    let store = simulationStores.get(fingerprint);
    if (!store) {
        while (simulationStores.size >= MAX_SIMULATION_STORES) {
            const oldestFingerprint = simulationStores.keys().next().value;
            if (typeof oldestFingerprint !== "string") break;
            simulationStores.delete(oldestFingerprint);
        }
        store = { rows: new Map<string, SimulatedInviteRow>() };
        simulationStores.set(fingerprint, store);
    }

    return {
        async rpc(name, params) {
            const organizationId = clean(params.p_organization_id).toLowerCase();
            const examId = clean(params.p_exam_id);
            const actorUserId = clean(params.p_actor_user_id);
            const key = fixtureKey(organizationId, examId);
            const fixture = fixturesByScope.get(key);

            if (name === "omr_resolve_exam_entry_invite_v1") {
                const tokenHash = clean(params.p_token_hash).toLowerCase();
                if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
                    return { data: { status: "invalid" }, error: null };
                }
                for (const [rowKey, row] of store.rows) {
                    const resolvedFixture = fixturesByScope.get(rowKey);
                    if (!resolvedFixture
                        || resolvedFixture.examId !== examId
                        || row.tokenHash !== tokenHash
                        || row.metadata.revokedAt !== null
                        || Date.parse(row.metadata.expiresAt) <= now()) continue;
                    return {
                        data: {
                            status: "resolved",
                            organizationId: resolvedFixture.organizationId,
                            examId: resolvedFixture.examId,
                            groupIds: resolvedFixture.groups.map(group => group.id),
                            expiresAt: row.metadata.expiresAt,
                        },
                        error: null,
                    };
                }
                return { data: { status: "invalid" }, error: null };
            }

            if (!fixture || !fixture.actorUserIds.includes(actorUserId)) {
                return { data: { status: "unauthorized" }, error: null };
            }

            if (name === "omr_rotate_exam_entry_invite_v1") {
                const tokenHash = clean(params.p_token_hash).toLowerCase();
                const expiresAt = clean(params.p_expires_at);
                const currentTime = now();
                const expiryTime = Date.parse(expiresAt);
                if (!/^[a-f0-9]{64}$/.test(tokenHash)
                    || !Number.isFinite(currentTime)
                    || !Number.isFinite(expiryTime)
                    || expiryTime - currentTime < EXAM_ENTRY_INVITE_MIN_TTL_MS
                    || expiryTime - currentTime > EXAM_ENTRY_INVITE_MAX_TTL_MS) {
                    return { data: { status: "invalid" }, error: null };
                }
                const previous = store.rows.get(key);
                const generation = (previous?.metadata.generation || 0) + 1;
                const metadata = metadataFor(
                    fixture,
                    generation,
                    new Date(currentTime).toISOString(),
                    expiresAt,
                );
                store.rows.set(key, { tokenHash, metadata });
                return {
                    data: { status: "issued", metadata: cloneMetadata(metadata) },
                    error: null,
                };
            }

            const row = store.rows.get(key);
            if (!row) return { data: { status: "not_found" }, error: null };

            if (name === "omr_get_exam_entry_invite_metadata_v1") {
                return {
                    data: { status: "found", metadata: cloneMetadata(row.metadata) },
                    error: null,
                };
            }

            if (name === "omr_revoke_exam_entry_invite_v1") {
                if (row.metadata.revokedAt === null) {
                    row.metadata = {
                        ...row.metadata,
                        revokedAt: new Date(now()).toISOString(),
                    };
                }
                return {
                    data: { status: "revoked", metadata: cloneMetadata(row.metadata) },
                    error: null,
                };
            }

            return { data: null, error: { message: "Unsupported E2E invite simulation RPC" } };
        },
    };
}

export function getExamEntryInviteE2eFixtureGroups(
    env: Env,
    organizationIdValue: unknown,
    examIdValue: unknown,
    groupIdsValue: unknown,
): ExamEntryInviteE2eFixtureGroup[] {
    const fixtures = parseFixtures(env);
    const organizationId = clean(organizationIdValue).toLowerCase();
    const examId = clean(examIdValue);
    if (!fixtures || !Array.isArray(groupIdsValue)) return [];
    const requested = new Set(groupIdsValue.map(clean).filter(Boolean));
    const groups = new Map<string, ExamEntryInviteE2eFixtureGroup>();
    for (const fixture of fixtures) {
        if (fixture.organizationId !== organizationId || fixture.examId !== examId) continue;
        for (const group of fixture.groups) {
            if (requested.has(group.id)) groups.set(group.id, group);
        }
    }
    return [...groups.values()].map(group => ({ ...group }));
}

export function resetExamEntryInviteE2eSimulationForTests(): void {
    if (process.env.NODE_ENV === "test") stores().clear();
}
