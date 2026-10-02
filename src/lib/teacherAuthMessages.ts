// Server error codes. These strings are returned by the login server action and
// compared by identity on the client, so keep them stable (tests pin them).
export const TEACHER_AUTH_ERROR = "아이디 또는 비밀번호가 올바르지 않습니다.";

export const TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR =
    "배포 환경에 교사 계정이 설정되어 있지 않습니다.";

export const TEACHER_AUTH_SESSION_CONFIG_ERROR =
    "배포 환경에 교사 세션 서명키가 설정되어 있지 않습니다.";

export const TEACHER_AUTH_SESSION_COOKIE_ERROR =
    "교사 보안 세션을 시작하지 못했습니다. 브라우저 쿠키 설정을 확인한 뒤 다시 시도해주세요.";

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
    "개발 환경 안내: Supabase 없이 로컬에서 로그인하려면 OMR_TEACHER_IDENTITY_MODE=self_service를 설정하세요. "
    + "TEACHER_ACCOUNTS 또는 TEACHER_LOGIN_ID/TEACHER_PASSWORD가 없으면 로컬 데모 계정(admin/admin123 등)을 씁니다. "
    + "배포 환경은 provisioned_only로 고정되어 Supabase에 발급된 원장 계정만 로그인할 수 있습니다(docs/operator-teacher-provisioning.md).";

/** Operator-only guidance for a missing session signing secret. */
export const TEACHER_AUTH_SESSION_OPERATOR_HELP =
    "개발 환경 안내: TEACHER_SESSION_SECRET(또는 OMR_TEACHER_SESSION_SECRET)을 설정한 뒤 서버를 다시 시작하세요.";

export interface TeacherLoginHelp {
    /** Text shown to the teacher as the error. */
    message: string;
    /** Operator guidance (env vars, provisioning). Only ever set outside production. */
    operatorHelp?: string;
}

/**
 * Split a teacher login error into user copy and operator copy. A wrong
 * password never carries configuration hints; configuration failures show a
 * plain "ask your academy admin" message in production and keep the operator
 * guidance for non-production environments only.
 */
export function teacherLoginHelpFor(
    error: string,
    { production }: { production: boolean },
): TeacherLoginHelp {
    const operatorHelp = error === TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR
        ? TEACHER_AUTH_ACCOUNT_OPERATOR_HELP
        : error === TEACHER_AUTH_SESSION_CONFIG_ERROR
            ? TEACHER_AUTH_SESSION_OPERATOR_HELP
            : undefined;
    if (!operatorHelp) return { message: error };
    if (production) return { message: TEACHER_LOGIN_UNAVAILABLE_MESSAGE };
    return { message: error, operatorHelp };
}
