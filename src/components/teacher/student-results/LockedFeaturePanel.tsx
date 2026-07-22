import Link from "next/link";
import { Lock } from "lucide-react";
import styles from "./StudentResultHub.module.css";

interface LockedFeaturePanelProps {
    title: string;
    description: string;
    previewItems: string[];
}

export default function LockedFeaturePanel({ title, description, previewItems }: LockedFeaturePanelProps) {
    return (
        <section className={`${styles.panel} ${styles.lockedFeature}`} role="note" aria-label={`${title} 제한`}>
            <Lock className={styles.lockIcon} size={22} aria-hidden="true" />
            <h2>{title}</h2>
            <p>{description}</p>
            <ul>
                {previewItems.map(item => <li key={item}>{item}</li>)}
            </ul>
            <Link className={styles.billingLink} href="/teacher/billing">플랜 보기</Link>
        </section>
    );
}
