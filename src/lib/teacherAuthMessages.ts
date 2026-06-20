export const TEACHER_AUTH_ERROR = "아이디 또는 비밀번호가 올바르지 않습니다.";

export const TEACHER_AUTH_DEPLOYMENT_HELP =
    "배포 환경에서는 Supabase가 아니라 TEACHER_ACCOUNTS 또는 TEACHER_LOGIN_ID/TEACHER_PASSWORD 서버 환경변수를 먼저 확인하세요.";

export function shouldShowTeacherDeploymentHelp(error: string | undefined): boolean {
    return error === TEACHER_AUTH_ERROR;
}
