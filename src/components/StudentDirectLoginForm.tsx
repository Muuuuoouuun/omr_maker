"use client";

import { useState } from "react";
import { loginStudentWithStartCode, type StudentLoginGroup, type StudentSessionIssueResult } from "@/app/actions/studentSession";
import { normalizeStartCodeInput } from "@/lib/studentCodes";

interface Props {
    onSignedIn(result: StudentSessionIssueResult): Promise<void> | void;
    rememberDevice: boolean;
    returnHintName?: string;
    onForgetDevice?(): void;
    onRememberDeviceChange(value: boolean): void;
    getGuestAttemptIds?(): string[];
}

export default function StudentDirectLoginForm({ onSignedIn, rememberDevice, onRememberDeviceChange, getGuestAttemptIds, returnHintName, onForgetDevice }: Props) {
    const [studentId, setStudentId] = useState("");
    const [startCode, setStartCode] = useState("");
    const [groups, setGroups] = useState<StudentLoginGroup[]>([]);
    const [groupId, setGroupId] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");

    const resetClassChoices = () => { setGroups([]); setGroupId(""); setError(""); };
    const submit = async () => {
        if (pending) return;
        if (!studentId.trim() || !startCode) {
            setError("학생 로그인 ID와 시작 코드를 입력해주세요.");
            return;
        }
        if (groups.length > 1 && !groupId) {
            setError("내 반을 선택해주세요.");
            return;
        }
        setPending(true);
        setError("");
        try {
            const result = await loginStudentWithStartCode({
                studentId: studentId.trim(), startCode, groupId: groupId || undefined,
                guestAttemptIds: getGuestAttemptIds?.() || [],
            });
            if (result.status === "group_required") {
                setGroups(result.groups);
                setGroupId("");
                return;
            }
            if (!result.ok || !result.identity) {
                setError(result.status === "rate_limited"
                    ? "학생 로그인 시도가 많습니다. 10분 후 다시 시도해주세요."
                    : result.status === "error"
                        ? "학생 인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요."
                        : "학생 로그인 ID와 시작 코드를 확인해주세요.");
                return;
            }
            setStartCode("");
            await onSignedIn(result);
        } catch {
            setError("학생 인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setPending(false);
        }
    };

    return (
        <form className="student-direct-login-form" onSubmit={event => { event.preventDefault(); void submit(); }} noValidate aria-busy={pending}>
            {returnHintName && <section className="student-return-hint-banner" role="status" style={{ marginBottom: "1rem", lineHeight: 1.65 }}>
                <p>{returnHintName}님, 다시 오셨네요. 학생 로그인 ID와 시작 코드를 입력하면 이어서 할 수 있어요.</p>
                <button type="button" className="btn" disabled={pending} style={{ minHeight: 44 }} onClick={() => {
                    setStudentId(""); setStartCode(""); resetClassChoices(); onForgetDevice?.();
                }}>다른 학생이에요</button>
            </section>}
            <p style={{ marginBottom: "1.25rem", lineHeight: 1.65, color: "var(--muted)", wordBreak: "keep-all" }}>
                선생님이 알려준 학생 로그인 ID와 시작 코드로 내 시험과 제출 기록을 확인하세요.
            </p>
            <div style={{ marginBottom: "1.1rem" }}>
                <label htmlFor="direct-student-id" style={{ display: "block", marginBottom: "0.55rem", fontWeight: 700 }}>학생 로그인 ID</label>
                <input id="direct-student-id" className="input-field" value={studentId} disabled={pending} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254}
                    placeholder="선생님이 알려준 학생 로그인 ID" onChange={event => { setStudentId(event.target.value); resetClassChoices(); }} aria-describedby="direct-student-id-help" />
                <p id="direct-student-id-help" style={{ marginTop: "0.45rem", color: "var(--muted)", fontSize: "var(--type-caption)", lineHeight: 1.55 }}>
                    선생님이 발급한 코드 안내의 학생 ID를 입력하세요. ID나 코드를 모르면 선생님에게 문의하세요.
                </p>
            </div>
            <div style={{ marginBottom: "1.25rem" }}>
                <label htmlFor="direct-student-code" style={{ display: "block", marginBottom: "0.55rem", fontWeight: 700 }}>시작 코드</label>
                <input id="direct-student-code" type="password" className="input-field" value={startCode} disabled={pending} autoComplete="current-password" autoCapitalize="characters" spellCheck={false} maxLength={6}
                    placeholder="6자리 코드 입력" onChange={event => { setStartCode(normalizeStartCodeInput(event.target.value)); resetClassChoices(); }} />
            </div>
            {groups.length > 1 && <div style={{ marginBottom: "1.25rem" }}>
                <label htmlFor="direct-student-group" style={{ display: "block", marginBottom: "0.55rem", fontWeight: 700 }}>내 반 선택</label>
                <select id="direct-student-group" className="input-field" value={groupId} disabled={pending} onChange={event => { setGroupId(event.target.value); setError(""); }}>
                    <option value="">반을 선택하세요</option>
                    {groups.map(group => <option key={group.id} value={group.id}>{group.region ? `${group.region} · ${group.name}` : group.name}</option>)}
                </select>
            </div>}
            {error && <p role="alert" style={{ marginBottom: "1rem", color: "var(--text-error)", lineHeight: 1.55 }}>{error}</p>}
            <button type="submit" disabled={pending} className="btn btn-primary" style={{ width: "100%", marginBottom: "0.75rem", background: "linear-gradient(135deg, var(--secondary), #c026d3)" }}>
                {pending ? "계정 확인 중…" : "내 시험으로 이동"}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: "0.65rem", minHeight: 44, fontSize: "var(--type-label)" }}>
                <input type="checkbox" checked={rememberDevice} disabled={pending} onChange={event => onRememberDeviceChange(event.target.checked)} />
                <span>이 기기에서 내 정보 기억하기<small style={{ display: "block", marginTop: "0.15rem", color: "var(--muted)" }}>이름과 반만 기억해요. 12시간 후에는 ID와 시작 코드를 다시 입력하세요. 공용 기기에서는 선택하지 마세요.</small></span>
            </label>
        </form>
    );
}
