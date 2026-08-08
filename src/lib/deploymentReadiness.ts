import { inspectTeacherAuthConfig } from "./teacherAuth";
import { resolveTeacherSessionSecret } from "./teacherServerSession";
import { resolveStudentSessionSecret } from "./studentServerSession";
import { getSupabaseServerConfigFromEnv } from "./supabaseServerAdmin";
import { resolveStudentAttemptSecret } from "./studentAttemptTicket";
import { isRemoteAssetCleanupScheduled } from "./remoteAssetCleanup.server";
import { operationalEventSinkConfiguration } from "./operationalEventSink.server";
import { PRODUCTION_SIGNING_SECRET_MIN_BYTES } from "./serverSigningSecret";
import { resolveTeacherAccountDeliveryAdapter } from "./teacherAccountDelivery";
import { resolveTeacherIdentityMode } from "./teacherIdentityMode.server";
import { resolveProvisionedTeacherCanaryAccountId } from "./provisionedTeacherCanary.server";
import {
    SUPABASE_READINESS_CHECK_KEYS,
    SUPABASE_READINESS_VERSION,
    type SupabaseDeploymentProbe,
    type SupabaseReadinessFailureKey,
} from "./supabaseReadinessProbe";

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

    if (explicitSecret && resolvedSecret) {
        return {
            key: "teacher_session_secret",
            label: "교사 세션 secret",
            detail: "TEACHER_SESSION_SECRET 또는 OMR_TEACHER_SESSION_SECRET이 설정되어 서버 보호 쿠키를 안정적으로 서명합니다.",
            tone: "ready",
        };
    }

    if (explicitSecret) {
        return {
            key: "teacher_session_secret",
            label: "교사 세션 secret",
            detail: `운영 TEACHER_SESSION_SECRET 또는 OMR_TEACHER_SESSION_SECRET은 ${PRODUCTION_SIGNING_SECRET_MIN_BYTES}바이트 이상의 임의 비밀값이어야 합니다. 짧은 secret으로는 세션을 발급하거나 검증하지 않습니다.`,
            tone: "error",
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

    if (explicitSecret && resolvedSecret) {
        return {
            key: "student_session_secret",
            label: "학생 세션 secret",
            detail: "STUDENT_SESSION_SECRET 또는 OMR_STUDENT_SESSION_SECRET이 설정되어 학생·게스트 본인 확인 쿠키를 서명합니다.",
            tone: "ready",
        };
    }

    if (explicitSecret) {
        return {
            key: "student_session_secret",
            label: "학생 세션 secret",
            detail: `운영 STUDENT_SESSION_SECRET 또는 OMR_STUDENT_SESSION_SECRET은 ${PRODUCTION_SIGNING_SECRET_MIN_BYTES}바이트 이상의 임의 비밀값이어야 합니다. 짧은 secret으로는 세션을 발급하거나 검증하지 않습니다.`,
            tone: "error",
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

function rateLimitHashSecretCheck(env: Env): DeploymentReadinessCheck {
    const secret = clean(env.OMR_RATE_LIMIT_HASH_SECRET);
    const strong = Buffer.byteLength(secret, "utf8") >= 32;
    const production = clean(env.NODE_ENV).toLowerCase() === "production";
    return {
        key: "rate_limit_hash_secret",
        label: "요청 제한 해시 secret",
        detail: strong
            ? "OMR_RATE_LIMIT_HASH_SECRET이 32바이트 이상으로 설정되어 공유 요청 제한 버킷을 비식별 HMAC으로 저장합니다."
            : "OMR_RATE_LIMIT_HASH_SECRET은 32바이트 이상의 임의 비밀값이어야 합니다. 운영에서는 누락되거나 짧으면 로그인·시험 PIN·AI 요청 제한이 안전하게 차단됩니다.",
        tone: strong ? "ready" : production ? "error" : "warning",
    };
}

function isFlagEnabled(value: unknown): boolean {
    const normalized = clean(value).toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}

function operationalEventSinkCheck(env: Env): DeploymentReadinessCheck {
    const configuration = operationalEventSinkConfiguration(env);
    const production = clean(env.NODE_ENV).toLowerCase() === "production";
    if (configuration.status === "configured") return {
        key: "operational_event_sink",
        label: "중앙 운영 이벤트 수집",
        detail: "서버 전용 HTTPS 운영 이벤트 sink가 설정되어 오류와 작업 heartbeat를 중앙 수집할 수 있습니다. 실제 전달 가능 여부는 /api/readyz가 확인합니다.",
        tone: "ready",
    };
    return {
        key: "operational_event_sink",
        label: "중앙 운영 이벤트 수집",
        detail: configuration.status === "invalid_configuration"
            ? "OMR_OPERATIONAL_SINK_URL은 운영에서 HTTPS여야 하고, OMR_OPERATIONAL_SINK_TOKEN은 공백 없는 32~512자 서버 전용 값이어야 합니다."
            : "OMR_OPERATIONAL_SINK_URL과 32자 이상의 OMR_OPERATIONAL_SINK_TOKEN을 서버 환경변수에 설정하세요.",
        tone: production ? "error" : "warning",
    };
}

function teacherAccountDeliveryCheck(env: Env): DeploymentReadinessCheck {
    if (resolveTeacherIdentityMode(env) === "provisioned_only") {
        return {
            key: "teacher_account_delivery",
            label: "교사 계정 전달 모드",
            detail: "프로비저닝 전용 모드에서는 운영자가 초기 자격 증명과 재발급을 전달하므로 self-service 이메일 adapter를 요구하지 않습니다.",
            tone: "ready",
        };
    }
    let configured = false;
    try {
        configured = !!resolveTeacherAccountDeliveryAdapter(env);
    } catch {
        configured = false;
    }
    const production = clean(env.NODE_ENV).toLowerCase() === "production";
    return {
        key: "teacher_account_delivery",
        label: "교사 계정 이메일 전달",
        detail: configured
            ? "교사 가입 확인과 비밀번호 복구용 HMAC 서명 HTTPS delivery adapter가 설정되어 있습니다. /api/readyz가 서명된 무부작용 HEAD로 도달 가능성을 확인하며, 실제 이메일 수신은 배포 후 canary로 확인해야 합니다."
            : "교사 가입 확인과 비밀번호 복구용 이메일 delivery adapter가 연결되지 않아 토큰 요청은 DB 변경 전에 안전하게 거부됩니다.",
        tone: configured ? "ready" : production ? "error" : "warning",
    };
}

function provisionedTeacherCanaryCheck(env: Env): DeploymentReadinessCheck {
    if (resolveTeacherIdentityMode(env) === "self_service") return {
        key: "provisioned_teacher_canary",
        label: "프로비저닝 교사 동적 카나리",
        detail: "self-service 모드에서는 파일럿 프로비저닝 카나리를 요구하지 않습니다.",
        tone: "ready",
    };
    const configured = !!resolveProvisionedTeacherCanaryAccountId(env);
    return {
        key: "provisioned_teacher_canary",
        label: "프로비저닝 교사 동적 카나리",
        detail: configured
            ? "비식별 카나리 계정 ID가 설정됐습니다. /api/readyz가 계정·조직·grant·감사 결속을 무부작용 RPC로 확인합니다."
            : "OMR_PROVISIONED_TEACHER_CANARY_ACCOUNT_ID에 운영 CLI 영수증의 정확한 teacher_<16hex> 계정 ID를 설정하세요.",
        tone: configured ? "ready" : "error",
    };
}

function databaseProbeFailureKeys(
    probe?: SupabaseDeploymentProbe | null,
): SupabaseReadinessFailureKey[] {
    if (!probe) return [];
    const failures: SupabaseReadinessFailureKey[] = [
        ...(probe.failedChecks || []),
        ...SUPABASE_READINESS_CHECK_KEYS.filter(key => probe[key] !== true),
    ];
    if (probe.version !== SUPABASE_READINESS_VERSION) {
        failures.push("probeVersion");
    }
    if (probe.ready !== true) {
        failures.push("databaseDeclaredReady");
    }
    return [...new Set(failures)];
}

export function databaseProbeFailuresForIdentityMode(
    probe: SupabaseDeploymentProbe | null | undefined,
    identityMode: ReturnType<typeof resolveTeacherIdentityMode>,
): SupabaseReadinessFailureKey[] {
    const failures = databaseProbeFailureKeys(probe);
    if (identityMode !== "self_service") return failures;
    const operatorPilotFailed = failures.includes("operatorPilotProvisioningReady");
    const provisionedLoginFailed = failures.includes("provisionedTeacherLoginReady");
    if (!operatorPilotFailed && !provisionedLoginFailed) return failures;
    return failures.filter(key => {
        if (key === "operatorPilotProvisioningReady" || key === "provisionedTeacherLoginReady") return false;
        if (key === "databaseDeclaredReady") return false;
        if (key === "serverGatewayCapabilitiesReady" && provisionedLoginFailed) return false;
        return true;
    });
}

function productionRlsCheck(
    env: Env,
    serverGatewayReady: boolean,
    identityMode: ReturnType<typeof resolveTeacherIdentityMode>,
    databaseProbe?: SupabaseDeploymentProbe | null,
): DeploymentReadinessCheck {
    const rlsApplied = isFlagEnabled(env.OMR_PRODUCTION_RLS_APPLIED);
    const isProduction = clean(env.NODE_ENV).toLowerCase() === "production";
    const probeFailures = databaseProbeFailuresForIdentityMode(databaseProbe, identityMode);
    const databaseReady = !!databaseProbe && probeFailures.length === 0;

    if (rlsApplied && databaseReady) {
        return {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: `실제 DB probe${databaseProbe.version ? ` ${databaseProbe.version}` : ""}에서 브라우저 실효 권한 회수, 전체 canonical FORCE RLS, 조직 무결성, scoped RPC와 private Storage 경계를 확인했습니다.`,
            tone: "ready",
        };
    }

    if (isProduction && rlsApplied && !databaseReady) {
        const failureLabels: Record<SupabaseReadinessFailureKey, string> = {
            browserSchemaPrivilegesDenied: "브라우저 schema 권한 차단",
            anonTablePrivilegesDenied: "anon 테이블 권한 차단",
            authenticatedCanonicalPrivilegesDenied: "authenticated 테이블 권한 차단",
            browserSequencePrivilegesDenied: "브라우저 sequence 권한 차단",
            browserFunctionPrivilegesDenied: "브라우저 함수 권한 차단",
            alphaPoliciesAbsent: "alpha 정책 제거",
            canonicalTablesForceRls: "전체 canonical FORCE RLS",
            canonicalPoliciesAbsent: "canonical 정책 제거",
            organizationBackfillReady: "조직 무결성 preflight",
            serviceRolePrivilegesReady: "service-role 실행 권한",
            scopedRpcPrivilegesReady: "목적별 교사 RPC 권한",
            hostedStorageBoundaryReady: "private Storage owner·정책",
            serverGatewayCapabilitiesReady: "서버 gateway 함수",
            queryPathIndexesReady: "운영 조회 인덱스",
            legacyBroadRpcsRemoved: "legacy broad RPC 제거",
            directUploadIntentLifecycleReady: "직접 업로드 intent 수명주기",
            teacherUploadCleanupQueueReady: "원격 자산 정리 큐 수명주기",
            teacherAssetFinalizePreauthorizationReady: "교사 자산 finalize 사전 권한 확인",
            examReservationLeaseReady: "시험 한도 예약 lease",
            teacherAssetCleanupBacklogHealthy: "원격 자산 정리 backlog",
            studentAttemptSessionsReady: "학생 다중 기기 응시 세션",
            durableRateLimitsReady: "공유 요청 제한 저장소",
            examRevisionReady: "시험 revision 무결성",
            teacherExamCasReady: "시험 CAS 저장 gateway",
            teacherNotificationSummaryReady: "교사 알림 경량 집계 gateway",
            teacherNotificationStateReady: "교사 알림 다중 기기 상태 gateway",
            feedbackRevisionReady: "피드백 revision 무결성",
            feedbackCasReady: "피드백 CAS 저장 gateway",
            workspaceBootstrapPlanSafe: "워크스페이스 플랜 보존 bootstrap",
            sessionCleanupOptimizationReady: "세션·자산 정리 최적화",
            feedbackReplayHardeningReady: "피드백 재전송 안전성",
            feedbackCoreFreeReady: "무료 텍스트 피드백 경계",
            examEntryInvitesReady: "시험별 opaque 학생 초대 경계",
            sessionCleanupFencingReady: "세션·자산 정리 generation fence",
            attemptCheckpointNullCasReady: "응시 체크포인트 NULL CAS 차단",
            rosterSnapshotCasReady: "명단 스냅샷 다중 기기 CAS",
            attemptMutationCasReady: "응시 세션 변경 NULL·범위 CAS 차단",
            examDeleteSessionSafe: "제출 세션 안전 시험 삭제",
            studentQuestionAtomicReady: "학생 질문 원자 저장 gateway",
            teacherLiveSessionsReady: "교사 실시간 응시 세션 gateway",
            teacherAccountLifecycleReady: "교사 계정 수명주기 gateway",
            initialOperationsLoadControlReady: "초기 운영 부하 제어 gateway",
            individualStudentAssignmentsReady: "개별 학생 배정·응시 결속 gateway",
            teacherAttemptReportingReady: "전체 제출 정확 집계·커서 내보내기 gateway",
            operationalJobStatusReady: "운영 작업 상태·dead-letter heartbeat 경계",
            operatorPilotProvisioningReady: "운영자 교사·파일럿 플랜 원자 프로비저닝 경계",
            provisionedTeacherLoginReady: "프로비저닝 계정·조직·플랜 로그인 결속 경계",
            effectiveWorkspacePlanEnforcementReady: "동일 트랜잭션 계정·유효 플랜 변경 경계",
            studentSessionGenerationReady: "학생 credential 세대·요청 시점 세션 검증 경계",
            probeVersion: "probe 버전",
            databaseDeclaredReady: "DB 최종 readiness 판정",
            probeExecution: "probe 실행",
            probePayload: "probe 응답 형식",
        };
        const failures = probeFailures
            .map(key => failureLabels[key])
            .join(", ");
        return {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: failures
                ? `환경변수는 적용됨으로 표시하지만 실제 DB 경계가 미충족입니다: ${failures}. 동일 커밋의 migration·server-only profile·preflight를 다시 적용하고 probe를 재실행하세요.`
                : "OMR_PRODUCTION_RLS_APPLIED는 설정됐지만 실제 DB의 실효 권한과 조직 무결성 상태가 확인되지 않았습니다.",
            tone: "error",
        };
    }

    if (isProduction && serverGatewayReady) {
        return {
            key: "production_rls",
            label: "실사용 RLS 전환",
            detail: "Supabase 서버 게이트웨이는 설정됐지만 production-server-boundary.sql 적용이 확인되지 않았습니다. 운영 데이터 저장 전 실제 DB 권한과 FORCE RLS를 검증하세요.",
            tone: "error",
        };
    }

    return {
        key: "production_rls",
        label: "실사용 RLS 전환",
        detail: "실제 학생 데이터를 저장하기 전 조직 멤버십, production-server-boundary.sql 적용 여부를 확인하고 OMR_PRODUCTION_RLS_APPLIED=true로 표시하세요.",
        tone: "warning",
    };
}

function studentAttemptSecretCheck(env: Env): DeploymentReadinessCheck {
    const explicitSecret = clean(env.STUDENT_ATTEMPT_SECRET) || clean(env.OMR_STUDENT_ATTEMPT_SECRET);
    const resolvedSecret = resolveStudentAttemptSecret(env);
    if (explicitSecret && resolvedSecret) {
        return {
            key: "student_attempt_secret",
            label: "학생 응시 티켓 secret",
            detail: "학생 응시 티켓을 별도 서버 secret으로 서명해 시험·조직·학생·허용 문항 변조를 차단합니다.",
            tone: "ready",
        };
    }
    if (explicitSecret) {
        return {
            key: "student_attempt_secret",
            label: "학생 응시 티켓 secret",
            detail: `운영 STUDENT_ATTEMPT_SECRET 또는 OMR_STUDENT_ATTEMPT_SECRET은 ${PRODUCTION_SIGNING_SECRET_MIN_BYTES}바이트 이상의 임의 비밀값이어야 합니다. 짧은 secret으로는 응시 티켓을 발급하거나 검증하지 않습니다.`,
            tone: "error",
        };
    }
    return {
        key: "student_attempt_secret",
        label: "학생 응시 티켓 secret",
        detail: resolvedSecret
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
    const teacherIdentityMode = resolveTeacherIdentityMode(env);
    const cleanupScheduleReady = isRemoteAssetCleanupScheduled(env);
    const databaseTeacherLifecycleReady = serviceRoleReady
        && !!databaseProbe
        && databaseProbeFailuresForIdentityMode(databaseProbe, teacherIdentityMode).length === 0
        && databaseProbe.teacherAccountLifecycleReady === true
        && (teacherIdentityMode === "self_service" || (
            databaseProbe.operatorPilotProvisioningReady === true
            && databaseProbe.provisionedTeacherLoginReady === true
        ));
    const bootstrapLoginEnabled = teacherIdentityMode === "self_service"
        && (!isProduction || isFlagEnabled(env.OMR_ALLOW_TEACHER_BOOTSTRAP_LOGIN));
    const bootstrapTeacherReady = bootstrapLoginEnabled && authConfig.ready;
    const teacherCredentialsTone: DeploymentReadinessTone = databaseTeacherLifecycleReady
        ? "ready"
        : !bootstrapTeacherReady
        ? "error"
        : authConfig.warnings.length > 0
            ? "warning"
            : "ready";

    const checks: DeploymentReadinessCheck[] = [
        {
            key: "teacher_credentials",
            label: "교사 계정 수명주기",
            detail: databaseTeacherLifecycleReady
                ? `DB 교사 계정 수명주기와 서비스롤 전용 RPC가 readiness ${databaseProbe?.version || ""}에서 확인됐습니다.${bootstrapTeacherReady ? ` 환경변수 부트스트랩 계정 ${authConfig.credentialCount}개도 명시적으로 활성화되어 있습니다.` : ""}`
                : bootstrapTeacherReady
                    ? `${authConfig.credentialCount}개 교사 부트스트랩 계정이 서버 환경변수에서 인식됩니다.${isProduction ? " OMR_ALLOW_TEACHER_BOOTSTRAP_LOGIN=true로 운영 사용이 명시적으로 허용되었습니다." : " 개발 환경에서만 기본 활성화됩니다."}${authConfig.warnings.length > 0 ? ` ${describeIssues(authConfig.warnings)}` : ""}`
                    : isProduction && authConfig.ready
                        ? "DB 교사 계정 수명주기가 확인되지 않았고 환경변수 계정도 운영에서 비활성입니다. 임시 부트스트랩 로그인이 꼭 필요할 때만 OMR_ALLOW_TEACHER_BOOTSTRAP_LOGIN=true를 명시하세요."
                        : describeIssues(authConfig.issues) || "운영 배포에는 readiness가 확인된 DB 교사 계정 수명주기가 필요합니다.",
            tone: teacherCredentialsTone,
        },
        teacherAccountDeliveryCheck(env),
        provisionedTeacherCanaryCheck(env),
        sessionSecretCheck(env),
        studentSessionSecretCheck(env),
        studentAttemptSecretCheck(env),
        rateLimitHashSecretCheck(env),
        canonicalBrowserBoundaryCheck(env, supabasePublicReady),
        {
            key: "supabase_service_role",
            label: "Supabase 서버 게이트웨이",
            detail: serviceRoleReady
                ? "서비스롤 키가 서버에 있어 정답 제거 시험 제공, 공식 채점, 본인 격리 조회와 원자적 저장 RPC를 실행할 수 있습니다."
                : "서비스롤 키가 없으면 안전한 원격 시험·서버 채점 게이트웨이가 비활성입니다. SUPABASE_SERVICE_ROLE_KEY는 서버 환경변수에만 설정하세요.",
            tone: serviceRoleReady ? "ready" : isProduction ? "error" : "warning",
        },
        {
            key: "remote_asset_cleanup_schedule",
            label: "원격 자산 정리 스케줄",
            detail: cleanupScheduleReady
                ? "인증된 내부 정리 작업과 배포 스케줄이 명시적으로 설정되어 만료·교체·삭제된 원격 자산을 회수할 수 있습니다."
                : "OMR_ASSET_GC_SCHEDULED=1과 32자 이상의 CRON_SECRET을 함께 설정하고 배포 스케줄이 실제 활성화됐는지 확인하세요.",
            tone: cleanupScheduleReady ? "ready" : isProduction ? "error" : "warning",
        },
        operationalEventSinkCheck(env),
        productionRlsCheck(env, serviceRoleReady, teacherIdentityMode, databaseProbe),
    ];

    const readyCount = checks.filter(check => check.tone === "ready").length;
    const hasError = checks.some(check => check.tone === "error");
    const hasWarning = checks.some(check => check.tone === "warning");

    return {
        label: hasError ? "배포 확인 필요" : hasWarning ? "배포 보강 권장" : "배포 준비됨",
        detail: hasError
            ? "교사 계정, 서버 세션, 학생 티켓, 요청 제한 해시 secret, Supabase 서버 게이트웨이, 원격 자산 정리 스케줄과 중앙 운영 이벤트 수집 설정을 먼저 고쳐야 합니다."
            : hasWarning
                ? "핵심 흐름은 실행 가능하지만 운영 데이터 전에는 남은 보안/DB 항목을 확인하세요."
                : "교사 계정, 서버 세션, 학생 응시 티켓, 요청 제한 해시 secret, 브라우저 데이터 경계, 서버 게이트웨이, 원격 자산 정리 스케줄, 중앙 운영 이벤트 수집과 RLS가 모두 준비됐습니다.",
        credentialCount: authConfig.credentialCount,
        readyCount,
        totalCount: checks.length,
        checks,
    };
}
