# Custom Question Count and 50-Question Recognition Design

## Goal

Allow teachers to configure any exam size from 1 through 50 questions and ensure PDF question-location recognition uses that exact range, including questions 21 through 50.

## Confirmed Root Cause

The creation screen currently exposes only fixed presets: 20, 25, 30, 40, and 50. The PDF location detector itself has no 20-question limit. When given expected question numbers 1 through 45, it detected all 45 questions in both supplied Korean exam PDFs. Configuring 50 as a workaround is unsafe because the 2025 PDF contains body text beginning with "50 배", which can be mistaken for question 50.

## User Interface

Keep the existing preset buttons for fast selection and add a numeric input labeled `문항 수 직접 입력`. The input accepts integers from 1 through 50. Typing is staged locally and commits only on Enter or blur so entering `45` does not temporarily shrink a populated 20-question exam to 4 questions.

Invalid, empty, or out-of-range input restores the current committed count and shows a concise message stating the supported range. Preset buttons continue to commit immediately. Existing confirmation behavior remains in place when reducing the count would remove answered questions.

## Data Flow

Define shared minimum and maximum question-count constants and a parser that accepts only whole-number strings in range. The create page uses the parser when committing the direct input. Once committed, the existing question synchronization effect creates or removes question records, and automatic PDF matching receives the resulting exact question-number set.

Question-count values restored from app defaults, saved exams, or drafts continue to use their existing persistence path. This change does not rewrite stored exams or alter the exam schema.

## Recognition Behavior

Automatic PDF question-location recognition scans exactly the configured questions. A 45-question configuration therefore searches for 1 through 45 and does not search for a nonexistent question 50. Recognition remains text-coordinate based and does not add an AI dependency.

## Error Handling

- Accept only integer values from 1 through 50.
- Restore the last committed value after invalid input.
- Preserve the existing destructive-change confirmation when shrinking answered exams.
- Preserve current cancellation and 90-second timeout behavior for PDF matching.

## Testing

- Unit-test question-count parsing for 1, 45, and 50, plus empty, decimal, below-range, and above-range values.
- Add a PDF detector regression test proving expected questions 21, 45, and 50 are not capped at 20.
- Add a creation-page browser test proving 45 can be entered and produces a 45-question editor state.
- Run the focused unit tests, focused browser test, full unit suite, lint, and production build.
- Re-run the current detector against both supplied PDFs and confirm questions 1 through 45 are found with no missing numbers.

## Scope

This change is limited to question-count configuration and location-recognition coverage up to 50. It does not redesign the OMR preview, change answer-key AI recognition, or increase the maximum beyond 50.
