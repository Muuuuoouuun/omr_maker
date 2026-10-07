import type { CSSProperties } from "react";
import Image from "next/image";
import { QRCodeSVG } from "qrcode.react";
import type { LucideIcon } from "lucide-react";
import {
    ChartColumn,
    Check,
    CircleStop,
    Clock3,
    CloudCheck,
    Copy,
    FileText,
    Laptop,
    Link2,
    PenLine,
    Radio,
    Repeat2,
    Send,
    Smartphone,
    Sparkles,
    Tablet,
    TrendingUp,
    Wand2,
} from "lucide-react";
import StatusPill from "@/components/dashboard/StatusPill";
import { resolveSiteOrigin } from "@/lib/siteOrigin";
import solveTablet from "../_assets/solve-tablet.webp";
import { TabletFrame } from "./DeviceFrame";
import {
    CONCEPT_MASTERY,
    EXAMPLE_EXAM_TITLE,
    FAST_ANSWERS,
    GROWTH_SCORES,
    Q8_CHOICES,
    QUESTION_RATES,
    WEAK_RATE,
} from "./exampleData";
import styles from "./vignettes.module.css";

const indexStyle = (index: number) => ({ "--i": index }) as CSSProperties;

function MockHead({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
    return (
        <div className={styles.head}>
            <span className={styles.title}>
                <Icon size={15} aria-hidden="true" />
                {title}
            </span>
            <StatusPill tone="muted" size="sm" label="예시" />
        </div>
    );
}

/* ─── STEP 1 · 출제 ─────────────────────────────────── */

const FAST_DIGITS = FAST_ANSWERS.replace(/\s/g, "").split("");

export function CreateVignette() {
    return (
        <div
            className={`${styles.mock} ${styles.create}`}
            role="img"
            aria-label={`시험 만들기 예시. 문제지 PDF를 올리고, 빠른 정답 입력 칸에 ${FAST_ANSWERS}를 이어 입력하면 1번부터 10번까지 정답이 한 번에 채워집니다.`}
        >
            <MockHead icon={Wand2} title="시험 만들기" />
            <div className={styles.createBody}>
                <div className={styles.sheet}>
                    <span className={styles.sheetTitle}>{EXAMPLE_EXAM_TITLE}</span>
                    {[1, 2, 3, 4].map(number => (
                        <span key={number} className={styles.sheetItem}>
                            <span className={styles.sheetNumber}>{number}.</span>
                            <span className={styles.sheetLines}><span /><span /></span>
                        </span>
                    ))}
                    <span className={styles.sheetFile}><FileText size={12} aria-hidden="true" />problem.pdf · 2쪽</span>
                </div>
                <div className={styles.answers}>
                    <span className={styles.fieldLabel}>빠른 정답 입력</span>
                    <span className={styles.fastField}>
                        <span className={styles.fastValue}>{FAST_ANSWERS}</span>
                        <span className={styles.caret} />
                    </span>
                    <span className={styles.answerGrid}>
                        {FAST_DIGITS.map((answer, index) => (
                            <span key={index} className={styles.answerCell} style={indexStyle(index)}>
                                <span className={styles.answerNumber}>{index + 1}</span>
                                <span className={styles.answerValue}>{answer}</span>
                            </span>
                        ))}
                    </span>
                </div>
            </div>
            <div className={styles.chips}>
                <span className={styles.chip}><Sparkles size={13} aria-hidden="true" />답지 PDF 정답 인식</span>
                <span className={styles.chip}><Check size={13} aria-hidden="true" />배점 · 개념 태그</span>
            </div>
        </div>
    );
}

/* ─── STEP 2 · 배포 ─────────────────────────────────── */

export function ShareVignette() {
    // A real code: scanning it opens the student entry of this deployment.
    const studentEntryUrl = `${resolveSiteOrigin()}/?role=student`;
    return (
        <div
            className={`${styles.mock} ${styles.share}`}
            role="img"
            aria-label="시험 배포 예시. 2학년 1반, 2반, 3반을 함께 골라 하나의 응시 링크와 QR 코드로 보냅니다. 그림 속 QR 코드는 학생 입장 화면으로 연결됩니다."
        >
            <MockHead icon={Send} title="시험 배포" />
            <p className={styles.subject}>{EXAMPLE_EXAM_TITLE}</p>
            <div className={styles.targets}>
                <span className={styles.fieldLabel}>배포할 반 <span className={styles.count}>3개 반 · 90명</span></span>
                <span className={styles.classChips}>
                    {["2학년 1반", "2학년 2반", "2학년 3반"].map(name => (
                        <span key={name} className={styles.classChip}><Check size={12} aria-hidden="true" />{name}</span>
                    ))}
                </span>
            </div>
            <div className={styles.shareCard}>
                <span className={styles.qrTile}>
                    {/* qrcode.react sets role="img"; the illustration's label already covers it. */}
                    <QRCodeSVG value={studentEntryUrl} size={88} level="M" marginSize={0} bgColor="#ffffff" fgColor="#0f172a" aria-hidden="true" />
                </span>
                <span className={styles.shareDetail}>
                    <strong>QR 코드로 바로 입장</strong>
                    <span className={styles.devices}>
                        <Smartphone size={14} aria-hidden="true" />
                        <Tablet size={14} aria-hidden="true" />
                        <Laptop size={14} aria-hidden="true" />
                        폰 · 태블릿 · PC
                    </span>
                </span>
                <span className={styles.linkRow}>
                    <Link2 size={14} aria-hidden="true" />
                    <span className={styles.linkLabel}>학생용 응시 링크</span>
                    <span className={styles.copyButton}><Copy size={12} aria-hidden="true" />복사</span>
                </span>
            </div>
        </div>
    );
}

/* ─── STEP 3 · 응시 (real capture) ──────────────────── */

export function SolveShot() {
    return (
        <div
            className={styles.shot}
            role="img"
            aria-label="실제 응시 화면. 태블릿에서 예시 수학 시험지 위에 펜으로 답을 표시하고, 오른쪽 OMR 답안에 20문항 중 6문항을 마킹했으며, 답안은 자동 저장된 상태입니다."
        >
            <TabletFrame className={styles.shotFrame}>
                <Image
                    src={solveTablet}
                    alt=""
                    sizes="(max-width: 960px) 92vw, 560px"
                    placeholder="blur"
                />
            </TabletFrame>
            <span className={`${styles.callout} ${styles.calloutSave}`} style={indexStyle(0)}><CloudCheck size={14} aria-hidden="true" />3초마다 자동 저장</span>
            <span className={`${styles.callout} ${styles.calloutPen}`} style={indexStyle(1)}><PenLine size={14} aria-hidden="true" />문제지 위 펜 필기</span>
            <span className={`${styles.callout} ${styles.calloutOmr}`} style={indexStyle(2)}>OMR 답안 <strong className="numeric-emphasis">6/20</strong></span>
            <span className={styles.shotCaption}>실제 응시 화면 · 예시 시험지</span>
        </div>
    );
}

/* ─── STEP 4 · 채점 ─────────────────────────────────── */

const LIVE_STATS = [
    { label: "제출 완료", value: "26" },
    { label: "응시 중", value: "3" },
    { label: "미응시", value: "1" },
    { label: "제출 평균", value: "76점" },
] as const;

const LIVE_STUDENTS = [
    { name: "김민준", initial: "민", tone: "success", status: "제출 완료", detail: "92점", progress: 100 },
    { name: "최지우", initial: "지", tone: "primary", status: "응시 중", detail: "18/20", progress: 90 },
    { name: "한지호", initial: "호", tone: "success", status: "제출 완료", detail: "84점", progress: 100 },
    { name: "이서연", initial: "서", tone: "warning", status: "미응시", detail: "—", progress: 0 },
] as const;

export function LiveVignette() {
    return (
        <div
            className={`${styles.mock} ${styles.live}`}
            role="img"
            aria-label="실시간 응시 현황 예시. 남은 시간 8분 12초, 30명 중 26명 제출, 3명 응시 중, 1명 미응시이며 제출 평균은 76점입니다. 제출한 답안은 바로 채점되고, 5분 연장과 종료 처리를 할 수 있습니다."
        >
            <MockHead icon={Radio} title="실시간 응시 현황" />
            <div className={styles.timer}>
                <span className={styles.timerMain}>
                    <span className={styles.timerLabel}>남은 시간</span>
                    <strong className={`${styles.timerValue} numeric-emphasis`}>08:12</strong>
                    <span className={styles.timerExam}>총 50분 · {EXAMPLE_EXAM_TITLE}</span>
                </span>
                <span className={styles.timerActions}>
                    <span className={styles.timerButton}><Clock3 size={13} aria-hidden="true" />+5분 연장</span>
                    <span className={`${styles.timerButton} ${styles.timerStop}`}><CircleStop size={13} aria-hidden="true" />종료 처리</span>
                </span>
            </div>
            <div className={styles.liveStats}>
                {LIVE_STATS.map(stat => (
                    <span key={stat.label} className={styles.liveStat}>
                        <span>{stat.label}</span>
                        <strong className="numeric-emphasis">{stat.value}</strong>
                    </span>
                ))}
            </div>
            <div className={styles.liveCards}>
                {LIVE_STUDENTS.map((student, index) => (
                    <span key={student.name} className={styles.liveCard} data-tone={student.tone} style={indexStyle(index)}>
                        <span className={styles.avatar}>{student.initial}</span>
                        <span className={styles.liveWho}>
                            <strong>{student.name}</strong>
                            <StatusPill tone={student.tone} size="sm" label={student.status} />
                        </span>
                        <strong className={`${styles.liveScore} numeric-emphasis`}>{student.detail}</strong>
                        <span className={styles.liveTrack}>
                            <span className={styles.liveFill} style={{ width: `${student.progress}%` }} />
                        </span>
                    </span>
                ))}
            </div>
        </div>
    );
}

/* ─── STEP 5 · 분석과 보강 ──────────────────────────── */

export function InsightVignette() {
    return (
        <div
            className={`${styles.mock} ${styles.insight}`}
            role="img"
            aria-label="문항별 정답률 예시. 10문항 중 5번이 41%, 8번이 38%로 정답률이 낮습니다. 8번은 정답 ② 38%보다 오답 ③을 고른 학생이 41%로 더 많아, 이 문항들로 보강 세트를 만들 수 있습니다."
        >
            <MockHead icon={ChartColumn} title="문항별 정답률" />
            <div className={styles.barChart}>
                <div className={styles.barPlot}>
                    <span className={`${styles.gridLine} ${styles.gridTop}`}><span className={styles.gridLabel}>100%</span></span>
                    <span className={`${styles.gridLine} ${styles.gridMid}`}><span className={styles.gridLabel}>50%</span></span>
                    {QUESTION_RATES.map((rate, index) => (
                        <span key={index} className={styles.barSlot}>
                            <span
                                className={rate < WEAK_RATE ? `${styles.bar} ${styles.barWeak}` : styles.bar}
                                style={{ height: `${rate}%`, "--i": index } as CSSProperties}
                            >
                                {rate < WEAK_RATE ? <span className={styles.barValue}>{rate}%</span> : null}
                            </span>
                        </span>
                    ))}
                </div>
                <div className={styles.barAxis}>
                    {QUESTION_RATES.map((_, index) => <span key={index}>{index + 1}</span>)}
                </div>
            </div>
            <div className={styles.choices}>
                <p className={styles.choicesHead}><strong>8번</strong> 선지별 응답</p>
                {Q8_CHOICES.map((item, index) => (
                    <span
                        key={item.choice}
                        className={styles.choiceRow}
                        data-kind={"correct" in item ? "correct" : "mostWrong" in item ? "wrong" : undefined}
                        style={indexStyle(index)}
                    >
                        <span className={styles.choiceMark}>{item.choice}</span>
                        <span className={styles.choiceTrack}><span className={styles.choiceFill} style={{ width: `${item.rate}%` }} /></span>
                        <span className={styles.choiceRate}>{item.rate}%</span>
                        <span className={styles.choiceNote}>{"correct" in item ? "정답" : "mostWrong" in item ? "최다 오답" : ""}</span>
                    </span>
                ))}
            </div>
            <span className={styles.retakeAction}>
                <Repeat2 size={14} aria-hidden="true" />
                약한 문항으로 보강 세트 만들기
            </span>
        </div>
    );
}

/* ─── 05 · 미래: 누적 성장 ──────────────────────────── */

const GROWTH_RANGE = { min: 50, max: 100 };
const growthX = (index: number) => (index / (GROWTH_SCORES.length - 1)) * 100;
const growthY = (score: number) => ((GROWTH_RANGE.max - score) / (GROWTH_RANGE.max - GROWTH_RANGE.min)) * 100;

export function GrowthVignette() {
    const last = GROWTH_SCORES.length - 1;
    const line = GROWTH_SCORES
        .map((score, index) => `${index === 0 ? "M" : "L"}${growthX(index).toFixed(2)} ${growthY(score).toFixed(2)}`)
        .join("");
    const point = (index: number) => ({ left: `${growthX(index)}%`, top: `${growthY(GROWTH_SCORES[index])}%` });
    return (
        <div
            className={`${styles.mock} ${styles.growth}`}
            role="img"
            aria-label="한 학생의 누적 성장 예시. 여섯 번의 시험 동안 점수가 62점에서 85점으로 올랐습니다. 개념별 정답률은 연립방정식 88%로 강점, 일차함수 71%, 확률 46%로 보강이 필요합니다."
        >
            <MockHead icon={TrendingUp} title="한 학생의 누적 성장" />
            <div className={styles.lineChart}>
                <div className={styles.linePlot}>
                    <svg className={styles.lineSvg} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                        <line className={styles.svgGrid} x1="0" x2="100" y1="0" y2="0" />
                        <line className={styles.svgGrid} x1="0" x2="100" y1="50" y2="50" />
                        <line className={styles.svgBase} x1="0" x2="100" y1="100" y2="100" />
                        <path className={styles.growthArea} d={`${line}L100 100L0 100Z`} />
                        <path className={styles.growthLine} d={line} />
                    </svg>
                    <span className={styles.lineDot} style={point(last)} />
                    <span className={styles.lineLabel} style={point(0)}>{GROWTH_SCORES[0]}점</span>
                    <span className={`${styles.lineLabel} ${styles.lineLabelEnd}`} style={point(last)}>{GROWTH_SCORES[last]}점</span>
                </div>
                <div className={styles.lineAxis}>
                    {GROWTH_SCORES.map((_, index) => (
                        <span key={index} style={{ left: `${growthX(index)}%` }}>{index + 1}회</span>
                    ))}
                </div>
            </div>
            <div className={styles.mastery}>
                <p className={styles.masteryHead}>개념별 정답률</p>
                {CONCEPT_MASTERY.map((item, index) => (
                    <span
                        key={item.concept}
                        className={styles.masteryRow}
                        data-kind={item.rate < WEAK_RATE ? "weak" : undefined}
                        style={indexStyle(index)}
                    >
                        {/* The note travels with the name so meaning never rests on bar color alone. */}
                        <span className={styles.masteryName}>
                            {item.concept}
                            {"note" in item ? <span className={styles.masteryNote}>{item.note}</span> : null}
                        </span>
                        <span className={styles.masteryTrack}><span className={styles.masteryFill} style={{ width: `${item.rate}%` }} /></span>
                        <span className={styles.masteryRate}>{item.rate}%</span>
                    </span>
                ))}
            </div>
        </div>
    );
}
