import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Check } from "lucide-react";
import StatusPill from "@/components/dashboard/StatusPill";
import styles from "../intro.module.css";

/** Chapter label + h2 + lead for one story section. */
export function SectionHead({ id, number, chapter, title, lead, center = false }: {
    id: string;
    number: string;
    chapter: string;
    title: string;
    lead: string;
    center?: boolean;
}) {
    return (
        <div className={center ? `${styles.sectionHead} ${styles.sectionHeadCenter}` : styles.sectionHead}>
            <p className={styles.chapter}>
                <span className="numeric-emphasis">{number}</span>
                <span aria-hidden="true" className={styles.chapterRule} />
                {chapter}
            </p>
            <h2 id={id} className={styles.sectionTitle}>{title}</h2>
            <p className={styles.sectionLead}>{lead}</p>
        </div>
    );
}

/** Small mid-story CTA: one line of copy and one action. */
export function Nudge({ text, href, label, icon: Icon = ArrowRight }: {
    text: string;
    href: string;
    label: string;
    icon?: LucideIcon;
}) {
    const content = <>{label}<Icon size={16} aria-hidden="true" /></>;
    return (
        <div className={styles.nudge}>
            <p className={styles.nudgeText}>{text}</p>
            {href.startsWith("#")
                ? <a href={href} className={styles.nudgeLink}>{content}</a>
                : <Link href={href} className={styles.nudgeLink}>{content}</Link>}
        </div>
    );
}

/** One feature step: copy (tied to the problem it solves) beside its visual. */
export function FeatureRow({ id, step, title, body, bullets, solves, reverse = false, children }: {
    id: string;
    step: string;
    title: string;
    body: ReactNode;
    bullets: ReadonlyArray<{ text: string; pro?: boolean }>;
    /** The chapter-01 problem this step answers, e.g. "① 시간". */
    solves: string;
    reverse?: boolean;
    children: ReactNode;
}) {
    return (
        <article id={id} aria-labelledby={`${id}-title`} className={reverse ? `${styles.feature} ${styles.featureReverse}` : styles.feature}>
            <div className={styles.featureCopy}>
                <div className={styles.featureMeta}>
                    <span className={styles.featureStep}>{step}</span>
                    <StatusPill tone="primary" size="sm" variant="outline" label={`해결 ${solves}`} />
                </div>
                <h3 id={`${id}-title`} className={styles.featureTitle}>{title}</h3>
                <p className={styles.featureText}>{body}</p>
                <ul className={styles.featureBullets}>
                    {bullets.map(bullet => (
                        <li key={bullet.text}>
                            <Check size={16} aria-hidden="true" />
                            <span>{bullet.text}</span>
                            {bullet.pro ? <StatusPill tone="primary" size="sm" label="Pro" /> : null}
                        </li>
                    ))}
                </ul>
            </div>
            <div className={styles.featureVisual}>{children}</div>
        </article>
    );
}
