# 배포 테스트 계정

Vercel Preview와 Production에서 하나의 Supabase 테스트 워크스페이스를 공유하는 계정입니다. 간단한 비밀번호는 요청에 따른 QA 전용 값이므로 실제 사용자 계정이나 민감한 학생 데이터에 사용하지 않습니다.

## 교사 계정

| ID | 비밀번호 | 역할 | 유효 요금제 |
|---|---|---|---|
| `admin` | `admin1234` | 관리자 | Academy |
| `teacher1` | `teacher1234` | 강사 | Free |
| `teacher2` | `teacher1234` | 강사 | Pro |
| `teacher3` | `teacher1234` | 강사 | Academy |

네 계정은 모두 `teacher_sharedqa` 조직의 `테스트반`과 학생 3명을 함께 봅니다. 조직의 서버 권위 요금제는 Academy이고, 서명된 계정 요금제는 권한 상한으로 작동합니다. 따라서 `teacher1`은 Free, `teacher2`는 Pro까지만 사용할 수 있으며 계정 상한으로 조직 권한을 높일 수 없습니다.

교사 비밀번호는 Vercel의 `TEACHER_ACCOUNTS`에 원문이 아닌 PBKDF2-SHA256 해시로 저장합니다.

## 학생 계정

학생 로그인 URL:

```text
/?role=student&workspace=teacher_sharedqa
```

| 학생번호 | 이름 | 반 | 지역 | 시작 코드 |
|---|---|---|---|---|
| `student1` | 학생 1 | 테스트반 | 서울 | `ABC234` |
| `student2` | 학생 2 | 테스트반 | 서울 | `BCD345` |
| `student3` | 학생 3 | 테스트반 | 서울 | `CDE456` |

학생은 URL에서 `테스트반`을 선택하고 이름, 학생번호, 시작 코드를 입력합니다. Supabase에는 학생 시작 코드 원문을 저장하지 않고, 서버 로그인용 PBKDF2 해시와 기존 워크스페이스 로그인용 HMAC 메타데이터만 저장합니다.

## 프로비저닝

연결된 Vercel 프로젝트와 Supabase 프로젝트에 계정을 등록합니다.

```bash
npm run accounts:deploy:dry-run
npm run accounts:deploy:apply
npm run accounts:deploy:verify
```

`accounts:deploy:apply`는 다음 작업을 멱등적으로 수행합니다.

- Preview와 Production의 `TEACHER_ACCOUNTS`를 해시된 네 계정으로 설정
- 누락된 `TEACHER_SESSION_SECRET`과 `STUDENT_SESSION_SECRET` 생성
- Academy 테스트 조직과 교사 회원 4명 생성
- 테스트반, 학생 3명, 반 등록 관계, 학생 시작 코드 해시 생성
- 적용 직후 Vercel 구성과 Supabase 행 개수 재검증

기존 Supabase URL·공개 키·서비스 역할 키는 변경하지 않습니다. 스크립트의 dry-run과 정상 완료 로그에는 세션 secret, 서비스 역할 키, 비밀번호 해시를 출력하지 않습니다.

## 샘플 데이터 경계

일반 `admin`과 `teacher1`~`teacher3` 계정에는 합성 시험·학생·분석 데이터를 넣지 않습니다. 데이터가 없으면 실제 빈 상태를 표시합니다. 기존 합성 분석 데이터는 로그인 화면의 공개 `omr-showcase` 목업 계정에서만 표시되며 Supabase 테스트 조직에는 저장되지 않습니다.
