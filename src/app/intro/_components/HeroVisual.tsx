import type { CSSProperties } from "react";
import { BarChart3, Check, FilePlus2, LayoutGrid, Radio, Repeat2, Users } from "lucide-react";
import { BrandMark } from "@/components/BrandLogo";
import StatusPill from "@/components/dashboard/StatusPill";
import { BrowserFrame } from "./DeviceFrame";
import { EXAMPLE_EXAM_TITLE, QUESTION_RATES, WEAK_RATE } from "./exampleData";
import styles from "./hero.module.css";

const NAV_ICONS = [LayoutGrid, FilePlus2, BarChart3, Users, Radio];
const PAPER_MARKS = ["right", "wrong", "right", "right", "wrong", "right"] as const;

/** Hook visual: the red-pen paper pile (the problem) behind the dashboard that grades on submit. */
export default function HeroVisual() {
    return (
        <div
            className={styles.stage}
            role="img"
            aria-label="빨간 펜으로 채점하던 종이 답안지 더미 앞에, 제출과 동시에 채점이 끝난 OMR Maker 대시보드가 놓인 예시 그림. 90명이 제출했고 평균은 76.4점, 정답률이 낮은 문항은 5번과 8번입니다."
        >
            <div className={styles.paperPile}>
                <span className={`${styles.paper} ${styles.paperBack}`} />
                <span className={`${styles.paper} ${styles.paperMiddle}`} />
                <div className={`${styles.paper} ${styles.paperFront}`}>
                    <span className={styles.paperHeader}>
                        <span className={styles.paperLabel}>2학년 1반 · 수학</span>
                        <span className={styles.paperScore}>72</span>
                    </span>
                    {PAPER_MARKS.map((mark, index) => (
                        <span key={index} className={styles.paperLine}>
                            <span className={mark === "right" ? styles.markRight : styles.markWrong} />
                        </span>
                    ))}
                </div>
            </div>

            {/* The chip hangs off the window's top edge, so it is positioned against the window, not the stage. */}
            <div className={styles.window}>
                <BrowserFrame address="OMR Maker · 시험 결과" className={styles.browser}>
                    <div className={styles.dash}>
                        <div className={styles.dashSide}>
                            <BrandMark className={styles.dashLogo} />
                            {NAV_ICONS.map((Icon, index) => (
                                <span key={index} className={index === 2 ? `${styles.dashNav} ${styles.dashNavActive}` : styles.dashNav}>
                                    <Icon size={15} aria-hidden="true" />
                                </span>
                            ))}
                        </div>
                        <div className={styles.dashMain}>
                            <div className={styles.dashHead}>
                                <div>
                                    <p className={styles.dashTitle}>{EXAMPLE_EXAM_TITLE}</p>
                                    <p className={styles.dashSub}>2학년 1·2·3반 · 방금 마감</p>
                                </div>
                                <StatusPill tone="muted" size="sm" label="예시" />
                            </div>
                            <div className={styles.kpis}>
                                <span className={styles.kpi}>
                                    <span>제출</span>
                                    <strong><span className="numeric-emphasis">90</span><small>/90명</small></strong>
                                </span>
                                <span className={styles.kpi}>
                                    <span>평균</span>
                                    <strong><span className="numeric-emphasis">76.4</span><small>점</small></strong>
                                </span>
                                <span className={`${styles.kpi} ${styles.kpiGrade}`}>
                                    <span>보강 필요</span>
                                    <strong><span className="numeric-emphasis">12</span><small>명</small></strong>
                                </span>
                            </div>
                            <div className={styles.chartCard}>
                                <div className={styles.chartHead}>
                                    <span>문항별 정답률</span>
                                    <span className={styles.legend}><span className={styles.legendKey} />50% 미만</span>
                                </div>
                                <div className={styles.bars}>
                                    {QUESTION_RATES.map((rate, index) => (
                                        <span key={index} className={styles.barSlot}>
                                            <span
                                                className={rate < WEAK_RATE ? `${styles.bar} ${styles.barWeak}` : styles.bar}
                                                style={{ height: `${rate}%`, "--i": index } as CSSProperties}
                                            />
                                        </span>
                                    ))}
                                </div>
                                <div className={styles.axis}>
                                    {QUESTION_RATES.map((_, index) => <span key={index}>{index + 1}</span>)}
                                </div>
                            </div>
                            <div className={styles.action}>
                                <span className={styles.actionText}><strong>8번</strong> 정답률 38% · 최다 오답 ③번</span>
                                <span className={styles.actionChip}><Repeat2 size={12} aria-hidden="true" />보강 세트</span>
                            </div>
                        </div>
                    </div>
                </BrowserFrame>

                <span className={styles.gradedChip}>
                    <span className={styles.gradedIcon}><Check size={13} strokeWidth={3} aria-hidden="true" /></span>
                    제출과 동시에 채점 완료
                </span>
            </div>
        </div>
    );
}
