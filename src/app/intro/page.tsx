import type { Metadata } from "next";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
    ArrowDown,
    ArrowRight,
    BarChart3,
    Building2,
    Check,
    CheckCircle2,
    Clock3,
    CloudSun,
    Coffee,
    FileText,
    FolderSearch,
    GraduationCap,
    Hourglass,
    Moon,
    PenLine,
    Presentation,
    Repeat2,
    Send,
    Sparkles,
    Sun,
    Sunset,
} from "lucide-react";
import BrandLogo, { BrandMark } from "@/components/BrandLogo";
import SkipToMainContent from "@/components/SkipToMainContent";
import { resolveSiteOrigin } from "@/lib/siteOrigin";
import HeroVisual from "./_components/HeroVisual";
import { FeatureRow, Nudge, SectionHead } from "./_components/StoryBlocks";
import {
    CreateVignette,
    GrowthVignette,
    InsightVignette,
    LiveVignette,
    ShareVignette,
    SolveShot,
} from "./_components/Vignettes";
import styles from "./intro.module.css";

const PAGE_TITLE = "OMR Maker 소개 · 출제부터 보강까지 한 흐름으로";
const PAGE_DESCRIPTION =
    "문제지 PDF로 시험을 만들고, 링크 하나로 배포하고, 제출과 동시에 채점과 분석까지. 채점하던 시간을 가르치는 시간으로 돌려드리는 OMR Maker를 소개합니다.";

// The share image comes from ./opengraph-image.png and its .alt.txt (file
// convention); `npm run intro:images -- share` regenerates it.
export const metadata: Metadata = {
    metadataBase: new URL(resolveSiteOrigin()),
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    alternates: { canonical: "/intro" },
    openGraph: {
        type: "website",
        locale: "ko_KR",
        siteName: "OMR Maker",
        url: "/intro",
        title: PAGE_TITLE,
        description: PAGE_DESCRIPTION,
    },
};

// The showcase (demo) session is started only by the teacher portal's own
// button, which carries the hydration and mockup-authority contracts. Every
// demo CTA here hands off to that portal (intent=demo scrolls its demo card
// into view) instead of minting a second entry.
const DEMO_HREF = "/?role=teacher&intent=demo";
const TEACHER_HREF = "/?role=teacher";
const STUDENT_HREF = "/?role=student";

type CostKey = "time" | "record" | "timing";

const COSTS: Record<CostKey, { index: string; label: string; title: string; body: string; icon: LucideIcon }> = {
    time: {
        index: "①",
        label: "시간",
        title: "채점이 수업 준비를 밀어냅니다",
        body: "답을 대조하고 점수를 옮기는 시간만큼, 다음 수업을 준비할 시간이 줄어듭니다.",
        icon: Clock3,
    },
    record: {
        index: "②",
        label: "기록",
        title: "기록이 여기저기 흩어집니다",
        body: "종이 답안지, 메신저 사진, 엑셀 파일. 지난달 시험 결과를 다시 보려면 서랍부터 뒤져야 합니다.",
        icon: FolderSearch,
    },
    timing: {
        index: "③",
        label: "타이밍",
        title: "피드백이 늦게 도착합니다",
        body: "결과가 정리될 즈음엔 이미 다음 진도입니다. 틀린 개념은 그대로 다음 시험까지 따라옵니다.",
        icon: Hourglass,
    },
};

const solves = (key: CostKey) => `${COSTS[key].index} ${COSTS[key].label}`;

const NAV_ITEMS = [
    { href: "#problem", label: "문제" },
    { href: "#vision", label: "비전" },
    { href: "#features", label: "기능" },
    { href: "#change", label: "변화" },
    { href: "#future", label: "미래" },
] as const;

