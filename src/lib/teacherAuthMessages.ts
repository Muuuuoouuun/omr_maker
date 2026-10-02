// Server error codes. These strings are returned by the login server action and
// compared by identity on the client, so keep them stable (tests pin them).
export const TEACHER_AUTH_ERROR = "아이디 또는 비밀번호가 올바르지 않습니다.";

export const TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR =
    "배포 환경에 교사 계정이 설정되어 있지 않습니다.";

export const TEACHER_AUTH_SESSION_CONFIG_ERROR =
    "배포 환경에 교사 세션 서명키가 설정되어 있지 않습니다.";

export const TEACHER_AUTH_SESSION_COOKIE_ERROR =
    "교사 보안 세션을 시작하지 못했습니다. 브라우저 쿠키 설정을 확인한 뒤 다시 시도해주세요.";

/** Teacher-facing credential recovery guidance; never contains configuration details. */
export const TEACHER_AUTH_RECOVERY_HELP =
    "입력한 계정 정보를 확인한 뒤 다시 시도하세요. 계속 입장할 수 없으면 계정 발급을 담당하는 운영자에게 문의해주세요.";

/** What a teacher sees in production when the deployment itself is misconfigured. */
export const TEACHER_LOGIN_UNAVAILABLE_MESSAGE =
    "지금은 교사 로그인을 사용할 수 없습니다. 학원 관리자에게 문의해주세요.";

/**
 * Operator-only guidance for a missing teacher account source. Mirrors the
 * current policy (`teacherIdentityModePolicy.ts`, `actions/auth.ts`):
 * production is always `provisioned_only`, and env bootstrap credentials only
 * work in non-production `self_service` mode.
 */
export const TEACHER_AUTH_ACCOUNT_OPERATOR_HELP =
    "개발 환경 안내: 로컬 교사 로그인은 OMR_TEACHER_IDENTITY_MODE=self_service 정책과 운영자가 설정한 계정 구성을 확인하세요. "
    + "TEACHER_ACCOUNTS 또는 TEACHER_LOGIN_ID 및 TEACHER_PASSWORD를 사용한다면 해당 설정을 점검한 뒤 서버를 다시 시작하세요. "
    + "배포 환경은 provisioned_only로 고정되어 운영자가 발급한 교사 계정만 로그인할 수 있습니다(docs/operator-teacher-provisioning.md).";

/** Operator-only guidance for a missing session signing secret. */
export const TEACHER_AUTH_SESSION_OPERATOR_HELP =
    "개발 환경 안내: TEACHER_SESSION_SECRET(또는 OMR_TEACHER_SESSION_SECRET)을 설정한 뒤 서버를 다시 시작하세요.";

export interface TeacherLoginHelp {
    /** Text shown to the teacher as the error. */
    message: string;
    /** Safe recovery guidance for teachers after a credential failure. */
    recoveryHelp?: string;
    /** Operator guidance (env vars, provisioning). Only ever set outside production. */
    operatorHelp?: string;
}

/**
 * Split a teacher login error into user copy and operator copy. A wrong
 * password never carries configuration hints; configuration failures show a
 * plain "ask your academy operator" message in production and keep the operator
 * guidance for non-production environments only.
 */
export function teacherLoginHelpFor(
    error: string,
    { production }: { production: boolean },
): TeacherLoginHelp {
    if (error === TEACHER_AUTH_ERROR) {
        return { message: error, recoveryHelp: TEACHER_AUTH_RECOVERY_HELP };
    }
    const operatorHelp = error === TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR
        ? TEACHER_AUTH_ACCOUNT_OPERATOR_HELP
        : error === TEACHER_AUTH_SESSION_CONFIG_ERROR
            ? TEACHER_AUTH_SESSION_OPERATOR_HELP
            : undefined;
    if (!operatorHelp) return { message: error };
    if (production) return { message: TEACHER_LOGIN_UNAVAILABLE_MESSAGE };
    return { message: error, operatorHelp };
}
