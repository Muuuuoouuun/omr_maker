# 격리된 Preview QA 계정

이전 환경변수 기반 계정과 샘플 시험을 검증하는 개발용 절차입니다. 현재 운영 교사 로그인은 DB에 발급된 계정을 사용하는 `provisioned_only`이므로, 이 fixture가 운영 로그인 준비를 대신하지 않습니다. 실제 운영 계정은 `npm run ops:teacher:provision`과 [운영 준비 게이트](production-readiness.md)를 사용합니다.

## 안전 경계

- 쓰기 대상은 Vercel **Preview만**입니다. Production 환경은 DB 분리 확인 목적으로만 읽습니다.
- Production과 Preview 모두 유효한 Supabase 프로젝트 URL이 필요하며 같은 프로젝트이면 적용·검증·삭제를 거부합니다.
- 운영 키·계정을 Preview로 복사하지 않습니다. 별도의 QA DB와 service-role 키를 먼저 설정해야 합니다.
- `teacher_sharedqa` 조직에는 합성 테스트 데이터만 넣습니다. 실명·연락처·실제 학생 응시 기록을 넣지 않습니다.
- 과거 문서에 공개했던 비밀번호와 시작 코드는 더 이상 배포할 수 없습니다. 이미 사용했다면 해당 계정의 비밀번호·코드를 폐기/재발급하고 필요한 경우 세션을 회수해야 합니다. 이 로컬 변경만으로 원격 계정이 회수되지는 않습니다.

## 계정 정보 주입

안전한 로컬 환경 또는 비밀 관리 도구에서 다음 JSON 환경변수를 설정합니다. 값은 저장소·명령행 인수·로그·채팅에 남기지 않습니다.

- `OMR_QA_TEACHER_PASSWORDS`: `admin`, `teacher1`, `teacher2`, `teacher3` 각각 서로 다른 16~128자 무작위 비밀번호
- `OMR_QA_STUDENT_START_CODES`: `student1`, `student2`, `student3` 각각 서로 다른 6자리 코드(대문자 A~Z 중 I/O 제외, 숫자 2~9)

교사 역할/계정 요금제는 `admin` 관리자/Academy, `teacher1` 강사/Free, `teacher2` 강사/Pro, `teacher3` 강사/Academy입니다. 조직은 Academy이며 각 계정 요금제는 권한 상한일 뿐 조직 권한을 높이지 않습니다. 교사 비밀번호와 학생 시작 코드는 PBKDF2-SHA256 해시로만 저장합니다.

```bash
npm run accounts:deploy:dry-run
npm run accounts:deploy:apply
npm run accounts:deploy:verify
```

dry-run은 외부 연결 없이 비식별 구조만 출력합니다. apply는 비공개 계정 정보와 DB 분리를 먼저 확인한 다음 Preview의 계정·세션 secret·속도 제한 secret과 테스트 조직/반/학생을 설정합니다. 적용 후 구성을 재검증합니다. Preview의 `TEACHER_ACCOUNTS`를 교체하므로 기존 QA 계정 변경을 의도할 때만 실행합니다.

Vercel은 인증된 `env pull` 검증을 위해 해당 Preview 환경변수를 읽기 가능한 암호화 값으로 보관합니다. 접근 가능한 운영자를 최소화하고, 임시 환경 파일은 전용 디렉터리에 두었다가 종료 시 제거합니다. 값과 해시는 정상 로그에 출력하지 않습니다.

## 샘플 시험

아래 명령도 분리된 Preview DB에만 접근합니다. 각 fixture의 소유권을 확인하며 Production을 수정하지 않습니다. 서버 전용 경계에서 차단되는 직접 쓰기를 허용하려고 운영 RLS를 완화해서는 안 됩니다.

```bash
npm run exams:korean:dry-run
npm run exams:korean:apply
npm run exams:korean:verify
npm run exams:korean:remove
```

이 명령의 존재는 실제 원격 샘플 데이터가 현재 등록되어 있음을 뜻하지 않습니다. 공개 `omr-showcase`는 별도의 읽기 전용 합성 목업입니다.
