"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import TeacherHeader from "@/components/TeacherHeader";
import { manageRemediation } from "@/app/actions/remediation";
import { REMEDIATION_STATE_LABELS, type RemediationCase, type RemediationCommand, type RemediationDashboard } from "@/lib/remediation";
import styles from "./remediation.module.css";

const dateLabel = (value: string) => new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
type Mutation = Exclude<RemediationCommand, { op: "load" }>;

function CaseCard({ item, disabled, save }: { item: RemediationCase; disabled: boolean; save: (command: Mutation) => Promise<void> }) {
    const [note, setNote] = useState("");
    const [verified, setVerified] = useState(false);
    const command = (op: "confirm" | "pause" | "resume"): Mutation => ({ op, sourceAttemptId: item.sourceAttemptId,
        expectedRevision: item.revision, evidenceKey: item.evidenceKey, note });
    return <article className={styles.card}>
        <div className={styles.row}><span className={styles.badge} data-state={item.state}>{REMEDIATION_STATE_LABELS[item.state]}</span><span>{item.className} · {item.studentName}</span></div>
        <h3>{item.examTitle}</h3>
        <p>오답 수정 <strong>{item.correctedCount} / {item.targetCount}문항</strong> · 기한 {dateLabel(item.dueAt)}<br />담당 {item.assigneeName}</p>
        <Link href={`/teacher/attempt/${encodeURIComponent(item.sourceAttemptId)}`} className={styles.link}>원시험과 제출 근거 보기 →</Link>
        {item.note && <p className={styles.note}>최근 처리 기록: {item.note}</p>}
        {item.state === "handoff" && <p>반 이동·휴원 또는 담당 권한 변경을 확인해주세요. 자동으로 완료하지 않습니다.</p>}
        {item.canManage && item.state !== "confirmed" && <fieldset className={styles.form} disabled={disabled}>
            {item.state === "paused" ? <button className="btn btn-secondary" type="button" onClick={() => void save(command("resume"))}>보강 재개</button> : <>
                <label className={styles.field}>확인 근거 또는 보류 사유
                    <textarea value={note} maxLength={500} rows={2} placeholder="예: 유사 문항 풀이 설명을 확인함 (5자 이상)" onChange={e => setNote(e.target.value)} />
                </label>
                {item.state === "awaiting_review" && <label className={styles.check}><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />별도 문항 풀이 또는 설명을 직접 확인했습니다.</label>}
                <div className={styles.row}>
                    {item.state === "awaiting_review" && <button className="btn btn-primary" disabled={!verified || note.trim().length < 5} type="button" onClick={() => void save(command("confirm"))}>교사 확인 완료</button>}
                    <button className="btn btn-secondary" disabled={note.trim().length < 5} type="button" onClick={() => void save(command("pause"))}>사유 남기고 보류</button>
                </div>
            </>}
        </fieldset>}
    </article>;
}

