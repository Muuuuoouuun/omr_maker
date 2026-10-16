// What the teacher sign-up / password-reset / email-verification form says for
// each TeacherAccountPublicStatus. Outcomes carry a tone so a successful request
// is shown as a confirmation, not in the red error slot that also marks the
// form's fields invalid.

export type TeacherLifecycleFeedback = Readonly<{
    status: string;
    tone: "success" | "error";
    text: string;
}>;

export const TEACHER_LIFECYCLE_SERVICE_UNAVAILABLE = "계정 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.";

export function teacherLifecycleFeedback(status: string): TeacherLifecycleFeedback {
    switch (status) {
        case "accepted":
            return { status, tone: "success", text: "요청을 접수했습니다. 계정 존재 여부와 관계없이 같은 안내가 표시됩니다." };
        case "completed":
            return { status, tone: "success", text: "비밀번호를 변경했습니다. 새 비밀번호로 로그인해주세요." };
        case "verified":
            return { status, tone: "success", text: "이메일 확인이 완료되었습니다. 이제 로그인할 수 있습니다." };
        case "delivery_unavailable":
            return { status, tone: "error", text: "이메일 전송 기능이 아직 연결되지 않았습니다. 운영자에게 계정 발급 또는 복구를 요청해주세요." };
        case "invalid_input":
            return { status, tone: "error", text: "이메일, 이름, 비밀번호 형식을 확인해주세요. 비밀번호는 12자 이상이어야 합니다." };
        case "rate_limited":
            return { status, tone: "error", text: "요청이 많습니다. 잠시 후 다시 시도해주세요." };
        case "invalid_or_expired":
            return { status, tone: "error", text: "링크가 만료되었거나 이미 사용되었습니다. 새 링크를 요청해주세요." };
        default:
            return { status, tone: "error", text: TEACHER_LIFECYCLE_SERVICE_UNAVAILABLE };
    }
}
