# 국어 샘플 시험 적용 평가

검증 대상은 Supabase 공유 QA 조직 `teacher_sharedqa`와 Production 배포본 `https://omr-maker-eight.vercel.app`입니다. 2026-07-22 기준으로 교사 제작·배포부터 학생 응시, 필기, 피드백 리뷰, 오답 재시험까지 실제 서버 데이터로 확인했습니다.

## 등록 결과

| 항목 | 결과 | 확인 내용 |
|---|---|---|
| 시험 제작·등록 | 통과 | 국어 언어와 매체 시험 3개, 각 45문항·100점 |
| 반 배포 | 통과 | `테스트반` 학생 3명에게 그룹 배포 |
| 학생 시험 접근 | 통과 | 학생 1·2 완료 기록, 학생 3은 미응시 시험 3개 노출 |
| 문제지 보안 | 통과 | 비공개 Storage PDF를 권한 확인 뒤 만료형 서명 URL로 제공 |
| OMR·필기 | 통과 | 45문항 답안 입력과 PDF 펜·형광펜·지우개 UI 확인, 학생 1 필기 3쪽·6획 보관 |
| 채점·리뷰 | 통과 | 학생 1은 76점·오답 6·미응답 2, 학생 2는 94점·오답 3 |
| 교사 피드백 | 통과 | 학생 1의 총평과 오답 문항별 피드백 반환 상태 확인 |
| 오답 재시험 | 통과 | 학생 1은 8문항 재시험 18/24점(75%), 학생 2는 3문항 재시험 링크 제공 |
| 분석 대시보드 | 통과 | 시험 3개·제출 3건·문항 135개, 원시험 평균 85점 |
| PDF 문항 위치 | 보완 필요 | 원문을 임의 좌표로 오인식하지 않도록 위치 메타는 비워 둠. 대시보드 품질 92점, 미연결 135건으로 표시 |

## 등록 데이터

- 시험: 3개
- 문항: 135개
- 원시험·재시험 제출: 3건
- 문항별 채점 결과: 98건
- 반환된 교사 피드백: 1건
- 비공개 원격 자산: 문제 PDF 3개, 필기 JSON 1개

시험 PDF는 원본의 공통 영역 1~12쪽과 `언어와 매체` 17~20쪽을 합쳐 각각 16쪽으로 정규화했습니다. 1·12·13·16쪽을 시각 검수해 표지, 공통 영역 종료, 35번 선택과목 시작, 45번 종료를 확인했습니다.

## 정답 근거

- [2025학년도 수능 국어 정답·배점(EBS)](https://wdown.ebsi.co.kr/W61001/01exam/20241114/go3/korB_1_hsj_XE2T11IT.pdf)
- [2026학년도 9월 모평 국어 정답·배점(EBS)](https://wdown.ebsi.co.kr/W61001/01exam/20250903/go3/korB_1_hsj_SVCWW4XL_1.pdf)
- [2026학년도 수능 국어 정답·배점(EBS)](https://wdown.ebsi.co.kr/W61001/01exam/20251113/go3/live_main_answer_1_kor_8ZE3E1XR.pdf)

세 시험 모두 2점 35문항과 3점 10문항으로 100점이며, 정답과 배점은 위 공식 자료를 기준으로 등록했습니다.

## 재검증

```bash
npm run accounts:deploy:verify
npm run exams:korean:verify
RUN_KOREAN_EXAM_FIXTURE_E2E=1 \
PLAYWRIGHT_BASE_URL=https://omr-maker-eight.vercel.app \
npx playwright test e2e/korean-exam-fixture.spec.ts --project=chromium
```

계정 정보는 [배포 테스트 계정](./deployment-test-accounts.md)에 있습니다. 샘플 데이터 생성 규칙과 멱등성 설계는 [Supabase fixture 설계](./superpowers/specs/2026-07-22-korean-exam-supabase-fixture-design.md)를 참고합니다.
