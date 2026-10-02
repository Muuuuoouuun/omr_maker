"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import TeacherHeader from "@/components/TeacherHeader";
import StatusPill from "@/components/dashboard/StatusPill";
import { loadSolapiReminderDashboard, previewSolapiReminders, saveSolapiReminderContact, saveSolapiReminderSettings } from "@/app/actions/solapiReminders";
import { defaultReminderSettings, type ReminderDashboard, type ReminderReadiness, type ReminderSettings } from "@/lib/solapiReminders";
import styles from "./reminders.module.css";

type Preview = Extract<Awaited<ReturnType<typeof previewSolapiReminders>>, { status: "loaded" }>;
const statusLabels = { preview: "미리보기 기록", sending: "접수 확인 중", accepted: "솔라피 접수", failed: "접수 실패", unknown: "결과 확인 필요" };
const formatDate = (value: string) => new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function RemindersPage() {
    const [dashboard, setDashboard] = useState<ReminderDashboard | null>(null);
    const [readiness, setReadiness] = useState<ReminderReadiness | null>(null);
    const [examId, setExamId] = useState("");
    const [settings, setSettings] = useState<ReminderSettings>(defaultReminderSettings(""));
    const [preview, setPreview] = useState<Preview | null>(null);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await loadSolapiReminderDashboard();
            if (result.status === "error") { setError(result.error); return; }
            setDashboard(result.dashboard); setReadiness(result.readiness); setError("");
        } catch { setError("알림 정보를 불러오지 못했습니다. 다시 시도해주세요."); }
        finally { setLoading(false); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    function selectExam(id: string) {
        setExamId(id); setSettings(dashboard?.settings.find(item => item.examId === id) || defaultReminderSettings(id));
        setPreview(null); setMessage("");
    }

    async function saveSettings() {
        setBusy(true); setError(""); setMessage(""); setPreview(null);
        try {
            const result = await saveSolapiReminderSettings(settings);
            if (result.status === "error") { setError(result.error); return; }
            setDashboard(current => current ? { ...current, settings: [...current.settings.filter(item => item.examId !== settings.examId), settings] } : current);
            setMessage("알림 설정을 저장했습니다.");
        } catch { setError("저장하지 못했습니다. 다시 시도해주세요."); }
        finally { setBusy(false); }
    }

    async function showPreview() {
        setBusy(true); setError(""); setMessage(""); setPreview(null);
        try {
            const result = await previewSolapiReminders(examId);
            if (result.status === "error") setError(result.error); else setPreview(result);
        } catch { setError("미리보기를 불러오지 못했습니다. 다시 시도해주세요."); }
        finally { setBusy(false); }
    }

    async function saveContact(contact: ReminderDashboard["contacts"][number]) {
        setBusy(true); setError(""); setMessage(""); setPreview(null);
        try {
            const result = await saveSolapiReminderContact(contact);
            if (result.status === "error") setError(result.error); else setMessage(`${contact.name}님의 연락처를 저장했습니다.`);
        } catch { setError("연락처를 저장하지 못했습니다. 다시 시도해주세요."); }
        finally { setBusy(false); }
    }

    function editContact(studentId: string, changes: Partial<ReminderDashboard["contacts"][number]>) {
        setDashboard(current => current ? { ...current, contacts: current.contacts.map(contact => contact.studentId === studentId ? { ...contact, ...changes } : contact) } : current);
    }
    const selectedExam = dashboard?.exams.find(exam => exam.id === examId);
    const supported = selectedExam && ["group", "targeted"].includes(selectedExam.accessType);
    const contacts = dashboard?.contacts.filter(contact => `${contact.name} ${contact.group} ${contact.studentId}`.includes(search)) || [];

    return <>
        <TeacherHeader />
        <main id="main-content" className={styles.main}>
            <div className={styles.heading}>
                <div><h1>학습 알림</h1><p>마감이 다가오면, 아직 제출하지 않은 학생에게 알려주세요.</p></div>
                <button type="button" className="btn btn-secondary" disabled={loading || busy} onClick={() => void load()}>새로고침</button>
            </div>
            {error && <p role="alert" className={styles.error}>{error}</p>}
            {message && <p role="status" className={styles.notice}>{message}</p>}
            {loading && <p role="status">알림 정보를 불러오는 중입니다.</p>}
            {!loading && !dashboard && <section className={styles.card}>
                <h2>알림 서버 연결이 필요합니다</h2>
                <p>학생 명단과 시험이 저장되는 서버에 연결하면 연락처 등록, 알림 미리보기, 자동 발송을 사용할 수 있습니다.</p>
                <Link href="/teacher/settings#data">서버 연결 상태 확인</Link>
            </section>}
            {readiness && <section className={styles.card}>
                <div className={styles.heading}><h2>발송 상태</h2><StatusPill tone={readiness.mode === "live" ? "warning" : "primary"}
                    label={readiness.mode === "live" ? "실제 발송 모드" : readiness.mode === "disabled" ? "발송 중지" : "미리보기 모드"} /></div>
                <p>{readiness.mode === "dry_run" ? "설정한 시간에 미리보기 기록만 남깁니다. 카카오톡과 문자는 전송되지 않습니다."
                    : readiness.mode === "disabled" ? "자동 알림이 중지되어 있습니다. 연락처와 알림 설정은 관리할 수 있습니다."
                    : "자동 알림을 켠 시험의 미제출 학생에게 메시지를 보냅니다. 메시지별 발송 비용이 발생합니다."}</p>
                <div className={styles.row}><StatusPill label={`카카오톡 ${readiness.kakaoReady ? "설정 완료" : "연결 필요"}`} tone={readiness.kakaoReady ? "success" : "muted"} />
                    <StatusPill label={`문자 ${readiness.smsReady ? "설정 완료" : "연결 필요"}`} tone={readiness.smsReady ? "success" : "muted"} /></div>
                {!!readiness.missing.length && <details><summary>연결에 필요한 서버 설정</summary><p>API 키와 승인된 알림톡 템플릿은 서버 환경변수에 등록합니다.</p><code className={styles.code}>{readiness.missing.join("\n")}</code></details>}
            </section>}
            {dashboard && <>
                <section className={styles.card}>
                    <h2>1. 시험별 알림</h2>
                    <label className={styles.field}>시험 선택<select value={examId} onChange={event => selectExam(event.target.value)} disabled={busy}>
                        <option value="">시험을 선택하세요</option>{dashboard.exams.map(exam => <option key={exam.id} value={exam.id}>{exam.title}</option>)}
                    </select></label>
                    {!dashboard.exams.length && <p>시험을 만들고 반 또는 학생에게 배정하면 이곳에 표시됩니다.</p>}
                    {selectedExam && <>
                        {!supported && <p className={styles.notice}>공개 시험은 수신 대상을 정할 수 없습니다. 시험 배포 설정에서 반 또는 학생을 지정해주세요.</p>}
                        <fieldset disabled={busy} className={styles.form}>
                            <label className={styles.check}><input type="checkbox" checked={settings.enabled} disabled={!supported && !settings.enabled} onChange={event => setSettings({ ...settings, enabled: event.target.checked })} />자동 알림 사용</label>
                            <div className={styles.grid}>
                                <label className={styles.field}>발송 방법<select value={settings.channel} onChange={event => setSettings({ ...settings, channel: event.target.value as ReminderSettings["channel"] })}><option value="kakao">카카오 알림톡</option><option value="sms">문자 (LMS)</option></select></label>
                                <label className={styles.field}>마감 몇 분 전에 알릴까요?<input type="number" min={5} max={10080} value={settings.beforeMinutes} onChange={event => setSettings({ ...settings, beforeMinutes: Number(event.target.value) })} /></label>
                                <label className={styles.field}>마감 후 미제출 알림<select value={settings.overdueMinutes === null ? "off" : String(settings.overdueMinutes)} onChange={event => setSettings({ ...settings, overdueMinutes: event.target.value === "off" ? null : Number(event.target.value) })}><option value="off">보내지 않음</option><option value="0">마감 직후</option><option value="60">1시간 후</option><option value="1440">하루 후</option></select></label>
                                <div className={styles.field}><span>알림을 쉬는 시간 (한국 시간)</span><div className={styles.row}>
                                    <label>시작 <select aria-label="정숙 시작 시간" value={settings.quietStart} onChange={event => setSettings({ ...settings, quietStart: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hour}시</option>)}</select></label>
                                    <label>종료 <select aria-label="정숙 종료 시간" value={settings.quietEnd} onChange={event => setSettings({ ...settings, quietEnd: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hour}시</option>)}</select></label>
                                </div></div>
                            </div>
                            <p>같은 알림은 학생별로 한 번만 보냅니다. 제출한 학생은 제외합니다. 정숙 시간이 끝나도 이미 마감된 사전 알림은 보내지 않습니다. 시작·종료 시간을 같게 설정하면 정숙 시간을 사용하지 않습니다.</p>
                            <div className={styles.row}><button type="button" className="btn btn-primary" onClick={() => void saveSettings()}>설정 저장</button><button type="button" className="btn btn-secondary" disabled={!dashboard.settings.some(item => item.examId === examId)} onClick={() => void showPreview()}>저장된 설정 미리보기</button></div>
                        </fieldset>
                    </>}
                    {preview && <div className={styles.preview}>
                        <h3>현재 미제출 대상 · 알림 {preview.total}건</h3>
                        <p>등록·사용 설정된 연락처만 표시합니다. 실제 대상은 발송 직전에 다시 확인합니다. 시간은 정숙 시간 적용 전 기준이며, 마감 시간이 없는 시험은 제외됩니다.</p>
                        {preview.total === 0 && <p>대상이 없습니다. 연락처 저장·사용 여부, 시험 배정과 마감 시간을 확인해주세요.</p>}
                        {preview.total > 100 && <p>처음 100건을 표시합니다.</p>}
                        {preview.candidates.map((item, index) => <article key={`${item.studentId}:${item.kind}:${index}`} className={styles.previewItem}>
                            <strong>{item.studentName} · {item.phone}</strong><span>{item.kind === "before_deadline" ? "마감 전" : "미제출"} · {formatDate(item.dueAt)}</span><p>{item.text}</p>
                        </article>)}
                    </div>}
                </section>
                <section className={styles.card}>
                    <h2>2. 학생 알림 연락처</h2><p>학생 또는 보호자가 안내받을 휴대전화 번호를 등록하고 사용 여부를 선택해주세요. 학생 이름과 함께 번호를 확인한 뒤 저장하세요.</p>
                    <label className={styles.field}>학생 검색<input type="search" placeholder="이름, 반 또는 학생번호" value={search} onChange={event => setSearch(event.target.value)} /></label>
                    {!contacts.length && <p>표시할 학생이 없습니다. <Link href="/teacher/users">학생 명단 관리</Link></p>}
                    <div className={styles.contacts}>{contacts.slice(0, 100).map(contact => <div key={contact.studentId} className={styles.contact}>
                        <div><strong>{contact.name}</strong><small>{contact.group || contact.studentId}</small></div>
                        <label className={styles.field}><span className="sr-only">{contact.name} 연락처</span><input aria-label={`${contact.name} 연락처`} type="tel" autoComplete="off" maxLength={30} placeholder="010-0000-0000" value={contact.phone} disabled={busy} onChange={event => editContact(contact.studentId, { phone: event.target.value })} /></label>
                        <label className={styles.check}><input aria-label={`${contact.name} 알림 사용`} type="checkbox" checked={contact.enabled} disabled={busy} onChange={event => editContact(contact.studentId, { enabled: event.target.checked })} />사용</label>
                        <button type="button" className="btn btn-secondary" aria-label={`${contact.name} 연락처 저장`} disabled={busy} onClick={() => void saveContact(contact)}>저장</button>
                    </div>)}</div>
                    {contacts.length > 100 && <p>처음 100명만 표시합니다. 검색으로 다른 학생을 찾을 수 있습니다.</p>}
                </section>
                <section className={styles.card}>
                    <h2>3. 최근 알림 기록</h2><p>‘솔라피 접수’는 발송 요청이 접수된 상태입니다. 최종 수신 결과는 솔라피 발송 내역에서 확인하세요. ‘결과 확인 필요’인 건은 중복 방지를 위해 자동 재발송하지 않습니다.</p>
                    {!dashboard.deliveries.length && <p>아직 기록이 없습니다. 설정한 알림 시간이 되면 표시됩니다.</p>}
                    {dashboard.deliveries.map(item => <div key={item.id} className={styles.history}>
                        <div><strong>{item.studentName} · {item.examTitle}</strong><small>{formatDate(item.createdAt)} · 끝자리 {item.phoneLast4} · {item.kind === "before_deadline" ? "마감 전" : "미제출"}</small>{item.providerGroupId && <small>접수번호 {item.providerGroupId}</small>}</div>
                        <StatusPill size="sm" label={statusLabels[item.status]} tone={item.status === "failed" || item.status === "unknown" ? "warning" : "muted"} />
                    </div>)}
                </section>
            </>}
        </main>
    </>;
}
