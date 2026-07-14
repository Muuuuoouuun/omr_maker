import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

describe("persistence integration", () => {
    it("solve page does not shadow the shared exam loader", () => {
        const source = readProjectFile("src/app/solve/[id]/page.tsx");

        expect(source).not.toMatch(/const\s+loadExam\s*=\s*async/);
    });

    it("primary read screens use the shared persistence layer", () => {
        // Teacher exam (B1) and attempt (B2) reads/writes go through the
        // server-first teacher layers (teacherExamClient / teacherAttemptClient).
        // Student screens keep the local omrPersistence path as their offline
        // fallback under the student server boundary.
        const screens = [
            { file: "src/app/teacher/dashboard/page.tsx", imports: ["@/lib/teacherExamClient", "@/lib/teacherAttemptClient"], functions: ["loadTeacherExams", "loadTeacherAttempts"] },
            { file: "src/app/student/dashboard/page.tsx", imports: ["@/lib/omrPersistence"], functions: ["loadExams", "loadAttempts"] },
            { file: "src/app/student/history/page.tsx", imports: ["@/lib/omrPersistence"], functions: ["loadAttempts"] },
            { file: "src/app/student/review/[attemptId]/page.tsx", imports: ["@/lib/omrPersistence"], functions: ["loadAttempt", "loadExam"] },
            { file: "src/app/teacher/exam/[id]/page.tsx", imports: ["@/lib/teacherExamClient", "@/lib/teacherAttemptClient"], functions: ["loadTeacherExam", "loadTeacherAttempts"] },
            { file: "src/app/teacher/attempt/[attemptId]/page.tsx", imports: ["@/lib/teacherAttemptClient", "@/lib/teacherExamClient"], functions: ["loadTeacherAttempt", "loadTeacherExam"] },
            { file: "src/app/teacher/live/page.tsx", imports: ["@/lib/teacherExamClient", "@/lib/teacherAttemptClient"], functions: ["loadTeacherExams", "loadTeacherAttempts"] },
        ];

        for (const screen of screens) {
            const source = readProjectFile(screen.file);
            for (const importPath of screen.imports) {
                expect(source, `${screen.file} should import ${importPath}`).toContain(importPath);
            }
            for (const fn of screen.functions) {
                expect(source, `${screen.file} should use ${fn}`).toContain(fn);
            }
        }
    });

    it("teacher user management uses the server-first roster layer instead of local-only writes", () => {
        const source = readProjectFile("src/app/teacher/users/page.tsx");

        // Roster read/write goes through the org-scoped teacher server layer (B3).
        expect(source).toContain("@/lib/teacherRosterClient");
        expect(source).toContain("loadTeacherRoster");
        expect(source).toContain("saveTeacherRoster");
        expect(source).toContain("persistRoster(");
    });

    it("teacher analytics loads roster data through the server-first roster layer", () => {
        const source = readProjectFile("src/app/teacher/dashboard/page.tsx");

        expect(source).toContain("@/lib/teacherRosterClient");
        expect(source).toContain("loadTeacherRoster(localStorage)");
        expect(source).toContain("summarizePersistenceHealth([examResult, attemptResult, rosterResult])");
        expect(source).not.toContain("readRosterStudents(localStorage)");
        expect(source).not.toContain("readRosterGroups(localStorage)");
    });

    it("teacher settings checks exam, attempt, roster, and deletion persistence together", () => {
        const source = readProjectFile("src/app/teacher/settings/page.tsx");

        expect(source).toContain("@/lib/teacherExamClient");
        expect(source).toContain("@/lib/teacherAttemptClient");
        expect(source).toContain("@/lib/teacherRosterClient");
        expect(source).toContain("@/lib/rosterPersistence");
        expect(source).toContain("@/lib/dataDbReadiness");
        expect(source).toContain("Promise.all");
        expect(source).toContain("loadTeacherExams()");
        expect(source).toContain("loadTeacherAttempts()");
        expect(source).toContain("loadTeacherRoster(window.localStorage)");
        expect(source).toContain("readRosterTombstones(window.localStorage)");
        expect(source).toContain('sourceKey: "exams"');
        expect(source).toContain('sourceLabel: "시험"');
        expect(source).toContain('sourceKey: "attempts"');
        expect(source).toContain('sourceLabel: "제출"');
        expect(source).toContain('sourceKey: "roster"');
        expect(source).toContain('sourceLabel: "명단"');
    });

    it("teacher management surfaces are behind the teacher auth gate", () => {
        const teacherLayout = readProjectFile("src/app/teacher/layout.tsx");
        const teacherAuthGate = readProjectFile("src/components/TeacherAuthGate.tsx");
        const createPage = readProjectFile("src/app/create/page.tsx");
        const createLayout = readProjectFile("src/app/create/layout.tsx");
        const groupsPage = readProjectFile("src/app/groups/page.tsx");

        expect(teacherLayout).toContain("TeacherAuthGate");
        expect(teacherLayout).toContain("parseSignedTeacherSessionCookie");
        expect(teacherLayout).toContain("TEACHER_SERVER_SESSION_COOKIE");
        expect(teacherLayout).toContain("bootstrapWorkspaceWithServiceRole");
        expect(teacherLayout).toContain("workspaceContextFromTeacherSession(serverSession)");
        expect(teacherLayout).toContain("initialSession={serverSession}");
        expect(teacherLayout).toContain("requireServerSession");
        expect(createLayout).toContain("parseSignedTeacherSessionCookie");
        expect(createLayout).toContain("requireServerSession");
        expect(createLayout).toContain("bootstrapWorkspaceWithServiceRole");
        expect(createLayout).toContain("workspaceContextFromTeacherSession(serverSession)");
        expect(createLayout).toContain("TeacherAuthGate");
        expect(createLayout).toContain("initialSession={serverSession}");
        expect(teacherAuthGate).toContain("readTeacherSession");
        expect(teacherAuthGate).toContain("saveTeacherSessionSnapshot");
        expect(teacherAuthGate).toContain("teacherSessionRemainingMs");
        expect(teacherAuthGate).toContain("visibilitychange");
        expect(teacherAuthGate).toContain('window.addEventListener("focus"');
        expect(createPage).not.toContain("<TeacherAuthGate>");
        expect(groupsPage).toContain('router.replace("/teacher/users?tab=groups")');
    });

    it("security settings expose real session controls instead of a fake password form", () => {
        const source = readProjectFile("src/app/teacher/settings/page.tsx");
        const teacherSession = readProjectFile("src/lib/teacherSession.ts");

        expect(source).toContain("TEACHER_ACCOUNTS");
        expect(source).toContain("clearTeacherAuthSession");
        expect(source).toContain("clearTeacherSession");
        expect(source).toContain("buildTeacherSessionDisplay");
        expect(source).toContain("운영 보안 점검");
        expect(source).toContain("HttpOnly 서명 쿠키");
        expect(source).toContain("5회 이후 10분");
        expect(source).toContain("Supabase Auth, 조직 멤버십, production-rls.sql 정책");
        expect(teacherSession).toContain("만료 시각");
        expect(source).toContain("세션 종료");
        expect(source).not.toContain('placeholder="현재 비밀번호"');
        expect(source).not.toContain('placeholder="새 비밀번호"');
        expect(source).not.toContain('placeholder="새 비밀번호 확인"');
    });

    it("teacher login action throttles repeated credential failures", () => {
        const source = readProjectFile("src/app/actions/auth.ts");
        const limiter = readProjectFile("src/lib/teacherLoginRateLimit.ts");

        expect(source).toContain("buildTeacherLoginRateLimitKeys");
        expect(source).toContain("checkTeacherLoginRateLimit");
        expect(source).toContain("recordTeacherLoginFailure");
        expect(source).toContain("recordTeacherLoginSuccess");
        expect(source).toContain("TEACHER_LOGIN_RATE_LIMIT_ERROR");
        expect(source).toContain("clientFingerprintFromHeaders");
        expect(source).toContain("bootstrapWorkspaceWithServiceRole");
        expect(source).toContain("workspaceContextFromIdentity(result.teacher)");
        expect(limiter).toContain("TEACHER_LOGIN_MAX_FAILURES");
        expect(limiter).toContain("TEACHER_LOGIN_LOCKOUT_MS");
        expect(limiter).toContain("teacher-login:client");
    });

    it("Supabase schema includes alpha organization boundaries", () => {
        const schema = readProjectFile("supabase/schema.sql");

        expect(schema).toContain("create table if not exists public.omr_organizations");
        expect(schema).toContain("create table if not exists public.omr_organization_members");
        expect(schema).toContain("create table if not exists public.omr_classes");
        expect(schema).toContain("create table if not exists public.omr_audit_logs");
        expect(schema).toContain("check (plan in ('free', 'pro', 'academy'))");
        expect(schema).toContain("set plan = 'academy'");
        expect(schema).toContain("where plan = 'school'");
        expect(schema).not.toContain("check (plan in ('free', 'pro', 'school'))");
        expect(schema).toContain("organization_id text");
        expect(schema).toContain("class_id text");
    });

    it("Supabase schema models users, rosters, materials, assignments, and feedback", () => {
        const schema = readProjectFile("supabase/schema.sql");
        const expectedTables = [
            "public.omr_user_profiles",
            "public.omr_teacher_profiles",
            "public.omr_student_profiles",
            "public.omr_class_teachers",
            "public.omr_class_students",
            "public.omr_materials",
            "public.omr_exam_materials",
            "public.omr_exam_questions",
            "public.omr_assignments",
            "public.omr_assignment_targets",
            "public.omr_question_results",
            "public.omr_assignment_submissions",
            "public.omr_kakao_candidate_reviews",
            "public.omr_kakao_dispatch_logs",
            "public.omr_comments",
        ];

        for (const table of expectedTables) {
            expect(schema, `${table} table`).toContain(`create table if not exists ${table}`);
            expect(schema, `${table} RLS`).toContain(`alter table ${table} enable row level security`);
        }

        expect(schema).toContain("assignment_id text");
        expect(schema).toContain("student_profile_id text");
        expect(schema).toContain("storage_bucket text");
        expect(schema).toContain("storage_path text");
        expect(schema).toContain("target_type text not null");
        expect(schema).toContain("entity_type text not null");
        expect(schema).toContain("create table if not exists public.omr_exam_questions");
        expect(schema).toContain("canonical_question_id text not null");
        expect(schema).toContain("has_pdf_region boolean not null default false");
        expect(schema).toContain("attempt_id text not null references public.omr_attempts(id) on delete cascade");
        expect(schema).toContain("identity_type text");
        expect(schema).toContain("score_percent numeric not null default 0");
        expect(schema).toContain("retake_source_attempt_id text");
        expect(schema).toContain("retake_question_ids integer[] not null default '{}'::integer[]");
        expect(schema).toContain("candidate_kind text not null");
        expect(schema).toContain("check (candidate_kind in ('missing_exam', 'retake_recommendation', 'class_retake_recommendation'))");
        expect(schema).toContain("check (status in ('ready', 'hold', 'excluded'))");
        expect(schema).toContain("provider_message_id text");
        expect(schema).toContain("payload #>> '{retake,sourceAttemptId}'");
        expect(schema).toContain("score_percent = round((score / total_score) * 100)");
        expect(schema).toContain("question_id integer not null");
        expect(schema).toContain("expected_time_sec integer");
        expect(schema).toContain("status text not null");
        expect(schema).toContain("check (role in ('owner', 'admin', 'teacher', 'assistant', 'viewer'))");
        expect(schema).toContain("check (material_type in ('problem_pdf', 'answer_key', 'solution', 'worksheet', 'image', 'video', 'link', 'note', 'other'))");
        expect(schema).toContain("omr_exam_questions_exam_idx");
        expect(schema).toContain("omr_exam_questions_canonical_idx");
        expect(schema).toContain("omr_exam_questions_mistake_types_idx");
        expect(schema).toContain("omr_exam_questions_pdf_region_idx");
        expect(schema).toContain("omr_attempts_exam_status_idx");
        expect(schema).toContain("omr_attempts_retake_idx");
        expect(schema).toContain("omr_question_results_exam_question_idx");
        expect(schema).toContain("omr_question_results_canonical_idx");
        expect(schema).toContain("omr_question_results_concept_idx");
        expect(schema).toContain("omr_question_results_option_idx");
        expect(schema).toContain("omr_question_results_mistake_types_idx");
        expect(schema).toContain("omr_question_results_retake_idx");
        expect(schema).toContain("omr_assignment_submissions_student_idx");
        expect(schema).toContain("omr_kakao_candidate_reviews_exam_status_idx");
        expect(schema).toContain("omr_kakao_candidate_reviews_student_ids_idx");
        expect(schema).toContain("omr_kakao_dispatch_logs_status_idx");
        expect(schema).toContain("omr_materials_org_owner_idx");
    });

    it("Supabase docs warn that alpha RLS is open", () => {
        const docs = readProjectFile("supabase/README.md");

        expect(docs).toContain("alpha/local testing");
        expect(docs).toContain("real student data");
        expect(docs).toContain("Supabase Auth");
        expect(docs).toContain("Canonical organization plans are `free`, `pro`, and `academy`");
        expect(docs).toContain("Older `school` rows are migrated to `academy`");
        expect(docs).toContain("omr_kakao_candidate_reviews");
        expect(docs).toContain("omr_kakao_dispatch_logs");
    });

    it("threads active workspace context into Supabase persistence rows", () => {
        const workspaceContext = readProjectFile("src/lib/workspaceContext.ts");
        const persistence = readProjectFile("src/lib/omrPersistence.ts");
        const rosterPersistence = readProjectFile("src/lib/rosterPersistence.ts");
        const docs = readProjectFile("docs/account-security-usability-checklist.md");

        expect(workspaceContext).toContain("workspaceContextFromIdentity");
        expect(workspaceContext).toContain("workspaceBootstrapRows");
        expect(workspaceContext).toContain("teacher_${hash}");
        expect(workspaceContext).toContain("DEFAULT_WORKSPACE_ORGANIZATION_ID");
        expect(persistence).toContain("examWithPersistenceContext");
        expect(persistence).toContain("attemptWithPersistenceContext");
        expect(persistence).toContain("upsertRemoteWorkspaceBootstrap");
        expect(persistence).toContain("organization_id: scopedValue(exam.organizationId) || contextOrganizationId(context)");
        expect(persistence).toContain("created_by_user_id: scopedValue(exam.createdByUserId) || contextActorUserId(context)");
        expect(persistence).toContain("questionResultRowsForAttempt(scopedAttempt, undefined, context)");
        expect(rosterPersistence).toContain("activeRosterOrganizationId");
        expect(rosterPersistence).toContain("readActiveWorkspaceContext");
        expect(rosterPersistence).toContain("workspaceBootstrapRows(context)");
        expect(docs).toContain("interim `teacher_<hash>` organization/user scope");
        expect(docs).toContain("bootstrap matching organization, user profile, organization member, and teacher profile rows");
    });

    it("configured Supabase failures surface as sync errors instead of silent local success", () => {
        const source = readProjectFile("src/lib/omrPersistence.ts");

        expect(source).toContain("async function getAvailableSupabaseClient");
        expect(source).toContain('throw new Error("Supabase client unavailable")');
        expect(source).toContain("const client = await getAvailableSupabaseClient();");
    });
});
