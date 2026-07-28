import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function read(relativePath: string): string {
    return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function readOptional(relativePath: string): string {
    const absolutePath = path.join(rootDir, relativePath);
    return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
}

const canonicalTables = [
    "omr_organizations",
    "omr_plan_usage",
    "omr_plan_usage_reservations",
    "omr_user_profiles",
    "omr_organization_members",
    "omr_teacher_profiles",
    "omr_student_profiles",
    "omr_student_start_credentials",
    "omr_classes",
    "omr_roster_invites",
    "omr_class_teachers",
    "omr_class_students",
    "omr_materials",
    "omr_exams",
    "omr_exam_questions",
    "omr_exam_materials",
    "omr_assignments",
    "omr_assignment_targets",
    "omr_attempts",
    "omr_question_results",
    "omr_assignment_submissions",
    "omr_attempt_feedback",
    "omr_kakao_candidate_reviews",
    "omr_kakao_dispatch_logs",
    "omr_comments",
    "omr_audit_logs",
    "omr_remote_assets",
] as const;

function createdPolicies(sql: string): Array<{ name: string; table: string }> {
    return [...sql.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+public\.([a-z0-9_]+)/gi)]
        .map(match => ({ name: match[1], table: match[2] }));
}

function discoveredPublicAppTables(): string[] {
    const migrationDir = path.join(rootDir, "supabase/migrations");
    const sources = [
        read("supabase/schema.sql"),
        ...readdirSync(migrationDir)
            .filter(name => name.endsWith(".sql"))
            .sort()
            .map(name => read(`supabase/migrations/${name}`)),
    ];
    return [...new Set(
        sources.flatMap(sql => [...sql.matchAll(
            /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(omr_[a-z0-9_]+)/gi,
        )].map(match => match[1])),
    )].sort();
}

