# 배포 테스트 계정

운영 배포에서 최소 smoke test를 돌릴 때 쓰는 관리자 1명, 학생 1명 기준입니다.

## 관리자

배포 provider의 서버 환경변수에 아래 값을 설정한 뒤 재배포합니다.

```bash
TEACHER_LOGIN_ID=deploy-admin
TEACHER_EMAIL=deploy-admin@example.edu
TEACHER_NAME=Deployment Test Admin
TEACHER_PASSWORD=<private smoke-test password>
TEACHER_SESSION_SECRET=<private 32+ character random secret>
```

로그인:

- 역할: `교사`
- ID: `deploy-admin`
- 비밀번호: 배포 provider에 설정한 `TEACHER_PASSWORD`

`TEACHER_PASSWORD`와 `TEACHER_SESSION_SECRET`은 저장소에 커밋하지 말고 배포 환경변수에만 둡니다.

## 학생

배포된 앱에서 위 관리자 계정으로 로그인한 뒤 `/teacher/users`에서 `examples/deployment-test-roster.csv`를 가져옵니다.

학생 로그인 정보:

- 역할: `학생`
- 이름: `배포테스트학생`
- 반: `온라인 / 배포 테스트반`
- 학생번호 또는 이메일: `deploy-student-001` 또는 `deploy.student@example.edu`
- 시작 코드: `/teacher/users`에서 해당 학생을 선택하고 `시작 코드`를 발급한 값

학생 시작 코드는 현재 앱 구조상 환경변수 계정 비밀번호가 아니라 명단 기반으로 발급됩니다. 같은 학생으로 반복 테스트하려면 발급된 시작 코드를 보관하고, 분실했거나 기기를 바꾼 경우 관리자 화면에서 재발급합니다.
