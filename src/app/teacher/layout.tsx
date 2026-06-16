import type { ReactNode } from "react";
import TeacherAuthGate from "@/components/TeacherAuthGate";

export default function TeacherLayout({ children }: { children: ReactNode }) {
    return <TeacherAuthGate>{children}</TeacherAuthGate>;
}
