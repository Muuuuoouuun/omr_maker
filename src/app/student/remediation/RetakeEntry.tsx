"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { resolveStudentRemediationRetake } from "@/app/actions/remediation";
import { REMEDIATION_RETAKE_MESSAGES } from "@/lib/remediationRetake";
import styles from "../../teacher/remediation/remediation.module.css";

export default function RetakeEntry({ sourceAttemptId }: { sourceAttemptId: string }) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState("");
    const request = useRef(0);
    const busy = useRef(false);
    useEffect(() => { const counter = request; return () => { counter.current++; }; }, []);

    const enter = async () => {
        if (busy.current) return;
        busy.current = true;
        const current = ++request.current;
        setPending(true); setMessage("");
        try {
            const result = await resolveStudentRemediationRetake(sourceAttemptId);
            if (current !== request.current) return;
            if (result.status === "ready") { router.push(result.href); return; }
            setMessage(REMEDIATION_RETAKE_MESSAGES[result.code]);
        } catch {
            if (current === request.current) setMessage(REMEDIATION_RETAKE_MESSAGES.service_unavailable);
        } finally {
            if (current === request.current) { busy.current = false; setPending(false); }
        }
    };

    return <div>
        <button className="btn btn-primary" disabled={pending} onClick={() => void enter()}>{pending ? "배정 확인 중…" : "배정 확인 후 다시 풀기"}</button>
        {message && <p role="status" className={styles.notice}>{message}</p>}
    </div>;
}
