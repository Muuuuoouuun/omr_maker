import { inspectTeacherAuthConfig } from "./teacherAuth";
import { resolveTeacherSessionSecret } from "./teacherServerSession";
import { resolveStudentSessionSecret } from "./studentServerSession";
import { getSupabaseServerConfigFromEnv } from "./supabaseServerAdmin";
import { resolveStudentAttemptSecret } from "./studentAttemptTicket";
import type { SupabaseDeploymentProbe } from "./supabaseReadinessProbe";

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

function canonicalBrowserBoundaryCheck(
    env: Env,
    hasPublicSupabase: boolean,
): DeploymentReadinessCheck {
    const isProduction = clean(env.NODE_ENV).toLowerCase() === "production";
    if (isProduction) {
        return {
            key: "canonical_browser_boundary",
            label: "운영 브라우저 데이터 경계",
            detail: hasPublicSupabase
                ? "publishable key가 설정되어 있어도 운영 브라우저 canonical CRUD는 비활성입니다. 공식 데이터는 Supabase 서버 게이트웨이만 사용합니다."
                : "운영 브라우저 canonical CRUD는 비활성입니다. 공식 데이터는 Supabase 서버 게이트웨이만 사용합니다.",
            tone: "ready",
        };
    }
    return {
        key: "canonical_browser_boundary",
        label: "브라우저 데이터 경계",
        detail: hasPublicSupabase
            ? "개발·테스트 환경에서만 publishable key 기반 canonical 동기화를 사용할 수 있습니다."
            : "공개 Supabase 환경변수가 없어 개발 브라우저 동기화도 비활성입니다.",
        tone: hasPublicSupabase ? "ready" : "warning",
    };
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

function productionRlsCheck(
    env: Env,
    serverGatewayReady: boolean,
    databaseProbe?: SupabaseDeploymentProbe | null,
): DeploymentReadinessCheck {
    const rlsApplied = isFlagEnabled(env.OMR_PRODUCTION_RLS_APPLIED);
    const isProduction = clean(env.NODE_ENV).toLowerCase() === "production";

    if (rlsApplied && databaseProbe?.ready) {
        return {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: `실제 DB probe${databaseProbe.version ? ` ${databaseProbe.version}` : ""}에서 제출 RPC와 핵심 테이블 FORCE RLS 적용을 확인했습니다.`,
            tone: "ready",
        };
    }

    if (isProduction && rlsApplied && !databaseProbe?.ready) {
        return {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: databaseProbe?.error
                ? `환경변수는 적용됨으로 표시하지만 실제 DB probe가 실패했습니다: ${databaseProbe.error}`
                : "OMR_PRODUCTION_RLS_APPLIED는 설정됐지만 실제 DB의 RPC·FORCE RLS 상태가 확인되지 않았습니다.",
            tone: "error",
        };
    }

    if (isProduction && serverGatewayReady) {
        return {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: "Supabase 서버 게이트웨이는 설정됐지만 production-rls.sql 적용이 확인되지 않았습니다. 운영 데이터 저장 전 실제 DB 권한과 FORCE RLS를 검증하세요.",
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

function studentAttemptSecretCheck(env: Env): DeploymentReadinessCheck {
    const explicitSecret = clean(env.STUDENT_ATTEMPT_SECRET) || clean(env.OMR_STUDENT_ATTEMPT_SECRET);
    if (explicitSecret) {
        return {
            key: "student_attempt_secret",
            label: "학생 응시 티켓 secret",
            detail: "학생 응시 티켓을 별도 서버 secret으로 서명해 시험·조직·학생·허용 문항 변조를 차단합니다.",
            tone: "ready",
        };
    }
    return {
        key: "student_attempt_secret",
        label: "학생 응시 티켓 secret",
        detail: resolveStudentAttemptSecret(env)
            ? "개발 기본 secret은 로컬 연습에만 사용할 수 있습니다. 운영에는 STUDENT_ATTEMPT_SECRET을 별도로 설정하세요."
            : "운영 서버 채점에는 STUDENT_ATTEMPT_SECRET 또는 OMR_STUDENT_ATTEMPT_SECRET이 필요합니다.",
        tone: clean(env.NODE_ENV).toLowerCase() === "production" ? "error" : "warning",
    };
}

export function buildDeploymentReadiness(
    env: Env = process.env,
    databaseProbe?: SupabaseDeploymentProbe | null,
): DeploymentReadinessSummary {
    const authConfig = inspectTeacherAuthConfig(env);
    const supabasePublicReady = publicSupabaseConfigured(env);
    const serviceRoleReady = !!getSupabaseServerConfigFromEnv(env);
    const isProduction = clean(env.NODE_ENV).toLowerCase() === "production";
    const teacherCredentialsTone: DeploymentReadinessTone = !authConfig.ready
        ? "error"
        : authConfig.warnings.length > 0
            ? "warning"
            : "ready";

    const checks: DeploymentReadinessCheck[] = [
        {
            key: "teacher_credentials",
            label: "교사 계정 환경변수",
            detail: authConfig.ready
                ? `${authConfig.credentialCount}개 교사 계정이 서버 환경변수에서 인식됩니다. 로그인 판별은 Supabase가 아니라 이 값으로 수행됩니다.${authConfig.warnings.length > 0 ? ` ${describeIssues(authConfig.warnings)}` : ""}`
                : describeIssues(authConfig.issues) || "운영 배포에는 TEACHER_ACCOUNTS 또는 TEACHER_LOGIN_ID/TEACHER_PASSWORD_HASH가 필요합니다.",
            tone: teacherCredentialsTone,
        },
        sessionSecretCheck(env),
        studentSessionSecretCheck(env),
        studentAttemptSecretCheck(env),
        canonicalBrowserBoundaryCheck(env, supabasePublicReady),
        {
            key: "supabase_service_role",
            label: "Supabase 서버 게이트웨이",
            detail: serviceRoleReady
                ? "서비스롤 키가 서버에 있어 정답 제거 시험 제공, 공식 채점, 본인 격리 조회와 원자적 저장 RPC를 실행할 수 있습니다."
                : "서비스롤 키가 없으면 안전한 원격 시험·서버 채점 게이트웨이가 비활성입니다. SUPABASE_SERVICE_ROLE_KEY는 서버 환경변수에만 설정하세요.",
            tone: serviceRoleReady ? "ready" : isProduction ? "error" : "warning",
        },
        productionRlsCheck(env, serviceRoleReady, databaseProbe),
    ];

    const readyCount = checks.filter(check => check.tone === "ready").length;
    const hasError = checks.some(check => check.tone === "error");
    const hasWarning = checks.some(check => check.tone === "warning");

    return {
        label: hasError ? "배포 확인 필요" : hasWarning ? "배포 보강 권장" : "배포 준비됨",
        detail: hasError
            ? "교사 계정, 서버 세션, 학생 티켓, Supabase 서버 게이트웨이 설정을 먼저 고쳐야 합니다."
            : hasWarning
                ? "핵심 흐름은 실행 가능하지만 운영 데이터 전에는 남은 보안/DB 항목을 확인하세요."
                : "교사 계정, 서버 세션, 학생 응시 티켓, 브라우저 데이터 경계, 서버 게이트웨이와 RLS가 모두 준비됐습니다.",
        credentialCount: authConfig.credentialCount,
        readyCount,
        totalCount: checks.length,
        checks,
    };
}