export default function RemediationPage() {
    const [dashboard, setDashboard] = useState<RemediationDashboard | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [dueDate, setDueDate] = useState("");
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [page, setPage] = useState(0);
    const generation = useRef(0);
    const saving = useRef(false);
    const load = useCallback(async () => {
        const request = ++generation.current;
        setLoading(true); setError(""); setDashboard(null); setSelected([]);
        try {
            const result = await manageRemediation({ op: "load", page });
            if (request !== generation.current) return;
            if (result.status === "loaded") setDashboard(result.dashboard);
            else setError(result.status === "error" ? result.error : "보강 목록을 불러오지 못했습니다.");
        } catch { if (request === generation.current) setError("연결을 확인하고 다시 시도해주세요."); }
        finally { if (request === generation.current) setLoading(false); }
    }, [page]);
    useEffect(() => { const counter = generation; void load(); return () => { counter.current++; }; }, [load]);
    async function save(command: Mutation) {
        if (saving.current) return;
        saving.current = true; setBusy(true); setError(""); setMessage("");
        try {
            const result = await manageRemediation(command);
            if (result.status === "saved") { await load(); setMessage("저장했습니다. 최신 제출 근거로 목록을 갱신했습니다."); }
            else if (result.status === "error") { await load(); setError(result.error); }
        } catch { setDashboard(null); setError("저장 결과를 확인하지 못했습니다. 새로고침 후 상태를 확인해주세요."); }
        finally { saving.current = false; setBusy(false); }
    }
    async function assign() {
        const deadline = new Date(`${dueDate}T23:59:00+09:00`);
        if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now() || deadline.getTime() > Date.now() + 90 * 86400000) {
            setError("보강 기한은 오늘부터 90일 이내로 선택해주세요."); return;
        }
        await save({ op: "assign", sourceAttemptIds: selected, dueAt: deadline.toISOString() });
    }
    return <><TeacherHeader /><main id="main-content" className={styles.main}>
        <header className={styles.heading}><div><span className={styles.eyebrow}>PREMIUM · 보강 관리</span><h1>오답을 끝까지 확인하는 관리</h1>
            <p>배정하고, 수정 결과를 보고, 확인 근거를 남기세요.<br />다시 맞혔다고 이해한 것으로 자동 처리하지 않습니다.</p></div>
            <button className="btn btn-secondary" disabled={loading || busy} onClick={() => void load()}>새로고침</button></header>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {message && <p role="status" className={styles.notice}>{message}</p>}
        {loading && <p role="status">담당 반과 제출 근거를 확인하고 있습니다…</p>}
        {dashboard && <>
            {!dashboard.planEnabled && <p className={styles.notice}>기존 기록은 조회할 수 있습니다. 새 배정과 확인 처리는 <Link href="/teacher/billing">Pro 이상</Link>에서 사용할 수 있습니다.</p>}
            <section aria-labelledby="queue-title"><div className={styles.heading}><h2 id="queue-title">먼저 확인할 보강</h2><span>재오답 → 기한 초과 → 교사 확인 순</span></div>
                <p>문항별 가장 최근 재시험 결과를 반영합니다. 새 제출이 생기면 완료된 건도 다시 확인 대상으로 바뀔 수 있습니다.</p>
                {!dashboard.cases.length && <div className={styles.card}><p>{page ? "이 페이지에 보강 기록이 없습니다." : "아직 배정된 보강이 없습니다. 아래에서 오답이 있는 학생을 선택해주세요."}</p></div>}
                <div className={styles.grid}>{dashboard.cases.map(item => <CaseCard key={`${item.sourceAttemptId}:${item.revision}:${item.evidenceKey}`} item={item} disabled={busy || !dashboard.planEnabled} save={save} />)}</div>
                <nav className={styles.row} aria-label="보강 목록 페이지"><button className="btn btn-secondary" disabled={busy || page === 0} onClick={() => setPage(p => p - 1)}>이전</button><span>{page + 1}페이지 · 최대 50건</span><button className="btn btn-secondary" disabled={busy || !dashboard.hasMore || page === 10000} onClick={() => setPage(p => p + 1)}>다음</button></nav>
            </section>
            {dashboard.canAssign && <section className={styles.card} aria-labelledby="assign-title"><h2 id="assign-title">오답 보강 배정</h2>
                <p>미배정 원시험 중 최근 50건입니다. 담당 반의 재원생·서버 채점 결과만 표시합니다. 배정한 교사가 담당하며, 학생에게는 다시 풀기 목록이 생깁니다.</p>
                <p className={styles.notice}>학습 관리 목록만 추가됩니다. 시험 공개·재시험 배정 권한은 바꾸지 않으므로 기존 시험 배포 설정을 먼저 확인해주세요.</p>
                <fieldset className={styles.form} disabled={busy || !dashboard.planEnabled}>
                    {!dashboard.candidates.length && <p>배정 가능한 오답이 없습니다.</p>}
                    {dashboard.candidates.map(c => <label className={styles.candidate} key={c.sourceAttemptId}>
                        <input type="checkbox" checked={selected.includes(c.sourceAttemptId)} disabled={!selected.includes(c.sourceAttemptId) && selected.length >= 20}
                            onChange={e => setSelected(current => e.target.checked ? [...current, c.sourceAttemptId] : current.filter(id => id !== c.sourceAttemptId))} />
                        <span><strong>{c.studentName}</strong> · {c.className}<small>{c.examTitle} · 오답 {c.wrongCount}문항</small></span>
                    </label>)}
                    <div className={styles.row}><label className={styles.field}>보강 기한 (한국 시간 23:59)<input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label>
                        <button className="btn btn-primary" disabled={!selected.length || !dueDate} type="button" onClick={() => void assign()}>{selected.length}건 배정하기</button></div>
                    <p>한 번에 최대 20건 · 90일 이내. 반복 클릭해도 기존 배정과 기한을 덮어쓰지 않습니다. 알림은 자동 발송하지 않습니다.</p>
                </fieldset>
            </section>}
        </>}
    </main></>;
}
