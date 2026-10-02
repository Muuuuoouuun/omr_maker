# 초기 운영 qualification 운영자 가이드

이 문서는 최대 100명 초기 운영 후보를 검증하고 승격하는 순서를 정의합니다. 현재 저장소의 공식 상태는
**`UNVERIFIED/NO-GO`**입니다. 로컬 테스트, 로컬 PostgreSQL, mock transport, 또는 수동 확인은 아래의
protected 외부 증거를 substitute할 수 없습니다. 결제 provider 연결과 운영 checkout/webhook은 이 릴리스
범위 밖이며 provider-neutral server-only seam만 비활성 상태로 유지합니다.

## 1. 외부에서 준비해야 하는 입력

| 입력 class | 필수 조건 | 없을 때 상태 |
| --- | --- | --- |
| immutable staging deployment | default branch의 exact 40자리 SHA로 배포한 immutable preview, deployment ID, artifact digest, attestation | `UNVERIFIED` |
| staging Supabase credentials | production과 다른 staging URL/ref, anon/auth/service 역할, PostgreSQL 17 direct/pooler 자격증명, pause confirmation | `UNVERIFIED` |
| disposable restore credentials | staging·production과 모두 다른 app/Supabase/DB, service key, exact target confirmation | `UNVERIFIED` |
| external alert adapter credentials | public HTTPS sink/receipt/ack/resolve와 서로 다른 다섯 credential | `UNVERIFIED` |
| Vercel promotion credentials | protected owner/project/deployment authority 및 exact preview promotion 권한 | `UNVERIFIED` |
| physical Android/iOS evidence | 실제 Android와 iOS에서 설치·takeover·필기·제출·피드백을 같은 SHA로 실행한 결과 | `UNVERIFIED` |
| operator approvals | `initial-operations-staging`과 production environment의 required reviewer, rollback 담당자 | `UNVERIFIED` |

입력 원문, token, project ref, 학생 정보는 evidence bundle에 기록하지 않습니다. workflow가 정한
domain-separated digest만 기록합니다.

### Trusted physical-device attestor 계약

물리기기 evidence는 운영자 노트나 screenshot을 workflow input으로 직접 옮기지 않습니다. Android와 iOS
실행을 관리하는 **trusted attestor 환경**에서 아래 unsigned JSON을 만들고, protected
`OMR_PHYSICAL_DEVICE_EVIDENCE_HMAC_SECRET`을 주입해 저장소 도구로 봉인합니다. 이 secret은 dispatch input,
artifact, 로그에 넣지 않습니다. 입력 파일과 출력 부모는 attestor 실행 uid만 접근 가능한 `0600` 파일과
`0700` 디렉터리여야 합니다.
Secret 값을 shell history나 명령 인자에 직접 입력하지 않고 `set -x`가 꺼진 trusted runner에서 secret
manager가 process에 주입해야 합니다. 이 HMAC key는 preview, alert, Vercel 등 다른 credential과 재사용하지
않습니다. 노출이 의심되거나 attestor 접근 주체가 바뀌면 즉시 rotate하고, 이전 key로 만든 미승격 evidence는
폐기한 뒤 새 key로 물리기기 실행부터 다시 생성합니다.

```json
{
  "schemaVersion": 1,
  "status": "passed",
  "buildSha": "<exact 40 lowercase hex SHA>",
  "previewArtifactDigest": "sha256:<64 lowercase hex>",
  "generatedAt": "2026-08-29T03:45:00.000Z",
  "android": {
    "platform": "android",
    "status": "passed",
    "checkedAt": "2026-08-29T03:30:00.000Z",
    "installed": "passed",
    "takeover": "passed",
    "handwriting": "passed",
    "submission": "passed",
    "feedback": "passed",
    "reportSha256": "<64 lowercase hex>"
  },
  "ios": {
    "platform": "ios",
    "status": "passed",
    "checkedAt": "2026-08-29T03:35:00.000Z",
    "installed": "passed",
    "takeover": "passed",
    "handwriting": "passed",
    "submission": "passed",
    "feedback": "passed",
    "reportSha256": "<different 64 lowercase hex>"
  }
}
```

`reportSha256`은 각 플랫폼의 immutable 원본 device report bytes 전체에 SHA-256을 적용한 **prefix 없는**
lowercase hex입니다. 두 report digest는 달라야 합니다. 모든 timestamp는 canonical UTC ISO-8601이고,
attestation 시각 기준 미래 5분 이내·과거 24시간 이내여야 합니다. exact key 외 필드는 거부됩니다.

```sh
export OMR_BUILD_SHA='<exact 40 lowercase hex SHA>'
export OMR_PREVIEW_ARTIFACT_DIGEST='sha256:<64 lowercase hex>'
# OMR_PHYSICAL_DEVICE_EVIDENCE_HMAC_SECRET은 trusted runner의 secret manager가 process env에 직접 주입합니다.
npm run ops:device:attest -- --input=/absolute/private/physical-device-input.json --output=/absolute/private/physical-device-evidence.json
```

