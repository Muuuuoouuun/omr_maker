# OMR Maker Project Task Plan

## 1. Project Overview

**OMR Maker** is a web-based platform for teachers to create, distribute, and grade OMR-based exams, and for students to take them online and view results.

**Tech Stack**: Next.js 14+, React, TailwindCSS/CSS Modules, LocalStorage (MVP), Gemini AI (Answer Key Extraction).

## 2. Current Status

- **Authentication**: Simple role-based login (Teacher `admin123` / Student with Name & Group).
- **Teacher Features**:
  - Dashboard structure (`/teacher`).
  - Answer Key Import (PDF support + Gemini AI integration).
  - Trend Chart visualization.
- **Student Features**:
  - Dashboard structure (`/student`).
  - Exam taking Interface (`/solve` - to be verified).
- **Core Logic**:
  - `answerParser.ts`: Logic for parsing answer keys from PDFs.

## 3. Immediate Tasks (To-Do)

- [ ] **Teacher Dashboard**:
  - [ ] List created exams.
  - [ ] Create new exam flow (`/create`).
  - [ ] Manage Student Groups (`/groups`).
  - [ ] View Exam Results/Analytics.

- [ ] **Student Dashboard**:
  - [ ] View assigned exams.
  - [ ] Take an exam (OMR Interface).
  - [ ] View past results.
  - [x] **Guest Mode & Merge**: Allow exam taking without login, save to localStorage, merge upon account creation.
- [ ] **Exam Solve Interface (Enhanced)**:
  - [ ] Implement OMR marking UI.
  - [ ] **PDF Handwriting**: Overlay drawing canvas on PDF for tablet users.
  - [ ] **Smart Question Parsing**: Use Gemini Vision to detect question numbers on PDF and make them clickable/touchable input zones.
  - [ ] Timer function.
  - [ ] Auto-submission.
- [ ] **OMR Generation & Scanning**:
  - [ ] Generate printable OMR PDF? (Optional/Future).
  - [ ] Scan physical OMR? (Advanced/Future).

## 4. Backlog / Future Improvements

- [ ] **Database Integration**: Migrate from `localStorage` to a real DB (Supabase/PostgreSQL) for data persistence.
- [ ] **Real Authentication**: Implement secure login/signup.
- [ ] **Export**: Export results to Excel/PDF.