// The sky icons carry the afternoon-into-night arc of the story.
const EXAM_DAY = [
    { time: "14:50", title: "시험 종료", body: "세 반에서 답안지 90장을 걷습니다.", icon: Sun },
    { time: "16:00", title: "채점 시작", body: "반마다 30명 × 25문항, 750개의 답을 눈으로 대조합니다.", icon: CloudSun },
    { time: "19:30", title: "점수 정리", body: "빨간 펜으로 매긴 점수를 엑셀에 한 칸씩 옮겨 적습니다.", icon: Sunset },
    { time: "22:10", title: "분석은 내일로", body: "몇 번 문제를 왜 많이 틀렸는지는 결국 다음 주의 숙제가 됩니다.", icon: Moon },
] as const;

const LOOP_STEPS = [
    { href: "#feature-create", label: "출제", hint: "PDF로 시험지 만들기", icon: FileText },
    { href: "#feature-share", label: "배포", hint: "링크 하나로 전달", icon: Send },
    { href: "#feature-solve", label: "응시", hint: "어느 기기에서나 풀이", icon: PenLine },
    { href: "#feature-grade", label: "채점", hint: "제출 즉시 자동 채점", icon: CheckCircle2 },
    { href: "#feature-insight", label: "분석·보강", hint: "약점부터 다시", icon: BarChart3 },
] as const;

const BEFORE_DAY = [
    { time: "14:50", text: "답안지 90장 회수" },
    { time: "16:00", text: "반마다 750개의 답 대조" },
    { time: "19:30", text: "엑셀에 점수 옮겨 적기" },
    { time: "22:10", text: "오답 분석은 내일로" },
] as const;

const AFTER_DAY = [
    { time: "14:50", text: "마지막 제출과 함께 채점 완료" },
    { time: "15:00", text: "문항별 정답률과 오답 선지 확인" },
    { time: "15:20", text: "약한 개념으로 보강 세트 배정" },
    { time: "저녁", text: "온전히 선생님의 시간" },
] as const;

// Every figure here is a product fact, not a measured outcome.
const PROOFS = [
    { value: "0", unit: "장", label: "걷고 정리할 종이 답안지" },
    { value: "3", unit: "초", label: "답안 자동 저장 간격" },
    { value: "1", unit: "개", label: "여러 반에 함께 보내는 응시 링크" },
] as const;

const AUDIENCES = [
    {
        who: "선생님",
        title: "다음 수업의 첫 10분이 달라집니다",
        body: "쌓인 오답 데이터가 반 전체가 약한 개념을 먼저 알려줍니다. 수업은 거기서부터 시작하면 됩니다.",
        icon: Presentation,
    },
    {
        who: "학생",
        title: "틀린 문제가 다시 돌아옵니다",
        body: "제출하자마자 결과와 오답을 확인하고, 틀린 문제를 다시 풀며 약점을 메웁니다.",
        icon: GraduationCap,
    },
    {
        who: "학원·기관",
        title: "반과 지역의 흐름이 한눈에 보입니다",
        body: "반별·지역별 성취를 같은 기준으로 비교해, 운영 결정을 감이 아닌 데이터로 내립니다.",
        icon: Building2,
    },
] as const;

function DayList({ items, endIcon: EndIcon }: {
    items: ReadonlyArray<{ time: string; text: string }>;
    endIcon: LucideIcon;
}) {
    return (
        <ol className={styles.dayList}>
            {items.map((item, index) => {
                const isEnd = index === items.length - 1;
                return (
                    <li key={item.time} className={isEnd ? `${styles.dayItem} ${styles.dayItemEnd}` : styles.dayItem}>
                        <span className={`${styles.dayTime} numeric-emphasis`}>{item.time}</span>
                        <span className={styles.dayText}>{item.text}</span>
                        {isEnd ? <EndIcon size={18} aria-hidden="true" className={styles.dayEndIcon} /> : null}
                    </li>
                );
            })}
        </ol>
    );
}