도구는 object key를 재귀적으로 사전순 정렬한 whitespace 없는 UTF-8 JSON을 canonical form으로 사용합니다.
`integrity`는 unsigned object의 `sha256:<hex>`이고, `attestation`은 `integrity`까지 포함한 canonical JSON 앞에
domain bytes `omr.physical-device-evidence:v1\0`을 붙인 HMAC-SHA256(`hmac-sha256:<hex>`)입니다. 출력 파일은
canonical signed JSON과 마지막 LF 한 바이트로 구성됩니다. 성공 stdout의
`physicalDeviceEvidenceB64`를 workflow dispatch `physical_device_evidence_b64`에,
`physicalDeviceEvidenceSha256`을 `physical_device_evidence_sha256`에 그대로 넣습니다. Qualification verifier는
decoded raw bytes digest, exact build/preview, freshness, 두 플랫폼 결과, integrity와 HMAC을 모두 재검증합니다.

## 2. Qualification 실행 전

1. default branch의 exact SHA와 immutable preview build를 일치시킵니다.
2. workload staging, production, disposable restore의 app host와 Supabase project가 모두 다른지 확인합니다.
3. staging write와 asset GC를 일시 중지하고 target-bound confirmation을 protected environment에 넣습니다.
4. `initial-operations-staging` required reviewer가 입력과 실행 범위를 승인합니다.
5. backup/restore와 external alert의 private output parent를 runner 소유 `0700` 디렉터리로 준비합니다.

## 3. Protected qualification 순서

GitHub Actions의 **Initial operations qualification**을 exact SHA로 실행합니다. 순서는 변경하거나 일부만
재사용할 수 없습니다.

1. protected identity, staging/production/restore 격리, exact checkout과 dependency/source gate를 확인합니다.
2. unit, lint, typecheck, build budget, PostgreSQL 17 live assertions를 실행합니다.
3. Chromium 반복 보고서와 WebKit 보고서에서 exact annotated browser proof만 추출합니다.
4. immutable preview에서 health/readiness와 실제 hosted provisioning→login→submit→feedback을 확인합니다.
5. production 경로와 같은 exact **80 students + 10 teacher live pollers + 10 teacher uploaders** workload를
   실행하고 축소된 fixture를 통과로 인정하지 않습니다.
6. 실제 external alert sink→receipt→ack→resolve roundtrip을 실행합니다.
7. 같은 SHA의 staging backup을 disposable target에 **repository-owned streaming restore**로 적용합니다.
   roles→schema→data와 private Storage를 bounded streaming으로 복원하고, repo-owned smoke가
   create→publish→invite→solve→submit→feedback과 disposable credential revocation을 완료해야 합니다.
8. Android와 iOS 모두의 exact-SHA 물리 기기 증거를 protected artifact로 수집하고 24시간 freshness,
   설치·takeover·필기·제출·피드백 결과와 artifact digest를 검증합니다.
9. exact 100 atomic checks와 12 hard gates로 `release-quality-manifest.json`과
   `release-quality-score.json`을 생성하고 같은 canonical path에서 다시 검증합니다.

모든 단계가 성공해야 `QUALIFICATION_COMPLETE`가 게시됩니다. Android 또는 iOS 증거가 없거나 만료되었거나
wrong-SHA이면 `QUALIFICATION_COMPLETE`를 게시하지 않습니다. `.INCOMPLETE`, job failure/cancelled,
누락·만료·wrong-SHA·skipped evidence 중 하나라도 있으면 qualification은 `UNVERIFIED/NO-GO`입니다.

## 4. 증거 보존과 검토

- artifact 이름은 `initial-operations-qualification-<SHA>`이고 retention은 90일입니다.
- build SHA, environment digest, artifact digest, source provenance, browser/PG proof ID, load/alert/restore 결과를
  [release evidence template](release-evidence-template.md)에 연결합니다.
- source/browser/hosted/alert/device evidence freshness는 24시간, restore evidence는 30일입니다.
- raw backup, SQL, Storage body, cookie, token, 답안, provider response는 GitHub artifact에 올리지 않습니다.
- mean 9.3 이상, minimum 8.7 이상, hard gate failure 0이어도 exact-path validator와 protected evidence가
  없으면 GO가 아닙니다.

## 5. Promotion, rollback, disposal

1. protected **Production readiness**(`production-readiness`) workflow가 qualification artifact digest, exact
   preview identity, 물리 기기 artifact digest와 exact SHA를 다시 검증한 뒤에만 production promotion을 수행합니다.
2. promotion 후 production health/readiness, boundary, canary, alert, asset-GC, 변경형 여정을 다시 확인합니다.
3. 실패하면 추가 수정을 현장에서 적용하지 말고 지정된 rollback 담당자가 이전 verified deployment와 DB
   경계로 rollback합니다. 실패한 final evidence는 `NO-GO`로 보존합니다.
4. 성공·실패와 무관하게 staging pause를 해제하기 전에 disposable teacher/student credential을 폐기하고,
   restore target·temporary backup·private runner material을 disposal합니다. 폐기 또는 revocation 실패는
   incident이며 수동 성공으로 바꿀 수 없습니다.

## 6. 보호된 입력이 없는 로컬 확인

다음 명령은 외부 qualification을 대신하지 않습니다. 자격증명이 없는 환경에서 fail-closed 동작만 확인합니다.

```sh
npm run test:ops:initial -- --run
```

예상 결과는 exit 2와 정확한 한 줄입니다.

```json
{"status":"unverified","code":"invalid_staging_config"}
```

이 결과로 점수 파일을 만들거나 평균 9.3/최저 8.7을 달성했다고 주장하지 않습니다. protected workflow와
외부 증거가 실제로 생성될 때까지 릴리스 기록의 최종 판정은 `UNVERIFIED/NO-GO`로 유지합니다.
