# OMR Maker — Pretendard Sync

Figma Desktop에서 현재 OMR Maker 제품 맵의 한글 UI 텍스트를 로컬
`Pretendard`로 일괄 전환한다. 숫자와 통계에 사용한 `Geist`는 유지한다.

1. Figma Desktop에서 제품 맵 파일을 연다.
2. **Plugins → Development → Import plugin from manifest…**를 선택한다.
3. 이 폴더의 `manifest.json`을 선택한다.
4. **Plugins → Development → OMR Maker — Pretendard Sync**를 실행한다.

플러그인은 다음 네 페이지만 순회하며 노드를 삭제하거나 구조를 변경하지 않는다.

- `00 Overview`
- `01 Screen Inventory`
- `02 User Flows`
- `03 Design System`
