import type { ReactNode } from "react";
import styles from "./frames.module.css";

function join(...classNames: Array<string | undefined>) {
    return classNames.filter(Boolean).join(" ");
}

/** A light browser window around a product vignette. Purely presentational. */
export function BrowserFrame({ address, className, children }: {
    address: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={join(styles.browser, className)}>
            <div className={styles.browserBar}>
                <span className={styles.browserDots}><span /><span /><span /></span>
                <span className={styles.browserAddress}>{address}</span>
            </div>
            <div className={styles.browserBody}>{children}</div>
        </div>
    );
}

/** A tablet bezel around a real screen capture or vignette. */
export function TabletFrame({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <div className={join(styles.tablet, className)}>
            <span className={styles.tabletCamera} />
            <div className={styles.tabletScreen}>{children}</div>
        </div>
    );
}
