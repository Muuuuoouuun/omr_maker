import { inspectTeacherAuthConfig } from "./teacherAuth";
import { resolveTeacherSessionSecret } from "./teacherServerSession";
import { resolveStudentSessionSecret } from "./studentServerSession";
import { getSupabaseServerConfigFromEnv } from "./supabaseServerAdmin";

type Env = Record<string, string | undefined>;

export type DeploymentReadinessTone = "ready" | "warning" | "error";

export interface DeploymentReadinessCheck {
    key: string;
    label: string;
    detail: string;
    tone: DeploymentReadinessTone;
}

export interface DeploymentReadinessSummary {
    label: string;
    detail: string;
    credentialCount: number;
    readyCount: number;
    totalCount: number;
    checks: DeploymentReadinessCheck[];
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function publicSupabaseConfigured(env: Env): boolean {
    const url = clean(env.NEXT_PUBLIC_SUPABASE_URL);
    const key = clean(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) || clean(env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    return !!(url && key);
}

function describeIssues(issues: { label: string; detail: string }[]): string {
    if (issues.length === 0) return "";
    return issues.map(issue => `${issue.label}: ${issue.detail}`).join(" ");
}

function sessionSecretCheck(env: Env): DeploymentReadinessCheck {
    const explicitSecret = clean(env.TEACHER_SESSION_SECRET) || clean(env.OMR_TEACHER_SESSION_SECRET);
    const resolvedSecret = resolveTeacherSessionSecret(env);

    if (explicitSecret) {
        return {
            key: "teacher_session_secret",
            label: "교사 세션 secret",
            detail: "TEACHER_SESSION_SECRET 또는 OMR_TEACHER_SESSION_SECRET이 설정되어 서버 보호 쿠키를 안정적으로 서명합니다.",
            tone: "ready",
        };
    }

    if (resolvedSecret) {
        return {
            key: "teacher_session_secret",
            label: "교사 세션 secret",
            detail: "현재는 교사 비밀번호 또는 계정 JSON을 쿠키 서명 secret으로 사용합니다. 비밀번호 교체 때 세션이 모두 만료되므로 운영에서는 별도 TEACHER_SESSION_SECRET을 권장합니다.",
            tone: "warning",
        };
    }

    return {
        key: "teacher_session_secret",
        label: "교사 세션 secret",
        detail: "서버 보호 쿠키를 서명할 secret이 없습니다. 운영 배포에는 TEACHER_SESSION_SECRET을 설정하세요.",
        tone: "error",
    };
}

function studentSessionSecretCheck(env: Env): DeploymentReadinessCheck {
    const explicitSecret = clean(env.STUDENT_SESSION_SECRET) || clean(env.OMR_STUDENT_SESSION_SECRET);
    const resolvedSecret = resolveStudentSessionSecret(env);

    if (explicitSecret) {
        return {
            key: "student_session_secret",
            label: "학생 세션 secret",
            detail: "STUDENT_SESSION_SECRET 또는 OMR_STUDENT_SESSION_SECRET이 설정되어 학생·게스트 본인 확인 쿠키를 서명합니다.",
            tone: "ready",
        };
    }

    if (resolvedSecret) {
        return {
            key: "student_session_secret",
            label: "학생 세션 secret",
            detail: "개발용 학생 세션 secret을 사용 중입니다. 운영 배포에서는 별도 STUDENT_SESSION_SECRET을 설정해야 합니다.",
            tone: "warning",
        };
    }

    return {
        key: "student_session_secret",
        label: "학생 세션 secret",
        detail: "학생·게스트 서버 세션을 서명할 secret이 없습니다. 운영 배포에는 STUDENT_SESSION_SECRET을 설정하세요.",
        tone: "error",
    };
}

function isFlagEnabled(value: unknown): boolean {
    const normalized = clean(value).toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}

function productionRlsCheck(env: Env, supabasePublicReady: boolean): DeploymentReadinessCheck {
    const rlsApplied = isFlagEnabled(env.OMR_PRODUCTION_RLS_APPLIED);
    const isProduction = clean(env.NODE_ENV).toLowerCase() === "production";

    if (rlsApplied) {
        return {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: "OMR_PRODUCTION_RLS_APPLIED로 production-rls.sql 적용이 확인됐습니다. 조직 멤버십과 학생 PII 접근이 서버 정책으로 잠깁니다.",
            tone: "ready",
        };
    }

    // Production + remote sync but no confirmation that PII tables are locked down is the
    // dangerous state: student email/phone/guardian_contact would sit under the open alpha
    // RLS (schema.sql). Escalate to a hard error so real data is not stored on public policies.
    if (isProduction && supabasePublicReady) {
        return {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: "프로덕션에서 Supabase 원격 저장이 켜져 있는데 production-rls.sql 적용이 확인되지 않았습니다. 지금은 학생 이메일·전화·보호자 연락처가 공개 alpha RLS로 노출될 수 있습니다. production-rls.sql을 적용한 뒤 OMR_PRODUCTION_RLS_APPLIED=true를 설정하세요.",
            tone: "error",
        };
    }

    return {
        key: "production_rls",
        label: "실사용 RLS 전환",
        detail: "실제 학생 데이터를 저장하기 전 Supabase Auth, 조직 멤버십, production-rls.sql 적용 여부를 확인하고 OMR_PRODUCTION_RLS_APPLIED=true로 표시하세요.",
        tone: "warning",
    };
}

export function buildDeploymentReadiness(env: Env = process.env): DeploymentReadinessSummary {
    const authConfig = inspectTeacherAuthConfig(env);
    const supabasePublicReady = publicSupabaseConfigured(env);
    const serviceRoleReady = !!getSupabaseServerConfigFromEnv(env);

    const checks: DeploymentReadinessCheck[] = [
        {
            key: "teacher_credentials",
            label: "교사 계정 환경변수",
            detail: authConfig.ready
                ? `${authConfig.credentialCount}개 교사 계정이 서버 환경변수에서 인식됩니다. 로그인 판별은 Supabase가 아니라 이 값으로 수행됩니다.`
                : describeIssues(authConfig.issues) || "운영 배포에는 TEACHER_ACCOUNTS 또는 TEACHER_LOGIN_ID/TEACHER_PASSWORD가 필요합니다.",
            tone: authConfig.ready ? "ready" : "error",
        },
        sessionSecretCheck(env),
        studentSessionSecretCheck(env),
        {
            key: "supabase_public_sync",
            label: "Supabase 클라이언트 동기화",
            detail: supabasePublicReady
                ? "NEXT_PUBLIC_SUPABASE_URL과 publishable/anon key가 있어 시험·제출·명단 원격 동기화가 활성화됩니다."
                : "Supabase public env가 없으면 브라우저 로컬 저장으로만 동작합니다. 배포 공유 데이터가 필요하면 NEXT_PUBLIC_SUPABASE_URL과 publishable key를 설정하세요.",
            tone: supabasePublicReady ? "ready" : "warning",
        },
        {
            key: "supabase_service_role",
            label: "서버 신뢰 경계 (service role)",
            detail: serviceRoleReady
                ? "SUPABASE_SERVICE_ROLE_KEY 또는 OMR_SUPABASE_SERVICE_ROLE_KEY가 서버에 있어 학생 시험 로드(정답 미노출)·서버 채점·본인 격리 조회와 워크스페이스 bootstrap이 활성화됩니다."
                : env.NODE_ENV === "production" && supabasePublicReady
                    ? "서비스롤 키가 없어 학생 서버 경계(정답 은닉·서버 채점)가 전부 클라이언트 폴백으로 동작합니다. 운영 배포 전 SUPABASE_SERVICE_ROLE_KEY를 서버 환경변수에 설정하세요."
                    : "서비스롤 키가 없으면 학생 시험 로드/채점 서버 경계와 워크스페이스 bootstrap이 로컬 폴백으로 degrade됩니다. 키는 서버 환경변수에만 둬야 합니다.",
            tone: serviceRoleReady
                ? "ready"
                : env.NODE_ENV === "production" && supabasePublicReady
                    ? "error"
                    : "warning",
        },
        productionRlsCheck(env, supabasePublicReady),
    ];

    const readyCount = checks.filter(check => check.tone === "ready").length;
    const hasError = checks.some(check => check.tone === "error");
    const hasWarning = checks.some(check => check.tone === "warning");

    return {
        label: hasError ? "배포 확인 필요" : hasWarning ? "배포 보강 권장" : "배포 준비됨",
        detail: hasError
            ? "교사 계정 또는 서버 세션 설정을 먼저 고쳐야 합니다."
            : hasWarning
                ? "핵심 흐름은 실행 가능하지만 운영 데이터 전에는 남은 보안/DB 항목을 확인하세요."
                : "교사 계정, 세션, Supabase 동기화 항목이 모두 준비됐습니다.",
        credentialCount: authConfig.credentialCount,
        readyCount,
        totalCount: checks.length,
        checks,
    };
}
