import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(
    process.cwd(),
    "supabase/migrations/202608080011_exam_entry_invite_lifecycle.sql",
);
const live = readFileSync(join(process.cwd(), "supabase/live-test-assertions.sql"), "utf8");
const productionBoundary = readFileSync(
    join(process.cwd(), "supabase/production-server-boundary.sql"),
    "utf8",
);
const productionRollback = readFileSync(
    join(process.cwd(), "supabase/production-server-boundary-rollback.sql"),
    "utf8",
);
const rollbackLive = readFileSync(
    join(process.cwd(), "supabase/live-test-rollback-assertions.sql"),
    "utf8",
);
const boundaryLive = readFileSync(
    join(process.cwd(), "supabase/live-test-boundary-assertions.sql"),
    "utf8",
);

function migrationSource(): string {
    return readFileSync(migrationPath, "utf8");
}

function routine(source: string, name: string, nextMarker: string): string {
    const start = source.indexOf(`create or replace function public.${name}`);
    const end = source.indexOf(nextMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe("exam entry invite lifecycle migration", () => {
    it("adds opaque group-target metadata and deterministically backfills monotonic generations", () => {
        const source = migrationSource();

        expect(source).toContain("add column generation integer not null default 1");
        expect(source).toMatch(/invite_id text[\s\S]*extensions\.gen_random_bytes\(16\)/i);
        expect(source).toContain("target_type text not null default 'groups'");
        expect(source).toContain("target_ids text[]");
        expect(source).toMatch(/row_number\(\) over \([\s\S]*partition by organization_id, exam_id[\s\S]*order by created_at, token_hash/i);
        expect(source).toContain("target_ids = group_ids");
        expect(source).toMatch(/unique \(organization_id, exam_id, generation\)/i);
    });

    it("rotates transactionally to the next generation while preserving the hash-only input boundary", () => {
        const source = migrationSource();
        const rotate = routine(
            source,
            "omr_rotate_exam_entry_invite_v1",
            "create or replace function public.omr_get_exam_entry_invite_metadata_v1",
        );

        expect(rotate).toContain("p_token_hash text");
        expect(rotate).toContain("pg_catalog.pg_advisory_xact_lock");
        expect(rotate).toMatch(/max\(invite\.generation\)[\s\S]*v_generation :=[\s\S]*\+ 1/i);
        expect(rotate).toMatch(/update public\.omr_exam_entry_invites[\s\S]*set revoked_at = v_now[\s\S]*revoked_at is null/i);
        expect(rotate).toMatch(/insert into public\.omr_exam_entry_invites[\s\S]*generation[\s\S]*v_generation/i);
        expect(rotate).not.toMatch(/jsonb_build_object\([\s\S]*'token(?:Hash)?'/i);
    });

    it("returns only latest lifecycle metadata and never returns the persisted hash", () => {
        const source = migrationSource();
        const metadata = routine(
            source,
            "omr_get_exam_entry_invite_metadata_v1",
            "create or replace function public.omr_revoke_exam_entry_invite_v1",
        );

        expect(source).toContain("omr_get_exam_entry_invite_metadata_v1");
        expect(metadata).toMatch(/order by invite\.generation desc[\s\S]*limit 1/i);
        for (const key of [
            "inviteId", "examId", "targetType", "targetIds", "issuedAt",
            "expiresAt", "revokedAt", "generation",
        ]) expect(metadata).toContain(`'${key}'`);
        expect(metadata).not.toMatch(/'token(?:Hash)?'/i);
        expect(metadata).not.toContain("invite.token_hash");
    });

    it("revokes idempotently and returns the same latest metadata after repeated calls", () => {
        const source = migrationSource();
        const revoke = routine(
            source,
            "omr_revoke_exam_entry_invite_v1",
            "revoke all on function public.omr_rotate_exam_entry_invite_v1",
        );

        expect(source).toContain("omr_revoke_exam_entry_invite_v1");
        expect(source).not.toContain("pg_catalog.coalesce");
        expect(revoke).toMatch(/set revoked_at = coalesce\(invite\.revoked_at, v_now\)/i);
        expect(revoke).toMatch(/order by invite\.generation desc[\s\S]*limit 1[\s\S]*for update/i);
        expect(revoke).not.toMatch(/'token(?:Hash)?'/i);
        expect(revoke).not.toContain("invite.token_hash");
    });

    it("requires the signed organization teacher scope and service-role-only execution", () => {
        const source = migrationSource();

        expect(source.match(/member\.status = 'active'/g)).toHaveLength(3);
        expect(source.match(/member\.role in \('owner', 'admin', 'teacher'\)/g)).toHaveLength(3);
        for (const name of [
            "omr_rotate_exam_entry_invite_v1",
            "omr_get_exam_entry_invite_metadata_v1",
            "omr_revoke_exam_entry_invite_v1",
        ]) {
            expect(source).toMatch(new RegExp(
                `revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated`,
                "i",
            ));
            expect(source).toMatch(new RegExp(
                `grant execute on function public\\.${name}\\([\\s\\S]*?to service_role`,
                "i",
            ));
        }
    });

    it("extends live proof for non-disclosure, generation, idempotence, and browser denial", () => {
        expect(live).toContain("omr_get_exam_entry_invite_metadata_v1");
        expect(live).toContain("omr_revoke_exam_entry_invite_v1");
        expect(live).toMatch(/metadata_result::text[\s\S]*not like '%token%'[\s\S]*not like '%hash%'/i);
        expect(live).toMatch(/generation[\s\S]*opaque exam invite rotation did not advance generation/i);
        expect(live).toMatch(/second_revoke[\s\S]*idempotent/i);
        expect(live).toMatch(/has_function_privilege\('anon', 'public\.omr_get_exam_entry_invite_metadata_v1\(text,text,text\)'/i);
        expect(live).toMatch(/has_function_privilege\('authenticated', 'public\.omr_revoke_exam_entry_invite_v1\(text,text,text\)'/i);
    });

    it("preserves lifecycle RPC denial across both production rollback fences", () => {
        for (const name of [
            "omr_get_exam_entry_invite_metadata_v1",
            "omr_revoke_exam_entry_invite_v1",
        ]) {
            expect(productionRollback.match(new RegExp(`'${name}'`, "g"))).toHaveLength(2);
            for (const role of ["anon", "authenticated"]) {
                expect(rollbackLive).toMatch(new RegExp(
                    `pg_catalog\\.has_function_privilege\\(\\s*'${role}',\\s*'public\\.${name}\\(text,text,text\\)',\\s*'EXECUTE'`,
                    "i",
                ));
            }
            expect(rollbackLive).toMatch(new RegExp(
                `not pg_catalog\\.has_function_privilege\\(\\s*'service_role',\\s*'public\\.${name}\\(text,text,text\\)',\\s*'EXECUTE'`,
                "i",
            ));
        }
        expect(productionRollback).toMatch(
            /guarded_functions text\[\] := array\[[\s\S]*omr_get_exam_entry_invite_metadata_v1[\s\S]*omr_revoke_exam_entry_invite_v1[\s\S]*for guarded_function in select unnest\(guarded_functions\)/i,
        );
        expect(productionRollback).toMatch(
            /foreach guarded_function in array array\[[\s\S]*omr_get_exam_entry_invite_metadata_v1[\s\S]*omr_revoke_exam_entry_invite_v1[\s\S]*revoke all on function public\.%I\(%s\) from public, anon, authenticated; grant execute/i,
        );
    });

    it("makes lifecycle RPC existence, ACLs, and provenance part of invite readiness", () => {
        const readinessStart = productionBoundary.indexOf("v_exam_entry_invites_ready :=");
        const readinessEnd = productionBoundary.indexOf(
            "v_workspace_bootstrap_plan_safe :=",
            readinessStart,
        );
        expect(readinessStart).toBeGreaterThanOrEqual(0);
        expect(readinessEnd).toBeGreaterThan(readinessStart);
        const readiness = productionBoundary.slice(readinessStart, readinessEnd);

        for (const name of [
            "omr_get_exam_entry_invite_metadata_v1",
            "omr_revoke_exam_entry_invite_v1",
        ]) {
            const signature = `public.${name}(text,text,text)`;
            expect(readiness).toContain(`pg_catalog.to_regprocedure('${signature}') is not null`);
            expect(readiness).toContain(
                `pg_catalog.has_function_privilege('service_role', '${signature}', 'EXECUTE')`,
            );
            for (const role of ["anon", "authenticated"]) {
                expect(readiness).toContain(
                    `not pg_catalog.has_function_privilege('${role}', '${signature}', 'EXECUTE')`,
                );
            }
            const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            expect(readiness).toMatch(new RegExp(
                `obj_description\\(\\s*pg_catalog\\.to_regprocedure\\('${escapedSignature}'\\),\\s*'pg_proc'\\s*\\)[\\s\\S]*?metadata-only-exam-entry-invite-lifecycle:202608080011`,
                "i",
            ));
            expect(readiness).not.toContain(`'${signature}'::pg_catalog.regprocedure`);
        }

        expect(boundaryLive).toContain("readiness ->> 'examEntryInvitesReady' <> 'true'");
        expect(boundaryLive).toMatch(
            /begin;[\s\S]*revoke execute on function public\.omr_get_exam_entry_invite_metadata_v1\(text,text,text\)[\s\S]*from service_role[\s\S]*examEntryInvitesReady[\s\S]*'false'[\s\S]*ready[\s\S]*'false'[\s\S]*rollback;/i,
        );
        expect(boundaryLive).toMatch(
            /rollback;[\s\S]*examEntryInvitesReady[\s\S]*'true'[\s\S]*ready[\s\S]*'true'[\s\S]*recovered/i,
        );
    });
});