export default function IntroPage() {
    return (
        <div className={styles.page}>
            <SkipToMainContent />

            <header className={styles.topbar}>
                <div className={`${styles.inner} ${styles.topbarInner}`}>
                    <BrandLogo href="/" compact priorityLabel="OMR Maker 앱 홈으로" />
                    <nav className={styles.nav} aria-label="소개 목차">
                        {NAV_ITEMS.map(item => (
                            <a key={item.href} href={item.href} className={styles.navLink}>{item.label}</a>
                        ))}
                    </nav>
                    <div className={styles.topbarActions}>
                        <Link href="/" className={styles.topbarLogin}>로그인</Link>
                        <Link href={DEMO_HREF} className={styles.topbarCta}>데모 체험</Link>
                    </div>
                </div>
            </header>

            <main id="main-content" tabIndex={-1} className={styles.main}>
                {/* ── Hook: the problem, told as the opening line ── */}
                <section className={styles.hero} aria-labelledby="intro-title">
                    <div className={`${styles.inner} ${styles.heroGrid}`}>
                        <div className={styles.heroCopy}>
                            <p className={`${styles.eyebrow} ${styles.rise}`}>
                                <span className={styles.eyebrowDot} aria-hidden="true" />
                                선생님을 위한 온라인 OMR 시험 플랫폼
                            </p>
                            <h1 id="intro-title" className={`${styles.heroTitle} ${styles.rise}`}>
                                시험이 끝나면,
                                <br />
                                <span className={styles.heroTitleAccent}>선생님의 시험</span>이 시작됩니다
                            </h1>
                            <p className={`${styles.heroLead} ${styles.rise}`}>
                                답안지를 걷고, 한 장씩 채점하고, 점수를 엑셀로 옮기다 보면 하루가 저뭅니다.
                                그런데 정작 가장 중요한 질문, ‘누가, 어디서, 왜 틀렸을까’는 다음 수업까지 답을 얻지 못합니다.
                            </p>
                            <div className={`${styles.ctaRow} ${styles.rise}`}>
                                <Link href={DEMO_HREF} className={`btn btn-primary ${styles.ctaButton}`}>
                                    가입 없이 데모 보기
                                    <ArrowRight size={18} aria-hidden="true" />
                                </Link>
                                <a href="#problem" className={`btn btn-secondary ${styles.ctaButton}`}>
                                    이야기 따라가기
                                    <ArrowDown size={18} aria-hidden="true" />
                                </a>
                            </div>
                            <ul className={`${styles.heroNotes} ${styles.rise}`}>
                                <li><Check size={15} aria-hidden="true" />예시 데이터로 바로 둘러보기</li>
                                <li><Check size={15} aria-hidden="true" />설치 없이 브라우저에서</li>
                            </ul>
                        </div>
                        <HeroVisual />
                    </div>
                </section>

                {/* ── 01 Problem ── */}
                <section id="problem" className={styles.section} aria-labelledby="problem-title">
                    <div className={styles.inner}>
                        <SectionHead
                            id="problem-title"
                            number="01"
                            chapter="문제"
                            title="익숙한 시험 날, 이렇게 흘러가지 않나요?"
                            lead="시험 자체는 50분이면 끝납니다. 진짜 일은 그다음부터 시작되죠."
                        />
                        <div className={styles.problemGrid}>
                            <div className={`${styles.timeline} ${styles.reveal}`}>
                                <h3 className={styles.timelineTitle}>
                                    <Clock3 size={18} aria-hidden="true" />
                                    어느 수학 선생님의 시험 날
                                </h3>
                                <ol className={styles.timelineList}>
                                    {EXAM_DAY.map(item => {
                                        const Icon = item.icon;
                                        return (
                                            <li key={item.time} className={styles.timelineItem}>
                                                <span className={`${styles.timelineTime} numeric-emphasis`}>{item.time}</span>
                                                <span className={styles.timelineIcon}><Icon size={15} aria-hidden="true" /></span>
                                                <span className={styles.timelineBody}>
                                                    <strong>{item.title}</strong>
                                                    <span>{item.body}</span>
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ol>
                            </div>
                            <ul className={styles.costList}>
                                {(Object.keys(COSTS) as CostKey[]).map(key => {
                                    const cost = COSTS[key];
                                    const Icon = cost.icon;
                                    return (
                                        <li key={key} className={`${styles.costCard} ${styles.reveal}`}>
                                            <span className={styles.costIcon}><Icon size={20} aria-hidden="true" /></span>
                                            <div>
                                                <p className={styles.costLabel}>숙제 {cost.index} {cost.label}</p>
                                                <h3 className={styles.costTitle}>{cost.title}</h3>
                                                <p className={styles.costText}>{cost.body}</p>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                        <Nudge
                            text="익숙한 장면이라면, 오늘 저녁부터 달라질 수 있습니다."
                            href={DEMO_HREF}
                            label="데모로 확인하기"
                        />
                    </div>
                </section>

                {/* ── 02 Vision ── */}
                <section id="vision" className={`${styles.section} ${styles.sectionTinted}`} aria-labelledby="vision-title">
                    <div className={styles.inner}>
                        <SectionHead
                            id="vision-title"
                            number="02"
                            chapter="비전"
                            title="채점하던 시간을, 가르치는 시간으로"
                            lead="OMR Maker는 시험이 점수를 매기는 일로 끝나지 않고, 다음 수업을 설계하는 출발점이 되어야 한다고 믿습니다. 그래서 출제부터 보강까지 시험의 모든 단계를 끊김 없는 하나의 흐름으로 이었습니다."
                            center
                        />
                        <ol className={styles.loop}>
                            {LOOP_STEPS.map((step, index) => {
                                const Icon = step.icon;
                                return (
                                    <li key={step.href} className={`${styles.loopItem} ${styles.reveal}`}>
                                        <a href={step.href} className={styles.loopLink}>
                                            <span className={styles.loopIcon}><Icon size={20} aria-hidden="true" /></span>
                                            <span className={styles.loopStep}>STEP {index + 1}</span>
                                            <span className={styles.loopLabel}>{step.label}</span>
                                            <span className={styles.loopHint}>{step.hint}</span>
                                        </a>
                                    </li>
                                );
                            })}
                        </ol>
                        <p className={styles.loopReturn}>
                            <Repeat2 size={16} aria-hidden="true" />
                            보강과 재시험은 다시 다음 출제로 이어집니다
                        </p>
                        <p className={styles.visionQuote}>
                            종이를 걷는 대신 데이터가 모이고,
                            <br />
                            숫자를 옮기는 대신 학생을 보게 됩니다.
                        </p>
                        <Nudge
                            text="어떻게 가능한지, 다섯 단계로 보여드릴게요."
                            href="#features"
                            label="기능 살펴보기"
                            icon={ArrowDown}
                        />
                    </div>
                </section>

                {/* ── 03 Features, each tied back to a problem ── */}
                <section id="features" className={styles.section} aria-labelledby="features-title">
                    <div className={styles.inner}>
                        <SectionHead
                            id="features-title"
                            number="03"
                            chapter="기능"
                            title="다섯 단계가 세 가지 숙제를 덜어냅니다"
                            lead="각 단계 옆에 앞에서 본 숙제 중 무엇을 해결하는지 함께 적었습니다."
                        />
                        <div className={styles.featureList}>
                            <FeatureRow
                                id="feature-create"
                                step="STEP 1 · 출제"
                                title="문제지 PDF 한 장으로 시험 준비 끝"
                                body={<>가지고 있는 문제지 PDF를 그대로 올리세요. 정답은 답지 PDF에서 정답 인식 마법사로 추출하거나, <span className={styles.nowrap}>‘31524 25143’</span>처럼 숫자만 이어 쳐서 한 번에 채울 수 있습니다.</>}
                                bullets={[
                                    { text: "답지 PDF 정답 인식 마법사" },
                                    { text: "숫자만 이어 치는 빠른 정답 입력" },
                                    { text: "문항별 배점과 단원·개념 태그" },
                                ]}
                                solves={solves("time")}
                            >
                                <CreateVignette />
                            </FeatureRow>
                            <FeatureRow
                                id="feature-share"
                                step="STEP 2 · 배포"
                                title="링크 하나로, 여러 반에 동시에"
                                body="배포할 반을 고르면 응시 링크와 QR 코드가 만들어집니다. 학생은 폰·태블릿·PC의 브라우저에서 바로 입장하고, 원하면 홈 화면에 앱처럼 설치해 쓸 수 있어요."
                                bullets={[
                                    { text: "여러 반 동시 배포" },
                                    { text: "응시 링크 · QR 코드 · 안내 문구 복사" },
                                    { text: "설치 없이 브라우저에서, 원하면 앱처럼 설치" },
                                ]}
                                solves={solves("record")}
                                reverse
                            >
                                <ShareVignette />
                            </FeatureRow>
                            <FeatureRow
                                id="feature-solve"
                                step="STEP 3 · 응시"
                                title="종이 시험의 감각 그대로, 화면 위에서"
                                body="태블릿에서는 문제지 위에 펜으로 풀이를 적고, 옆의 OMR 답안에 바로 마킹합니다. 답안은 3초마다 자동 저장되어 새로고침해도 답안과 남은 시간이 그대로 돌아오고, 시간이 끝나면 자동으로 제출됩니다."
                                bullets={[
                                    { text: "문제지 PDF 위 펜 필기" },
                                    { text: "3초 자동 저장 · 새로고침 복원" },
                                    { text: "종료 5분 전 알림 · 시간 종료 자동 제출" },
                                ]}
                                solves={solves("record")}
                            >
                                <SolveShot />
                            </FeatureRow>
                            <Nudge
                                text="학생이신가요? 선생님께 받은 링크로 입장하거나, 여기서 바로 시작하세요."
                                href={STUDENT_HREF}
                                label="학생으로 입장하기"
                            />
                            <FeatureRow
                                id="feature-grade"
                                step="STEP 4 · 채점"
                                title="제출하는 순간, 채점은 끝나 있습니다"
                                body="객관식 문항은 제출과 동시에 자동 채점됩니다. 실시간 감독 화면에서 누가 풀고 있는지, 누가 아직 시작하지 않았는지 확인하고, 필요하면 5분 연장이나 종료 처리도 그 자리에서 할 수 있어요."
                                bullets={[
                                    { text: "객관식 즉시 자동 채점" },
                                    { text: "실시간 응시 현황 · 미응시 확인" },
                                    { text: "5분 연장 · 종료 처리" },
                                ]}
                                solves={solves("time")}
                                reverse
                            >
                                <LiveVignette />
                            </FeatureRow>
                            <FeatureRow
                                id="feature-insight"
                                step="STEP 5 · 분석과 보강"
                                title="‘몇 점’을 넘어 ‘왜 틀렸는지’까지"
                                body="문항별 정답률과 가장 많이 고른 오답 선지가 시험이 끝나는 즉시 정리됩니다. 개념별 약점을 비교하고, 많이 틀린 문항으로 보강 세트와 오답 재시험을 바로 배정하세요."
                                bullets={[
                                    { text: "문항별 정답률 · 최다 오답 선지" },
                                    { text: "반별·개념별 약점 비교", pro: true },
                                    { text: "보강 세트 · 오답 재시험 배정", pro: true },
                                ]}
                                solves={solves("timing")}
                            >
                                <InsightVignette />
                            </FeatureRow>
                        </div>
                        <Nudge
                            text="이 분석 화면, 예시 데이터로 지금 바로 열어볼 수 있어요."
                            href={DEMO_HREF}
                            label="데모 대시보드 열기"
                        />
                    </div>
                </section>

                {/* ── 04 Change: the same day, retold ── */}
                <section id="change" className={`${styles.section} ${styles.sectionTinted}`} aria-labelledby="change-title">
                    <div className={styles.inner}>
                        <SectionHead
                            id="change-title"
                            number="04"
                            chapter="변화"
                            title="같은 시험 날, 다른 저녁"
                            lead="도구가 바뀌면 하루의 모양이 바뀝니다. 앞에서 본 그 시험 날을 다시 써 보면 이렇습니다."
                        />
                        <div className={styles.changeGrid}>
                            <div className={`${styles.dayCard} ${styles.dayCardBefore} ${styles.reveal}`}>
                                <h3 className={styles.dayTitle}>지금까지의 시험 날</h3>
                                <DayList items={BEFORE_DAY} endIcon={Moon} />
                            </div>
                            <div className={`${styles.dayCard} ${styles.dayCardAfter} ${styles.reveal}`}>
                                <h3 className={styles.dayTitle}>
                                    <Sparkles size={18} aria-hidden="true" />
                                    OMR Maker와 함께라면
                                </h3>
                                <DayList items={AFTER_DAY} endIcon={Coffee} />
                            </div>
                        </div>
                        <ul className={styles.proofGrid}>
                            {PROOFS.map(proof => (
                                <li key={proof.label} className={`${styles.proof} ${styles.reveal}`}>
                                    <span className={styles.proofValue}>
                                        <span className="numeric-emphasis">{proof.value}</span>
                                        <span className={styles.proofUnit}>{proof.unit}</span>
                                    </span>
                                    <span className={styles.proofLabel}>{proof.label}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>

                {/* ── 05 Future value ── */}
                <section id="future" className={styles.section} aria-labelledby="future-title">
                    <div className={styles.inner}>
                        <SectionHead
                            id="future-title"
                            number="05"
                            chapter="미래"
                            title="시험이 쌓일수록, 학생이 보입니다"
                            lead="한 번의 시험은 점수지만, 열 번의 시험은 성장 곡선이 됩니다. 기록이 쌓일수록 OMR Maker가 보여주는 것도 깊어집니다."
                        />
                        <div className={styles.futureGrid}>
                            <div className={styles.reveal}>
                                <GrowthVignette />
                            </div>
                            <ul className={styles.audienceList}>
                                {AUDIENCES.map(audience => {
                                    const Icon = audience.icon;
                                    return (
                                        <li key={audience.who} className={`${styles.audienceCard} ${styles.reveal}`}>
                                            <span className={styles.audienceIcon}><Icon size={20} aria-hidden="true" /></span>
                                            <div>
                                                <p className={styles.audienceWho}>{audience.who}</p>
                                                <h3 className={styles.audienceTitle}>{audience.title}</h3>
                                                <p className={styles.audienceText}>{audience.body}</p>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    </div>
                </section>

                {/* ── Final CTA ── */}
                <section id="start" className={styles.finalSection} aria-labelledby="start-title">
                    <div className={styles.inner}>
                        <div className={styles.finalPanel}>
                            <span className={styles.finalMark} aria-hidden="true"><BrandMark /></span>
                            <h2 id="start-title" className={styles.finalTitle}>
                                다음 시험부터, 채점은
                                <br />
                                OMR Maker에게 맡기세요
                            </h2>
                            <p className={styles.finalLead}>
                                가입 없이 예시 데이터로 출제부터 분석까지, 전체 흐름을 먼저 둘러보세요.
                            </p>
                            <div className={styles.finalActions}>
                                <Link href={DEMO_HREF} className={styles.finalPrimary}>
                                    데모 계정으로 둘러보기
                                    <ArrowRight size={18} aria-hidden="true" />
                                </Link>
                                <Link href={STUDENT_HREF} className={styles.finalSecondary}>
                                    학생으로 입장하기
                                </Link>
                            </div>
                            <p className={styles.finalNote}>
                                교사 계정은 소속 기관의 운영자가 발급합니다. 이미 계정이 있다면 같은 교사 포털에서 로그인하세요.
                            </p>
                        </div>
                    </div>
                </section>
            </main>

            <footer className={styles.footer}>
                <div className={`${styles.inner} ${styles.footerInner}`}>
                    <p className={styles.footerNote}>OMR Maker · 교사와 학생을 위한 OMR 시험 제작, 배포, 채점</p>
                    <nav aria-label="바로가기">
                        <ul className={styles.footerLinks}>
                            <li><Link href="/">앱 홈</Link></li>
                            <li><Link href={TEACHER_HREF}>교사 포털</Link></li>
                            <li><Link href={STUDENT_HREF}>학생 입장</Link></li>
                            <li><Link href="/pwa-check">앱 상태 체크</Link></li>
                        </ul>
                    </nav>
                </div>
            </footer>
        </div>
    );
}
