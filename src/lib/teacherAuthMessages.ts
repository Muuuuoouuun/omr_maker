export const TEACHER_AUTH_ERROR = "아이디 또는 비밀번호가 올바르지 않습니다.";

export const TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR =
    "배포 환경에 교사 계정이 설정되어 있지 않습니다.";

export const TEACHER_AUTH_SESSION_CONFIG_ERROR =
    "배포 환경에 교사 세션 서명키가 설정되어 있지 않습니다.";

export const TEACHER_AUTH_SESSION_COOKIE_ERROR =
    "교사 보안 세션을 시작하지 못했습니다. 브라우저 쿠키 설정을 확인한 뒤 다시 시도해주세요.";

export const TEACHER_AUTH_DEPLOYMENT_HELP =
    "배포 환경의 교사 로그인은 Supabase가 아니라 TEACHER_ACCOUNTS 또는 TEACHER_LOGIN_ID/TEACHER_PASSWORD를 사용합니다. TEACHER_SESSION_SECRET도 함께 확인하세요.";

export function shouldShowTeacherDeploymentHelp(error: string | undefined): boolean {
    return error === TEACHER_AUTH_ERROR
        || error === TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR
        || error === TEACHER_AUTH_SESSION_CONFIG_ERROR;
}
