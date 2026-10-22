"use client";

import { useState, type InputHTMLAttributes } from "react";
import styles from "./PasswordInput.module.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/** Visibility stays local to this field and never changes or persists its value. */
export default function PasswordInput(props: Props) {
    const [visible, setVisible] = useState(false);
    return <div className={styles.field}>
        <input {...props} type={visible ? "text" : "password"}
            className={[props.className, styles.input].filter(Boolean).join(" ")} />
        <button type="button" className={styles.toggle} disabled={props.disabled}
            aria-controls={props.id} aria-label={visible ? "비밀번호 숨기기" : "비밀번호 표시"}
            aria-pressed={visible} onClick={() => setVisible(current => !current)}>
            {visible ? "숨기기" : "표시"}
        </button>
    </div>;
}
