"use client";

import { useEffect, useRef, useState } from "react";

/** Keep an editable roster form open until its server mutation has settled. */
export function useRosterFormSubmission<T>(onSubmit: (data: T) => void | Promise<void>, onClose: () => void) {
    const inFlight = useRef(false);
    const [pending, setPending] = useState(false);
    const [submitError, setSubmitError] = useState("");

    useEffect(() => {
        if (!pending) return;
        const preventUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", preventUnload);
        return () => window.removeEventListener("beforeunload", preventUnload);
    }, [pending]);

    const submit = async (data: T) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        setSubmitError("");
        try {
            await onSubmit(data);
        } catch {
            setSubmitError("저장 결과를 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해주세요.");
        } finally {
            inFlight.current = false;
            setPending(false);
        }
    };

    return {
        pending, submitError, submit,
        close: () => { if (!inFlight.current) onClose(); },
    };
}