describe("production server-only database boundary", () => {
    const profile = readOptional("supabase/production-server-boundary.sql");
    const schema = read("supabase/schema.sql");
    const legacyProductionProfile = read("supabase/production-rls.sql");
    const livePrelude = read("supabase/live-test-prelude.sql");
    const verifier = read("scripts/verify-supabase-live.mjs");
    const liveAssertions = read("supabase/live-test-assertions.sql");
    const supabaseReadme = read("supabase/README.md");
    const productionReadiness = read("docs/production-readiness.md");
    const ci = read(".github/workflows/ci.yml");

    it("runs the organization preflight before atomically closing every public app surface", () => {
        expect(profile).not.toBe("");
        const beginIndex = profile.search(/\bbegin\s*;/i);
        expect(beginIndex).toBeGreaterThan(-1);
        expect(profile).toMatch(/commit\s*;\s*$/i);

        const preflightIndex = profile.indexOf("select public.omr_assert_production_boundary_preflight_v1();");
        const firstRevokeIndex = profile.search(/\brevoke\b/i);
        const firstAlterIndex = profile.search(/\balter table\b/i);
        expect(preflightIndex).toBeGreaterThan(-1);
        expect(firstRevokeIndex).toBeGreaterThan(preflightIndex);
        expect(firstAlterIndex).toBeGreaterThan(preflightIndex);

        expect(profile).toMatch(
            /revoke all on all tables in schema public from public, anon, authenticated;/i,
        );
        expect(profile).toMatch(
            /revoke all on all sequences in schema public from public, anon, authenticated;/i,
        );
        expect(profile).toMatch(
            /revoke all on all functions in schema public from public, anon, authenticated;/i,
        );
        expect(profile).toMatch(/grant all on all tables in schema public to service_role;/i);
        expect(profile).toMatch(/grant all on all sequences in schema public to service_role;/i);
        expect(profile).toMatch(/grant all on all functions in schema public to service_role;/i);

        expect([...canonicalTables].sort()).toEqual(discoveredPublicAppTables());
        for (const table of canonicalTables) {
            expect(profile, `${table} must ENABLE RLS`).toMatch(
                new RegExp(`alter table(?: if exists)? public\\.${table} enable row level security;`, "i"),
            );
            expect(profile, `${table} must FORCE RLS`).toMatch(
                new RegExp(`alter table(?: if exists)? public\\.${table} force row level security;`, "i"),
            );
        }
    });

    it("removes every known alpha and browser-auth policy by explicit name", () => {
        const browserPolicies = [
            ...createdPolicies(schema),
            ...createdPolicies(legacyProductionProfile),
        ];
        expect(browserPolicies.length).toBeGreaterThan(60);

        for (const policy of browserPolicies) {
            expect(profile, `missing explicit drop for ${policy.name}`).toContain(
                `drop policy if exists "${policy.name}" on public.${policy.table};`,
            );
        }

        expect(profile).not.toMatch(/\bcreate\s+policy\b[\s\S]{0,160}\bon\s+public\./i);
    });

    it("applies migrations, the server-only profile, and assertions in release-gate order", () => {
        const migrationIndex = verifier.indexOf("for (const migration of migrations)");
        const profileIndex = verifier.indexOf('psqlFile("supabase/production-server-boundary.sql")');
        const assertionsIndex = verifier.indexOf('psqlFile("supabase/live-test-assertions.sql")');

        expect(migrationIndex).toBeGreaterThan(-1);
        expect(profileIndex).toBeGreaterThan(migrationIndex);
        expect(assertionsIndex).toBeGreaterThan(profileIndex);
        expect(verifier).not.toContain('psqlFile("supabase/production-rls.sql")');
        expect(ci).toContain("supabase-live-contract:");
        expect(ci).toContain("node scripts/verify-supabase-live.mjs");
    });

    it("proves exhaustive browser denial while retaining service-role execution and documents the gate", () => {
        expect(liveAssertions).not.toMatch(
            /grant\s+(?:select|insert|update|delete|all)[\s\S]{0,100}\bto\s+(?:anon|authenticated)\b/i,
        );
        expect(liveAssertions).toContain("browser roles unexpectedly retain an OMR table privilege");
        expect(liveAssertions).toContain("browser roles unexpectedly retain an OMR sequence privilege");
        expect(liveAssertions).toContain("browser roles unexpectedly retain a public function privilege");
        expect(liveAssertions).toContain("service_role lost a public function execute privilege");
        expect(liveAssertions).toContain("production server boundary left an alpha or browser policy");
        expect(liveAssertions).toContain("production server boundary must ENABLE and FORCE RLS");
        expect(liveAssertions).toContain("authenticated SELECT unexpectedly reached canonical tables");
        expect(liveAssertions).toContain("anon DELETE unexpectedly reached canonical tables");

        for (const document of [supabaseReadme, productionReadiness]) {
            expect(document).toContain("production-server-boundary.sql");
            expect(document).toContain("omr_assert_production_boundary_preflight_v1");
            expect(document).toContain("npm run test:supabase:live");
            expect(document).toMatch(/schema\.sql[\s\S]*migrations[\s\S]*production-server-boundary\.sql[\s\S]*live-test-assertions\.sql/i);
        }
        expect(productionReadiness).toContain("CI");
        expect(productionReadiness).toContain("커밋 SHA");
        expect(productionReadiness).toContain("정책 해시");
    });

    it("treats the legacy assignment-submission update as an expected denial without mutation", () => {
        expect(liveAssertions).toMatch(
            /set role authenticated;[\s\S]*?begin\s+begin\s+update public\.omr_assignment_submissions[\s\S]*?raise exception 'authenticated assignment submission UPDATE unexpectedly succeeded';\s+exception when insufficient_privilege then null;\s+end;/i,
        );
        expect(liveAssertions).toContain(
            "authenticated assignment submission denial mutated canonical gradebook row",
        );
    });

    it("uses the hosted Storage owner to install restrictive target-bucket policies without managed ACL mutations", () => {
        expect(livePrelude).toContain("create role supabase_storage_admin");
        expect(livePrelude).toContain("grant supabase_storage_admin to postgres with set true");
        expect(livePrelude).toContain("create table if not exists storage.objects");
        expect(livePrelude).toContain("alter table storage.objects owner to supabase_storage_admin");
        expect(livePrelude).toContain("alter table storage.buckets owner to supabase_storage_admin");
        expect(livePrelude).toContain('create policy "OMR private assets alpha access"');
        expect(livePrelude).toContain('create policy "Third-party browser object access"');
        expect(livePrelude).toContain('create policy "Third-party browser bucket access"');

        expect(profile).toMatch(
            /pg_has_role\(\s*session_user,\s*'supabase_storage_admin',\s*'SET'\s*\)/i,
        );
        expect(profile).toContain("set local role supabase_storage_admin");
        const storageOwnerIndex = profile.indexOf("set local role supabase_storage_admin");
        const resetRoleIndex = profile.indexOf("reset role;", storageOwnerIndex);
        const publicRevokeIndex = profile.indexOf(
            "revoke all on schema public from public, anon, authenticated;",
        );
        expect(resetRoleIndex).toBeGreaterThan(storageOwnerIndex);
        expect(publicRevokeIndex).toBeGreaterThan(resetRoleIndex);
        expect(profile).toContain(
            'drop policy if exists "OMR private assets alpha access" on storage.objects',
        );
        expect(profile).toMatch(
            /create policy "OMR private assets server-only objects"\s+on storage\.objects\s+as restrictive\s+for all\s+to anon, authenticated\s+using \(bucket_id <> 'omr-private-assets'\)\s+with check \(bucket_id <> 'omr-private-assets'\);/i,
        );
        expect(profile).toMatch(
            /create policy "OMR private assets server-only buckets"\s+on storage\.buckets\s+as restrictive\s+for all\s+to anon, authenticated\s+using \(id <> 'omr-private-assets'\)\s+with check \(id <> 'omr-private-assets'\);/i,
        );
        expect(profile).toContain("reset role;");
        expect(profile).not.toMatch(
            /\b(?:revoke|grant)\b[^;]*\bon\s+(?:table\s+)?storage\.(?:objects|buckets)\b/i,
        );
        expect(profile).not.toMatch(
            /\balter\s+table\s+storage\.(?:objects|buckets)\s+owner\s+to\b/i,
        );
        expect(profile).not.toMatch(/\bpolicyname\s+ilike\b/i);
        expect(profile).not.toContain("for app_policy in");

        expect(liveAssertions).toContain("Storage relation owner drifted from supabase_storage_admin");
        expect(liveAssertions).toContain("OMR restrictive Storage policy contract mismatch");
        expect(liveAssertions).toContain("unrelated third-party Storage policy was changed");
        expect(liveAssertions).toContain("anon target Storage SELECT unexpectedly succeeded");
        expect(liveAssertions).toContain("authenticated target Storage DELETE unexpectedly succeeded");
        expect(liveAssertions).toContain("other-bucket Storage policy no longer permits browser access");
        expect(liveAssertions).toContain("service_role Storage CRUD probe failed");

        for (const document of [supabaseReadme, productionReadiness]) {
            expect(document).toContain("supabase_storage_admin");
            expect(document).toContain("storage.objects");
            expect(document).toMatch(/AS RESTRICTIVE|제한 정책/i);
            expect(document).toContain("https://supabase.com/docs/guides/platform/permissions");
            expect(document).toContain("https://supabase.com/docs/guides/storage/security/access-control");
        }
    });

    it("pins migrations and default privileges to postgres and proves future functions stay server-only", () => {
        expect(verifier).toContain('const migrationOwner = "postgres"');
        expect(verifier).toContain('"psql", "-U", migrationOwner');

        expect(profile).toContain("current_user is distinct from 'postgres'");
        expect(profile).toContain("production boundary must run as migration owner postgres");
        expect(profile).toMatch(
            /alter default privileges for role postgres\s+revoke execute on functions from public;/i,
        );
        expect(profile).toMatch(
            /alter default privileges for role postgres in schema public\s+revoke all on functions from anon, authenticated;/i,
        );
        expect(profile).toMatch(
            /alter default privileges for role postgres in schema public\s+grant all on functions to service_role;/i,
        );

        expect(liveAssertions).toContain("pg_default_acl retained PUBLIC function execute");
        expect(liveAssertions).toContain("pg_default_acl lost service_role public function execute");
        expect(liveAssertions).toContain("omr_default_acl_probe_v1");
        expect(liveAssertions).toContain("browser role executed a default-ACL probe function");
        expect(liveAssertions).toContain("service_role could not execute the default-ACL probe function");

        for (const document of [supabaseReadme, productionReadiness]) {
            expect(document).toContain("postgres");
            expect(document).toMatch(/single migration owner|단일 migration owner/i);
        }
    });
});
