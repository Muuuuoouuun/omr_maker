export const REMEDIATION_RETAKE_MESSAGES = {
    unauthorized: "등록 학생 계정으로 다시 로그인해주세요.",
    unavailable: "이 보강을 확인할 수 없습니다. 목록을 새로고침해주세요.",
    paused: "선생님이 보강을 보류했습니다. 진행 여부를 확인해주세요.",
    handoff: "반 또는 담당 선생님이 바뀌었습니다. 보강 진행 여부를 확인해주세요.",
    review: "오답 수정이 끝났습니다. 풀이를 설명하고 선생님의 확인을 기다려주세요.",
    completed: "선생님이 확인한 보강입니다. 복습 화면에서 결과를 확인해주세요.",
    assignment_required: "아직 이 오답의 개별 재시험이 배정되지 않았습니다. 선생님에게 재시험 배정을 요청해주세요.",
    different_source: "현재 재시험은 다른 응시 결과에 대한 배정입니다. 선생님에게 이 보강의 원시험을 확인해달라고 요청해주세요.",
    not_started: "재시험 시작 전입니다. 학습 홈에서 시작 시간을 확인해주세요.",
    ended: "재시험 응시 기간이 끝났습니다. 선생님에게 응시 기간을 확인해달라고 요청해주세요.",
    changed: "배정 또는 재원 상태가 바뀌었습니다. 목록을 새로고침하고 선생님에게 배정을 확인해주세요.",
    questions_changed: "원시험과 현재 문항 구성이 맞지 않습니다. 선생님에게 재시험 문항을 확인해달라고 요청해주세요.",
    plan_denied: "학원의 재시험 이용 권한을 확인해야 합니다. 기존 복습 결과는 계속 볼 수 있습니다.",
    service_unavailable: "재시험 배정을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
} as const;

export type RemediationRetakeBlock = keyof typeof REMEDIATION_RETAKE_MESSAGES;
export type RemediationRetakeResult =
    | { status: "ready"; href: string }
    | { status: "blocked"; code: RemediationRetakeBlock };
