# Technical Specifications & Feasibility Analysis

## 1. Student Login & Account Merging

### **Requirement**

Allow students to take exams without logging in (Guest Mode) and merge their data later when they create an account.

### **Database Schema Design (Draft)**

We need a robust User and Attempt tracking system.

- **`users` Table**:
  - `id` (UUID): Primary Key
  - `email`: Nullable (for guest accounts later converted)
  - `is_guest`: Boolean
  - `guest_id`: String (stored in LocalStorage for tracking)
  - `avatar_url`, `name`, `group_id`
- **`attempts` Table**:
  - `id` (UUID)
  - `user_id`: Foreign Key to `users.id`
  - `exam_id`: Foreign Key to `exams.id`
  - `answers`: JSON (the OMR data)
  - `score`, `status` ('in_progress', 'completed')
  - `guest_session_id`: String (to link if user_id is null initially, or just create a temp user)

### **Workflow**

1. **Guest Access**:
    - Student enters exam via Link.
    - System generates a `guest_session_id` in `localStorage`.
    - Exam attempt is saved with `user_id = null` and `guest_session_id = "xyz..."`.
2. **Account Creation / Login**:
    - Student logs in via Google/Email.
    - **Merge Logic**:
        - On successful login, the frontend checks for `guest_session_id` in storage.
        - If found, calls API: `POST /api/auth/merge { guest_id: "xyz..." }`.
        - Backend finds all attempts with that `guest_session_id` and updates `user_id` to the new user's ID.
        - `localStorage` is cleared of guest data.

---

## 2. Interactive PDF Exam Interface

### **Requirement A: Handwriting on PDF (iPad/Tablet support)**

**Feasibility**: ✅ Highly Feasible
**Tech Stack**:

- **PDF Rendering**: `react-pdf` to render the PDF pages as HTML Canvas.
- **Drawing Layer**: `react-sketch-canvas` or `fabric.js` overlaid on top of the PDF canvas.
- **Implementation**:
  - Absolute position a transparent drawing canvas on top of the PDF page.
  - Capture touch/pen events.
  - **Critical**: Must handle window resizing. The drawing coordinates must be relative (%) to the PDF container, not absolute pixels, to ensure responsiveness.

### **Requirement B: Smart Question Parsing (Gemini API)**

**Feasibility**: ✅ Feasible with specific Model Capability (Gemini 1.5 Pro)
**Concept**:

- Teacher uploads PDF.
- **Step 1 (Vision Analysis)**:
  - Send PDF page images to Gemini 1.5 Pro Vision.
  - **Prompt**: *"Identify the bounding box [ymin, xmin, ymax, xmax] for every question number (1, 2, 3...) in this image. Return as JSON: `[{ question: 1, bbox: [0.1, 0.2, 0.15, 0.25] }, ...]`"*
- **Step 2 (Interactive Overlay)**:
  - Frontend receives JSON.
  - Render transparent "Hotspots" (divs) over the PDF at those coordinates.
  - **Interaction**: User taps the question number -> An OMR bubble choice (① ② ③ ④ ⑤) pops up near the finger/cursor.
  - **Error Handling**: If Gemini misses a question (e.g., Q5 is missing), the UI renders a manual "Floating OMR Sheet" on the side so the student can still answer Q5.

### **Technical Challenges & Solutions**

1. **Coordinate Precision**: Gemini might be slightly off.
    - *Solution*: Make the hotspots 200% larger than the detected bounding box (invisible padding) to ensure easy tapping.
2. **PDF Zooming**:
    - *Solution*: All coordinates must be stored as 0-1 percentage values. (`left: ${bbox.xmin * 100}%`).
3. **Performance**:
    - *Solution*: Perform the Gemini analysis *asynchronously* when the teacher uploads the exam, not when the student opens it. Save the coordinate metadata in the DB (`exam_metadata`).

---

## 3. Data Structure Update Plan

To support the above, we need to transition from `localStorage` to a clearer type definition in our code, even if we mock the DB for now.

```typescript
// types/exam.ts extension
interface ExamPage {
  pageNumber: number;
  imageUrl: string; // or PDF page index
  questionHotspots: {
    questionNum: number;
    rect: [number, number, number, number]; // [x, y, w, h] in %
  }[];
}

interface Exam {
  // ... existing fields
  isSmartPdf: boolean;
  pages: ExamPage[];
}
```
