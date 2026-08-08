"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { TeacherIdentityMode } from "@/lib/teacherIdentityMode";

const TeacherIdentityModeContext = createContext<TeacherIdentityMode>("provisioned_only");

export default function TeacherIdentityModeProvider({
  children,
  mode,
}: Readonly<{
  children: ReactNode;
  mode: TeacherIdentityMode;
}>) {
  return (
    <TeacherIdentityModeContext.Provider value={mode}>
      {children}
    </TeacherIdentityModeContext.Provider>
  );
}

export function useTeacherIdentityMode(): TeacherIdentityMode {
  return useContext(TeacherIdentityModeContext);
}
