import { inspectTeacherAuthConfig } from "./teacherAuth";
import { resolveTeacherSessionSecret } from "./teacherServerSession";
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
            label: "서버 워크스페이스 bootstrap",
            detail: serviceRoleReady
                ? "SUPABASE_SERVICE_ROLE_KEY 또는 OMR_SUPABASE_SERVICE_ROLE_KEY가 서버에 있어 교사 로그인 때 조직·멤버·프로필을 준비할 수 있습니다."
                : "서비스롤 키가 없으면 로그인은 가능하지만 서버 워크스페이스 bootstrap은 건너뜁니다. 키는 서버 환경변수에만 둬야 합니다.",
            tone: serviceRoleReady ? "ready" : "warning",
        },
        {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: "실제 학생 데이터를 저장하기 전 Supabase Auth, 조직 멤버십, production-rls.sql 적용 여부를 Supabase 대시보드에서 확인해야 합니다.",
            tone: "warning",
        },
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
