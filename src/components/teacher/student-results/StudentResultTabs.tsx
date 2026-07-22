"use client";

import Link from "next/link";
import { BarChart3, FileText, ListChecks, PenLine } from "lucide-react";
import { buildStudentResultHref, type StudentResultView } from "@/lib/studentResultHub";
import styles from "./StudentResultHub.module.css";

interface StudentResultTabsProps {
    attemptId: string;
    activeView: StudentResultView;
}

const tabs: Array<{
    view: StudentResultView;
    label: string;
    Icon: typeof ListChecks;
}> = [
    { view: "answers", label: "답안", Icon: ListChecks },
    { view: "handwriting", label: "필기", Icon: PenLine },
    { view: "report", label: "리포트", Icon: FileText },
    { view: "analytics", label: "분석", Icon: BarChart3 },
];

function focusTab(view: StudentResultView): void {
    document.getElementById(`student-result-tab-${view}`)?.focus();
}

export default function StudentResultTabs({ attemptId, activeView }: StudentResultTabsProps) {
    const handleKeyDown = (event: React.KeyboardEvent<HTMLAnchorElement>, index: number) => {
        let nextIndex: number | null = null;

        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;

        if (nextIndex !== null) {
            event.preventDefault();
            focusTab(tabs[nextIndex].view);
        }
    };

    return (
        <nav className={`${styles.tabs} student-result-report-screen-only`} role="tablist" aria-label="학생 결과 보기">
            {tabs.map(({ view, label, Icon }, index) => {
                const isSelected = view === activeView;

                return (
                    <Link
                        key={view}
                        id={`student-result-tab-${view}`}
                        className={`${styles.tab} ${isSelected ? styles.tabSelected : ""}`}
                        href={buildStudentResultHref(attemptId, view)}
                        role="tab"
                        aria-selected={isSelected}
                        aria-controls={`student-result-panel-${view}`}
                        aria-current={isSelected ? "page" : undefined}
                        tabIndex={isSelected ? 0 : -1}
                        onKeyDown={event => handleKeyDown(event, index)}
                    >
                        <Icon size={18} aria-hidden="true" />
                        <span>{label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
