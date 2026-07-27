/**
 * OMR Maker — Product Map Builder
 *
 * Builds the four-page Figma product map described in
 *   docs/superpowers/plans/2026-07-24-figma-product-map.md
 *   docs/superpowers/specs/2026-07-24-figma-product-map-design.md
 *
 * Every colour, radius, shadow, type step and motion value below is copied from
 * src/app/globals.css :root. Every route, component and flow is read off the
 * actual App Router tree. The builder invents nothing — if a value is wrong
 * here, it is wrong because the source moved, and the fix is to re-read the
 * source rather than to eyeball a new value.
 *
 * Idempotent: re-running deletes the pages it owns and rebuilds them, so this
 * can be run again after the app changes.
 */

// ───────────────────────────── design tokens ─────────────────────────────
// src/app/globals.css :root — light mode.

const T = {
  primary: '#4F46E5',
  primaryLight: '#818CF8',
  primaryDark: '#3730A3',
  secondary: '#EC4899',
  accent: '#8B5CF6',
  background: '#F8FAFC',
  surface: '#FFFFFF',
  foreground: '#0F172A',
  muted: '#64748B',
  border: '#E2E8F0',
  success: '#10B981',
  error: '#EF4444',
  warning: '#F59E0B',
  gradeRed: '#C02B3C',
  retake: '#0F766E',
  retakeSoft: '#F0FDFA',
  retakeLine: '#99F6E4',
};

// --radius-* (rem → px at 16px root)
const RADIUS = { sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32, full: 9999 };

// --type-* (rem → px). heading-lg / metric are clamp(); the desktop end is used.
const TYPE = {
  micro: 11.2,
  caption: 12.2,
  label: 13.4,
  bodySm: 14.1,
  body: 16,
  headingSm: 16.3,
  headingMd: 17.6,
  headingLg: 39.2,
  metric: 32.8,
};

const PAGE_NAMES = ['00 Overview', '01 Screen Inventory', '02 User Flows', '03 Design System'];
const STAMP = 'Current implementation map · 2026-07-24';

// ───────────────────────────── content data ─────────────────────────────

const PLATFORMS = [
  ['Web / Next.js', 'App Router · React 19 · Turbopack', 'next.config.ts'],
  ['PWA / Installable web app', 'manifest + service worker + startup images', 'src/app/manifest.ts · public/sw.js'],
  ['iOS & Desktop shells', 'same web UI wrapped by Capacitor / Electron', 'capacitor.config.ts · electron/main.mjs'],
];

const PLATFORM_NOTE =
  'Android was dropped as a separately tracked product surface (commit 4666c01). The android/ directory still exists in-tree but is not part of this map.';

const ROLES = [
  ['Teacher', 'create · distribute · monitor · grade · analyze', T.primary],
  ['Student', 'join · solve · submit · review · retake', T.retake],
  ['Shared', 'authentication · sync · PWA · error recovery', T.muted],
];

// [route, title, role, purpose, states, source]
const ROUTES = [
  ['/', '홈 · 역할 선택', 'Public', '학생/교사 진입점과 데모 체험 유도', 'Default · Loading', 'src/app/page.tsx'],
  ['/create', '시험 생성', 'Teacher', 'PDF 업로드 + Gemini 답안 추출로 시험 구성', 'Default · Loading · Error · Locked', 'src/app/create/page.tsx'],
  ['/groups', '반 · 그룹', 'Teacher', '반 편성과 그룹 단위 배포 대상 관리', 'Default · Empty', 'src/app/groups/page.tsx'],
  ['/pwa-check', 'PWA 점검', 'System', '설치 가능 여부·서비스워커·오프라인 진단', 'Default · Offline', 'src/app/pwa-check/page.tsx'],
  ['/solve/[id]', '시험 응시', 'Student', 'OMR 마킹 · PDF 필기 · 타이머 · 자동 제출', 'Default · Loading · Locked · Offline · Complete', 'src/app/solve/[id]/page.tsx'],
  ['/student/dashboard', '학생 대시보드', 'Student', '배정된 시험과 최근 성적 요약', 'Default · Empty · Locked', 'src/app/student/dashboard/page.tsx'],
  ['/student/history', '응시 이력', 'Student', '누적 응시·평균·최고점 추이', 'Default · Empty', 'src/app/student/history/page.tsx'],
  ['/student/review/[attemptId]', '결과 리뷰 · 재시험', 'Student', '오답 필터·문항 도트맵·문항별 질문·재시험', 'Default · Loading · Empty · Complete', 'src/app/student/review/[attemptId]/page.tsx'],
  ['/teacher/dashboard', '교사 대시보드', 'Teacher', '개요 / 시험별 분석 / 학생별 분석 탭', 'Default · Loading · Empty · Error', 'src/app/teacher/dashboard/page.tsx'],
  ['/teacher/exam/[id]', '시험 상세', 'Teacher', '배포 상태·응시 현황·평균 확인', 'Default · Empty', 'src/app/teacher/exam/[id]/page.tsx'],
  ['/teacher/live', '실시간 현황', 'Teacher', '학생별 제출 현황·문항별 정답률·주의 문항', 'Default · Loading · Empty', 'src/app/teacher/live/page.tsx'],
  ['/teacher/attempt/[attemptId]', '응시 상세 · 채점', 'Teacher', '개별 답안 채점·피드백·인쇄/PDF 저장', 'Default · Loading · Error', 'src/app/teacher/attempt/[attemptId]/page.tsx'],
  ['/teacher/users', '학생 · 그룹 관리', 'Teacher', 'CSV 가져오기/내보내기·일괄 이동·삭제 취소', 'Default · Empty · Error', 'src/app/teacher/users/page.tsx'],
  ['/teacher/billing', '요금제 · 결제', 'Teacher', '플랜 확인과 영수증 (실결제 미연동)', 'Default · Locked', 'src/app/teacher/billing/page.tsx'],
  ['/teacher/settings', '설정', 'Teacher', '프로필·테마·백업/복원', 'Default · Error', 'src/app/teacher/settings/page.tsx'],
  ['/_not-found', 'Not Found', 'System', '알 수 없는 경로 복구 안내', 'Error', 'src/app/not-found.tsx'],
];

const ROUTE_GROUPS = [
  ['Public', ['/', '/groups']],
  ['Teacher', ['/create', '/teacher/dashboard', '/teacher/exam/[id]', '/teacher/live', '/teacher/attempt/[attemptId]', '/teacher/users', '/teacher/billing', '/teacher/settings']],
  ['Student', ['/solve/[id]', '/student/dashboard', '/student/history', '/student/review/[attemptId]']],
  ['System', ['/pwa-check', '/_not-found']],
];

const STATE_LEGEND = [
  ['Default', T.primary], ['Loading', T.muted], ['Empty', T.muted],
  ['Error', T.error], ['Complete', T.success], ['Locked', T.warning], ['Offline', T.muted],
];

const FLOWS = [
  ['Teacher — 출제에서 피드백까지', T.primary,
    ['시험 생성', '구성 · 저장', '배포', '실시간 감독', '응시 상세', '분석 · 피드백']],
  ['Student — 입장에서 재시험까지', T.retake,
    ['입장', 'PIN · 권한 확인', '응시', '제출', '결과 리뷰', '오답 재시험']],
  ['Operational — 세션과 복구', T.muted,
    ['세션 확인', '로컬 · 원격 동기화', '재시도 큐', '복구 또는 오류 안내']],
];

const DECISIONS = [
  ['PIN 필요?', 'Yes → PIN 입력 화면 / No → 바로 응시', T.warning],
  ['응시 기간 종료?', 'Yes → 잠금 안내 / No → 응시 계속', T.warning],
  ['오프라인?', 'Yes → 로컬 저장 + 재시도 큐 / No → 즉시 동기화', T.muted],
  ['프리미엄 잠금?', 'Yes → 업그레이드 안내 / No → 기능 실행', T.warning],
  ['데이터 없음?', 'Yes → 빈 상태 + 복구 액션 / No → 정상 렌더', T.error],
];

const PILL_TONES = [
  ['primary', T.primary, 'rgba(99,102,241,0.10)', '기본 · 정보'],
  ['success', T.success, 'rgba(16,185,129,0.10)', '완료 · 정상 동기화'],
  ['warning', T.warning, 'rgba(245,158,11,0.12)', '주의 · 잠금'],
  ['error', T.error, 'rgba(239,68,68,0.10)', '시스템/동기화 실패'],
  ['grade', T.gradeRed, 'rgba(192,43,60,0.08)', '채점 오답 — 시스템 오류 아님'],
  ['retake', T.retake, T.retakeSoft, '재시험 (제품 개념)'],
  ['muted', T.muted, 'rgba(100,116,139,0.10)', '중립 · 보조'],
];

const SEMANTIC_COLORS = [
  ['Color/Background', T.background, '--background', 'FRAME_FILL,SHAPE_FILL'],
  ['Color/Surface', T.surface, '--surface', 'FRAME_FILL,SHAPE_FILL'],
  ['Color/Foreground', T.foreground, '--foreground', 'TEXT_FILL'],
  ['Color/Muted', T.muted, '--muted', 'TEXT_FILL'],
  ['Color/Border', T.border, '--border', 'STROKE_COLOR'],
  ['Color/Primary', T.primary, '--primary', 'FRAME_FILL,SHAPE_FILL,TEXT_FILL'],
  ['Color/Success', T.success, '--success', 'FRAME_FILL,SHAPE_FILL,TEXT_FILL'],
  ['Color/Warning', T.warning, '--warning', 'FRAME_FILL,SHAPE_FILL,TEXT_FILL'],
  ['Color/Error', T.error, '--error', 'FRAME_FILL,SHAPE_FILL,TEXT_FILL'],
  ['Color/Grade Red', T.gradeRed, '--grade-red', 'FRAME_FILL,SHAPE_FILL,TEXT_FILL'],
  ['Color/Retake', T.retake, '--retake', 'FRAME_FILL,SHAPE_FILL,TEXT_FILL'],
];

const TYPE_SCALE = [
  ['micro', TYPE.micro, '--type-micro', '0.7rem'],
  ['caption', TYPE.caption, '--type-caption', '0.76rem'],
  ['label', TYPE.label, '--type-label', '0.84rem'],
  ['body-sm', TYPE.bodySm, '--type-body-sm', '0.88rem'],
  ['heading-sm', TYPE.headingSm, '--type-heading-sm', '1.02rem'],
  ['heading-md', TYPE.headingMd, '--type-heading-md', '1.1rem'],
  ['heading-lg', TYPE.headingLg, '--type-heading-lg', 'clamp(1.8rem, 3vw, 2.45rem)'],
  ['metric', TYPE.metric, '--type-metric', 'clamp(1.6rem, 2.2vw, 2.05rem)'],
];

const ELEVATION = [
  ['sm', '--shadow-sm', 1, 2, 0.05],
  ['md', '--shadow-md', 6, 16, 0.08],
  ['lg', '--shadow-lg', 14, 32, 0.12],
  ['xl', '--shadow-xl', 24, 48, 0.16],
];

const MOTION = [
  ['fast', '--transition-fast', '0.15s cubic-bezier(0.4, 0, 0.2, 1)'],
  ['base', '--transition-base', '0.3s cubic-bezier(0.4, 0, 0.2, 1)'],
  ['smooth', '--transition-smooth', '0.5s cubic-bezier(0.25, 1, 0.5, 1)'],
  ['spring', '--transition-spring', '0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'],
];

// ───────────────────────────── font handling ─────────────────────────────

let FONT = { regular: null, medium: null, semibold: null, bold: null, family: null, fallback: false };

const FAMILY_PREFERENCE = [
  'Pretendard Variable', 'Pretendard', 'Pretendard JP Variable',
  'Noto Sans KR', 'Apple SD Gothic Neo', 'Spoqa Han Sans Neo',
  'Noto Sans', 'Inter', 'Roboto',
];

async function resolveFonts() {
  const available = await figma.listAvailableFontsAsync();
  const byFamily = new Map();
  for (const f of available) {
    if (!byFamily.has(f.fontName.family)) byFamily.set(f.fontName.family, []);
    byFamily.get(f.fontName.family).push(f.fontName.style);
  }

  let family = FAMILY_PREFERENCE.find(f => byFamily.has(f));
  if (!family) family = 'Inter';
  FONT.family = family;
  FONT.fallback = !/^Pretendard/.test(family);

  const styles = byFamily.get(family) || ['Regular'];
  const pick = (...wanted) => wanted.find(s => styles.includes(s)) || styles[0];

  FONT.regular = { family, style: pick('Regular', 'Book', 'Normal') };
  FONT.medium = { family, style: pick('Medium', 'Regular') };
  FONT.semibold = { family, style: pick('SemiBold', 'Semibold', 'DemiBold', 'Bold', 'Medium') };
  FONT.bold = { family, style: pick('Bold', 'ExtraBold', 'Black', 'SemiBold') };

  const unique = [];
  for (const f of [FONT.regular, FONT.medium, FONT.semibold, FONT.bold]) {
    if (!unique.some(u => u.style === f.style)) unique.push(f);
  }
  for (const f of unique) await figma.loadFontAsync(f);
}

// ───────────────────────────── node helpers ─────────────────────────────

function rgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/** Parses "rgba(r,g,b,a)" or "#rrggbb" into a Figma solid paint. */
function paint(color, opacityOverride) {
  const m = /^rgba?\(([^)]+)\)$/.exec(color);
  if (m) {
    const [r, g, b, a] = m[1].split(',').map(v => parseFloat(v.trim()));
    return { type: 'SOLID', color: { r: r / 255, g: g / 255, b: b / 255 }, opacity: a === undefined ? 1 : a };
  }
  const p = { type: 'SOLID', color: rgb(color) };
  if (opacityOverride !== undefined) p.opacity = opacityOverride;
  return p;
}

function shadow(y, blur, alpha) {
  return {
    type: 'DROP_SHADOW', color: { r: 0.059, g: 0.09, b: 0.165, a: alpha },
    offset: { x: 0, y }, radius: blur, spread: 0, visible: true, blendMode: 'NORMAL',
  };
}

/**
 * Auto Layout frame. Everything in this file uses Auto Layout so the delivered
 * frames stay editable and reflow instead of being a pile of absolute boxes.
 */
function frame(name, o) {
  o = o || {};
  const f = figma.createFrame();
  f.name = name;
  f.layoutMode = o.horizontal ? 'HORIZONTAL' : 'VERTICAL';
  f.itemSpacing = o.gap === undefined ? 12 : o.gap;
  const p = o.padding === undefined ? 0 : o.padding;
  f.paddingTop = o.paddingTop === undefined ? p : o.paddingTop;
  f.paddingBottom = o.paddingBottom === undefined ? p : o.paddingBottom;
  f.paddingLeft = o.paddingLeft === undefined ? p : o.paddingLeft;
  f.paddingRight = o.paddingRight === undefined ? p : o.paddingRight;
  // Hug on both axes by default. Width is then pinned via layoutSizingHorizontal
  // rather than primary/counterAxisSizingMode, because which of those two means
  // "width" flips with layoutMode — setting them directly silently locked the
  // HEIGHT of every vertical frame that asked for a width.
  f.primaryAxisSizingMode = 'AUTO';
  f.counterAxisSizingMode = 'AUTO';
  if (o.horizontal) f.counterAxisAlignItems = o.align || 'MIN';
  if (o.width) { f.resize(o.width, f.height); f.layoutSizingHorizontal = 'FIXED'; }
  // layoutWrap requires HORIZONTAL + a fixed primary axis, so it must follow the
  // width pin above; every wrapping frame in this file passes an explicit width.
  if (o.wrap && o.horizontal) f.layoutWrap = 'WRAP';
  f.fills = o.fill ? [paint(o.fill)] : [];
  if (o.stroke) { f.strokes = [paint(o.stroke)]; f.strokeWeight = o.strokeWeight || 1; }
  f.cornerRadius = o.radius === undefined ? 0 : o.radius;
  if (o.shadow) f.effects = [o.shadow];
  f.clipsContent = false;
  return f;
}

function text(content, o) {
  o = o || {};
  const t = figma.createText();
  t.fontName = o.font || FONT.regular;
  t.characters = String(content);
  t.fontSize = o.size || TYPE.body;
  t.fills = [paint(o.color || T.foreground)];
  t.lineHeight = { unit: 'PERCENT', value: o.lineHeight || 150 };
  if (o.width) {
    t.textAutoResize = 'HEIGHT';
    t.resize(o.width, t.height);
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  if (o.letterSpacing) t.letterSpacing = { unit: 'PERCENT', value: o.letterSpacing };
  return t;
}

function add(parent, children) {
  for (const c of children) if (c) parent.appendChild(c);
  return parent;
}

/** Rounded tinted chip — the Figma analogue of StatusPill. */
function chip(label, color, bg) {
  const c = frame('chip / ' + label, {
    horizontal: true, gap: 6, paddingLeft: 12, paddingRight: 12,
    paddingTop: 6, paddingBottom: 6, radius: RADIUS.full,
    fill: bg || color, stroke: color, align: 'CENTER',
  });
  if (!bg) c.fills = [paint(color, 0.1)];
  c.strokes = [paint(color, 0.28)];
  add(c, [text(label, { size: TYPE.caption, color, font: FONT.semibold })]);
  return c;
}

/** Standard documentation card: title, optional subtitle, body lines, source path. */
function card(title, opts) {
  opts = opts || {};
  const w = opts.width || 320;
  const f = frame('card / ' + title, {
    width: w, gap: 8, padding: 20, radius: RADIUS.lg,
    fill: T.surface, stroke: T.border, shadow: shadow(6, 16, 0.06),
  });
  const head = text(title, { size: TYPE.headingSm, font: FONT.bold, width: w - 40 });
  add(f, [head]);
  if (opts.accent) {
    const bar = figma.createRectangle();
    bar.name = 'accent';
    bar.resize(40, 3);
    bar.cornerRadius = RADIUS.full;
    bar.fills = [paint(opts.accent)];
    f.insertChild(0, bar);
  }
  for (const line of opts.lines || []) {
    add(f, [text(line, { size: TYPE.bodySm, color: T.muted, width: w - 40 })]);
  }
  if (opts.chips && opts.chips.length) {
    const row = frame('chips', { horizontal: true, gap: 6, wrap: true, width: w - 40 });
    add(row, opts.chips.map(c => chip(c[0], c[1])));
    add(f, [row]);
  }
  if (opts.source) {
    add(f, [text(opts.source, {
      size: TYPE.micro, color: T.muted, font: FONT.medium, width: w - 40, letterSpacing: 1,
    })]);
  }
  return f;
}

function sectionTitle(label, note) {
  const f = frame('section / ' + label, { gap: 4 });
  add(f, [
    text(label, { size: TYPE.headingMd, font: FONT.bold }),
    note ? text(note, { size: TYPE.bodySm, color: T.muted, width: 760 }) : null,
  ]);
  return f;
}

function section(label, note, body) {
  const f = frame('▸ ' + label, { gap: 16 });
  add(f, [sectionTitle(label, note), body]);
  return f;
}

function row(children, gap, wrap, width) {
  const f = frame('row', { horizontal: true, gap: gap === undefined ? 16 : gap, wrap: !!wrap, width });
  return add(f, children);
}

// ───────────────────────────── page scaffolding ─────────────────────────────

const created = { pages: [], headers: [], nodes: {} };

function pageHeader(title) {
  const h = frame('header / ' + title, {
    gap: 6, paddingTop: 8, paddingBottom: 8, paddingLeft: 16,
  });
  const bar = figma.createRectangle();
  bar.name = 'rule';
  bar.resize(4, 76);
  bar.cornerRadius = RADIUS.full;
  bar.fills = [paint(T.primary)];

  const copy = frame('copy', { gap: 4 });
  add(copy, [
    text('OMR Maker', { size: TYPE.label, color: T.primary, font: FONT.bold, letterSpacing: 6 }),
    text(title, { size: TYPE.headingLg, font: FONT.bold, lineHeight: 120 }),
    text(STAMP, { size: TYPE.bodySm, color: T.muted }),
  ]);

  const wrap = frame('header', { horizontal: true, gap: 16, align: 'CENTER' });
  add(wrap, [bar, copy]);
  add(h, [wrap]);
  return h;
}

/** Top-level wrapper frame every page gets, per Task 7 Step 1. */
function pageWrapper(title, blocks) {
  const w = frame(title, {
    gap: 48, padding: 64, fill: T.background, radius: RADIUS.xl,
  });
  const header = pageHeader(title);
  created.headers.push(header);
  add(w, [header]);
  add(w, blocks);
  w.clipsContent = false;
  return w;
}

// ───────────────────────────── 00 Overview ─────────────────────────────

function buildOverview() {
  const platforms = row(PLATFORMS.map(([name, detail, src], i) => {
    const c = card(name, { width: 300, lines: [detail], source: src, accent: [T.primary, T.accent, T.secondary][i] });
    return c;
  }), 20, true, 1000);

  const platformNote = text(PLATFORM_NOTE, { size: TYPE.bodySm, color: T.muted, width: 760 });
  const platformBlock = frame('platforms', { gap: 12 });
  add(platformBlock, [platforms, platformNote]);

  const roles = row(ROLES.map(([name, detail, color]) =>
    card(name, { width: 300, lines: [detail], accent: color })), 20, true, 1000);

  const routeMap = frame('route map', { gap: 20, horizontal: true, wrap: true, width: 1000 });
  for (const [group, routes] of ROUTE_GROUPS) {
    const col = frame('group / ' + group, {
      width: 470, gap: 10, padding: 20, radius: RADIUS.lg, fill: T.surface, stroke: T.border,
    });
    add(col, [text(group, { size: TYPE.label, font: FONT.bold, color: T.primary, letterSpacing: 4 })]);
    for (const r of routes) {
      const meta = ROUTES.find(x => x[0] === r);
      const line = frame('route / ' + r, { horizontal: true, gap: 10, align: 'CENTER', width: 430 });
      const code = frame('code', {
        paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3,
        radius: RADIUS.sm, fill: T.background, stroke: T.border,
      });
      add(code, [text(r, { size: TYPE.micro, font: FONT.medium, color: T.foreground })]);
      add(line, [code, text(meta ? meta[1] : '', { size: TYPE.caption, color: T.muted })]);
      add(col, [line]);
    }
    add(routeMap, [col]);
  }

  const legend = row(STATE_LEGEND.map(([label, color]) => chip(label, color)), 10, true, 1000);

  return pageWrapper('00 Overview', [
    section('플랫폼', '하나의 웹 UI를 PWA와 네이티브 셸이 공유한다.', platformBlock),
    section('역할', '교사·학생·공용 관심사의 경계.', roles),
    section('라우트 맵 · 16개', 'App Router 기준 전체 라우트. 코드 경로는 Screen Inventory에 있다.', routeMap),
    section('화면 상태 범례', '인벤토리의 각 화면 카드가 이 범례를 참조한다.', legend),
  ]);
}

// ───────────────────────────── 01 Screen Inventory ─────────────────────────────

function inventoryCard(r) {
  const [route, title, role, purpose, states, source] = r;
  const roleColor = role === 'Teacher' ? T.primary : role === 'Student' ? T.retake : T.muted;
  const w = 470;
  const f = frame('screen / ' + route, {
    width: w, gap: 10, padding: 20, radius: RADIUS.lg,
    fill: T.surface, stroke: T.border, shadow: shadow(6, 16, 0.06),
  });

  const top = frame('top', { horizontal: true, gap: 10, align: 'CENTER', width: w - 40 });
  add(top, [text(title, { size: TYPE.headingSm, font: FONT.bold }), chip(role, roleColor)]);

  const code = frame('route', {
    paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
    radius: RADIUS.sm, fill: T.background, stroke: T.border,
  });
  add(code, [text(route, { size: TYPE.caption, font: FONT.medium })]);

  const stateRow = frame('states', { horizontal: true, gap: 6, wrap: true, width: w - 40 });
  for (const s of states.split(' · ')) {
    const entry = STATE_LEGEND.find(x => x[0] === s);
    add(stateRow, [chip(s, entry ? entry[1] : T.muted)]);
  }

  add(f, [
    top, code,
    text(purpose, { size: TYPE.bodySm, color: T.muted, width: w - 40 }),
    stateRow,
    text(source, { size: TYPE.micro, color: T.muted, font: FONT.medium, width: w - 40, letterSpacing: 1 }),
  ]);
  return f;
}

/** Editable 1440 teacher-dashboard representative (Task 4 Step 2). */
function desktopRepresentative() {
  const W = 1440;
  const shell = frame('Desktop 1440 — /teacher/dashboard', {
    width: W, gap: 0, fill: T.background, radius: RADIUS.lg, stroke: T.border,
  });
  shell.clipsContent = true;

  // Header — mirrors TeacherHeader.tsx: brand, search, actions.
  const header = frame('TeacherHeader', {
    horizontal: true, width: W, gap: 16, paddingLeft: 32, paddingRight: 32,
    paddingTop: 18, paddingBottom: 18, fill: T.surface, align: 'CENTER',
  });
  const brand = frame('brand', { horizontal: true, gap: 10, align: 'CENTER' });
  const mark = figma.createRectangle();
  mark.name = 'BrandLogo';
  mark.resize(28, 28); mark.cornerRadius = RADIUS.sm; mark.fills = [paint(T.primary)];
  add(brand, [mark, text('OMR Maker', { size: TYPE.headingSm, font: FONT.bold })]);

  const search = frame('GlobalSearch', {
    width: 380, horizontal: true, gap: 8, paddingLeft: 14, paddingRight: 14,
    paddingTop: 9, paddingBottom: 9, radius: RADIUS.md, fill: T.background, stroke: T.border, align: 'CENTER',
  });
  add(search, [text('시험 · 학생 검색', { size: TYPE.bodySm, color: T.muted }), text('⌘K', { size: TYPE.micro, color: T.muted, font: FONT.medium })]);

  const spacer = frame('spacer', { horizontal: true });
  spacer.layoutGrow = 1;

  const actions = frame('actions', { horizontal: true, gap: 8, align: 'CENTER' });
  add(actions, [chip('동기화 완료', T.success), chip('Pro', T.primary), text('알림 · 테마 · 로그아웃', { size: TYPE.caption, color: T.muted })]);
  add(header, [brand, search, spacer, actions]);

  const body = frame('body', { width: W, gap: 24, padding: 32 });

  // KPI rail — four StatCards.
  const KPI = [
    ['전체 학생', '128', '명', T.primary],
    ['평균 점수', '82.4', '점', T.success],
    ['진행 중 시험', '6', '개', T.warning],
    ['오답 재시험', '19', '건', T.retake],
  ];
  const kpiRow = frame('KPI rail', { horizontal: true, gap: 16, width: W - 64 });
  for (const [label, value, unit, color] of KPI) {
    const c = frame('StatCard / ' + label, {
      gap: 8, padding: 20, radius: RADIUS.lg, fill: T.surface, stroke: T.border, shadow: shadow(6, 16, 0.06),
    });
    c.layoutGrow = 1;
    const valueRow = frame('value', { horizontal: true, gap: 4, align: 'BASELINE' });
    add(valueRow, [
      text(value, { size: TYPE.metric, font: FONT.bold, color }),
      text(unit, { size: TYPE.label, color: T.muted, font: FONT.medium }),
    ]);
    add(c, [text(label, { size: TYPE.label, color: T.muted, font: FONT.medium }), valueRow]);
    add(kpiRow, [c]);
  }

  const tabs = frame('tabs', { horizontal: true, gap: 8 });
  ['개요', '시험별 분석', '학생별 분석'].forEach((label, i) => {
    const t = frame('tab / ' + label, {
      paddingLeft: 16, paddingRight: 16, paddingTop: 9, paddingBottom: 9,
      radius: RADIUS.full, fill: i === 0 ? T.primary : T.surface, stroke: i === 0 ? T.primary : T.border,
    });
    add(t, [text(label, { size: TYPE.bodySm, font: FONT.semibold, color: i === 0 ? T.surface : T.muted })]);
    add(tabs, [t]);
  });

  const cols = frame('content', { horizontal: true, gap: 24, width: W - 64 });

  const listCard = frame('ExamListBlock', {
    gap: 12, padding: 20, radius: RADIUS.lg, fill: T.surface, stroke: T.border, shadow: shadow(6, 16, 0.06),
  });
  listCard.layoutGrow = 1;
  add(listCard, [text('최근 시험', { size: TYPE.headingSm, font: FONT.bold })]);
  const EXAMS = [
    ['2학기 중간고사 · 수학', '응시 24/28', T.success],
    ['단원평가 3단원 · 영어', '응시 12/28', T.warning],
    ['오답 재시험 · 수학', '재시험 7건', T.retake],
  ];
  for (const [name, meta, tone] of EXAMS) {
    const r = frame('exam row', {
      horizontal: true, gap: 12, align: 'CENTER', paddingTop: 10, paddingBottom: 10,
    });
    const grow = frame('label', { gap: 2 });
    grow.layoutGrow = 1;
    add(grow, [text(name, { size: TYPE.bodySm, font: FONT.semibold }), text(meta, { size: TYPE.caption, color: T.muted })]);
    add(r, [grow, chip('상세', tone)]);
    add(listCard, [r]);
  }

  const analytics = frame('Analytics region', {
    width: 420, gap: 12, padding: 20, radius: RADIUS.lg, fill: T.surface, stroke: T.border, shadow: shadow(6, 16, 0.06),
  });
  add(analytics, [text('점수 추이', { size: TYPE.headingSm, font: FONT.bold })]);
  const chart = frame('TrendChart', { horizontal: true, gap: 8, align: 'MAX', width: 380 });
  [46, 62, 55, 74, 68, 81, 88].forEach((h, i) => {
    const bar = figma.createRectangle();
    bar.name = 'bar ' + (i + 1);
    bar.resize(44, h * 1.6);
    bar.cornerRadius = RADIUS.sm;
    bar.fills = [paint(T.primary, 0.35 + i * 0.09)];
    add(chart, [bar]);
  });
  add(analytics, [chart, row([chip('평균 82.4', T.success), chip('오답률 17.6%', T.gradeRed)], 8)]);

  add(cols, [listCard, analytics]);
  add(body, [kpiRow, tabs, cols]);
  add(shell, [header, body]);
  return shell;
}

/** Editable 390 student-review representative (Task 4 Step 3). */
function mobileRepresentative() {
  const W = 390;
  const shell = frame('Mobile 390 — /student/review/[attemptId]', {
    width: W, gap: 0, fill: T.background, radius: RADIUS.lg, stroke: T.border,
  });
  shell.clipsContent = true;

  const header = frame('compact header', {
    horizontal: true, width: W, gap: 10, paddingLeft: 16, paddingRight: 16,
    paddingTop: 14, paddingBottom: 14, fill: T.surface, align: 'CENTER',
  });
  const back = text('‹', { size: TYPE.headingMd, color: T.muted, font: FONT.bold });
  const htitle = frame('t', { gap: 1 });
  htitle.layoutGrow = 1;
  add(htitle, [
    text('결과 리뷰', { size: TYPE.bodySm, font: FONT.bold }),
    text('2학기 중간고사 · 수학', { size: TYPE.micro, color: T.muted }),
  ]);
  add(header, [back, htitle, chip('완료', T.success)]);

  const body = frame('body', { width: W, gap: 16, padding: 16 });

  const score = frame('score summary', {
    gap: 6, padding: 20, radius: RADIUS.lg, fill: T.surface, stroke: T.border, width: W - 32,
  });
  const scoreRow = frame('r', { horizontal: true, gap: 6, align: 'BASELINE' });
  add(scoreRow, [
    text('84', { size: TYPE.metric, font: FONT.bold, color: T.primary }),
    text('/ 100', { size: TYPE.label, color: T.muted, font: FONT.medium }),
  ]);
  add(score, [
    text('내 점수', { size: TYPE.label, color: T.muted, font: FONT.medium }),
    scoreRow,
    row([chip('정답 21', T.success), chip('오답 4', T.gradeRed)], 6),
  ]);

  const dots = frame('answer status list', {
    gap: 10, padding: 16, radius: RADIUS.lg, fill: T.surface, stroke: T.border, width: W - 32,
  });
  add(dots, [text('문항 도트맵', { size: TYPE.bodySm, font: FONT.bold })]);
  const grid = frame('grid', { horizontal: true, gap: 8, wrap: true, width: W - 64 });
  for (let i = 1; i <= 25; i++) {
    const wrong = [3, 9, 14, 22].includes(i);
    const d = frame('q' + i, {
      width: 34, gap: 0, paddingTop: 7, paddingBottom: 7, radius: RADIUS.sm,
      fill: wrong ? 'rgba(192,43,60,0.08)' : 'rgba(16,185,129,0.10)',
      stroke: wrong ? T.gradeRed : T.success, align: 'CENTER',
    });
    d.primaryAxisAlignItems = 'CENTER';
    d.counterAxisAlignItems = 'CENTER';
    add(d, [text(String(i), { size: TYPE.micro, font: FONT.semibold, color: wrong ? T.gradeRed : T.success })]);
    add(grid, [d]);
  }
  add(dots, [grid]);

  const feedback = frame('feedback area', {
    gap: 8, padding: 16, radius: RADIUS.lg, fill: T.surface, stroke: T.border, width: W - 32,
  });
  add(feedback, [
    text('선생님 피드백', { size: TYPE.bodySm, font: FONT.bold }),
    text('3번과 9번은 계산 과정에서 부호를 놓쳤습니다. 재시험에서 같은 유형을 한 번 더 확인해 보세요.', {
      size: TYPE.caption, color: T.muted, width: W - 64,
    }),
  ]);

  const cta = frame('retake action', {
    width: W - 32, paddingTop: 14, paddingBottom: 14, radius: RADIUS.md, fill: T.retake, align: 'CENTER',
  });
  cta.primaryAxisAlignItems = 'CENTER';
  cta.counterAxisAlignItems = 'CENTER';
  add(cta, [text('오답 4문항 재시험 시작', { size: TYPE.bodySm, font: FONT.bold, color: T.surface })]);

  add(body, [score, dots, feedback, cta]);
  add(shell, [header, body]);
  return shell;
}

function buildInventory() {
  const cards = frame('inventory', { horizontal: true, gap: 20, wrap: true, width: 1480 });
  add(cards, ROUTES.map(inventoryCard));

  const desktop = desktopRepresentative();
  const mobile = mobileRepresentative();
  created.nodes.desktop = desktop;
  created.nodes.mobile = mobile;

  const reps = frame('representatives', { horizontal: true, gap: 40, align: 'MIN' });
  const dWrap = frame('desktop', { gap: 12 });
  add(dWrap, [text('Desktop 1440 — 교사 대시보드', { size: TYPE.headingSm, font: FONT.bold }), desktop]);
  const mWrap = frame('mobile', { gap: 12 });
  add(mWrap, [text('Mobile 390 — 학생 결과 리뷰', { size: TYPE.headingSm, font: FONT.bold }), mobile]);
  add(reps, [dWrap, mWrap]);

  const breakpoints = frame('breakpoints', { gap: 12 });
  const bpRow = row([
    card('Desktop 1440', { width: 300, lines: ['헤더 액션이 한 줄에 모두 들어간다.', 'KPI 4열 · 본문 2열'] }),
    card('Tablet 1024', { width: 300, lines: ['교사 헤더 액션이 줄바꿈된다 (헤더 콘텐츠가 아이패드 폭보다 ~190px 넓음).', 'KPI 3열 레일'], source: 'src/app/globals.css @media 5617' }),
    card('Mobile 390', { width: 300, lines: ['단일 열 · 하단 시트 패턴.', '600px+ 태블릿은 전용 플로팅 패널을 유지한다.'], source: 'src/app/globals.css @media 7552' }),
  ], 20, true, 1000);
  add(breakpoints, [bpRow]);

  return pageWrapper('01 Screen Inventory', [
    section('화면 인벤토리 · 16개', '각 카드는 라우트 · 역할 · 목적 · 대표 상태 · 소스 경로를 담는다.', cards),
    section('편집 가능한 대표 화면', 'Auto Layout으로 구성돼 그대로 수정·확장할 수 있다.', reps),
    section('반응형 기준', '실제 globals.css 미디어 쿼리에서 확인한 동작.', breakpoints),
  ]);
}

// ───────────────────────────── 02 User Flows ─────────────────────────────

function flowRow(title, color, steps) {
  const f = frame('flow / ' + title, { gap: 14 });
  add(f, [text(title, { size: TYPE.headingSm, font: FONT.bold, color })]);
  const line = frame('steps', { horizontal: true, gap: 0, align: 'CENTER', wrap: true, width: 1400 });
  steps.forEach((s, i) => {
    const node = frame('step / ' + s, {
      paddingLeft: 18, paddingRight: 18, paddingTop: 14, paddingBottom: 14,
      radius: RADIUS.md, fill: T.surface, stroke: color, align: 'CENTER',
    });
    node.strokes = [paint(color, 0.4)];
    add(node, [text(s, { size: TYPE.bodySm, font: FONT.semibold })]);
    add(line, [node]);
    if (i < steps.length - 1) {
      const arrow = frame('→', { paddingLeft: 10, paddingRight: 10, align: 'CENTER' });
      add(arrow, [text('→', { size: TYPE.headingSm, color, font: FONT.bold })]);
      add(line, [arrow]);
    }
  });
  add(f, [line]);
  return f;
}

function buildFlows() {
  const flows = frame('flows', { gap: 36 });
  add(flows, FLOWS.map(([title, color, steps]) => flowRow(title, color, steps)));

  const decisions = frame('decisions', { horizontal: true, gap: 20, wrap: true, width: 1400 });
  for (const [q, branches, color] of DECISIONS) {
    const d = frame('decision / ' + q, { width: 330, gap: 10, padding: 18, radius: RADIUS.md, fill: T.surface, stroke: T.border });
    const head = frame('h', { horizontal: true, gap: 8, align: 'CENTER', width: 294 });
    const diamond = figma.createPolygon();
    diamond.name = 'branch';
    diamond.pointCount = 4;
    diamond.resize(18, 18);
    diamond.fills = [paint(color, 0.18)];
    diamond.strokes = [paint(color)];
    add(head, [diamond, text(q, { size: TYPE.bodySm, font: FONT.bold })]);
    add(d, [head, text(branches, { size: TYPE.caption, color: T.muted, width: 294 })]);
    add(decisions, [d]);
  }

  return pageWrapper('02 User Flows', [
    section('주요 흐름', '화살표는 사용자 행동, 노드는 도달하는 화면을 의미한다.', flows),
    section('분기 조건', '권한 · PIN · 기간 · 네트워크 · 데이터 유무에서 갈라지는 지점.', decisions),
  ]);
}

// ───────────────────────────── 03 Design System ─────────────────────────────

function swatch(name, hex, token, note) {
  const f = frame('swatch / ' + name, { width: 230, gap: 10, padding: 14, radius: RADIUS.md, fill: T.surface, stroke: T.border });
  const chipBox = figma.createRectangle();
  chipBox.name = 'color';
  chipBox.resize(202, 52);
  chipBox.cornerRadius = RADIUS.sm;
  chipBox.fills = [paint(hex)];
  chipBox.strokes = [paint(T.border)];
  add(f, [
    chipBox,
    text(name, { size: TYPE.bodySm, font: FONT.bold, width: 202 }),
    text(token + '  ' + hex.toUpperCase(), { size: TYPE.micro, color: T.muted, font: FONT.medium, width: 202 }),
    note ? text(note, { size: TYPE.micro, color: T.muted, width: 202 }) : null,
  ]);
  return f;
}

function buildDesignSystem() {
  const colors = frame('colors', { horizontal: true, gap: 16, wrap: true, width: 1220 });
  const NOTES = {
    'Color/Error': '시스템 · 동기화 실패 전용',
    'Color/Grade Red': '채점 오답 전용 — --error와 절대 병합하지 않는다',
    'Color/Retake': '재시험. 5개 파일에 동일하게 손으로 복사돼 있던 값을 토큰화',
  };
  add(colors, SEMANTIC_COLORS.map(([name, hex, token]) =>
    swatch(name.replace('Color/', ''), hex, token, NOTES[name])));

  const redNote = card('--error 와 --grade-red 는 다른 것이다', {
    width: 620,
    lines: [
      '--error (#EF4444): 동기화 실패, 저장 실패 등 "무언가 고장났다".',
      '--grade-red (#C02B3C): 오답 수, 마킹 등 "이 문제를 틀렸다".',
      '사용자에게 다르게 읽히므로 하나로 합치지 않는다.',
    ],
    source: 'CLAUDE.md · src/app/globals.css',
    accent: T.gradeRed,
  });

  // Typography
  const typo = frame('typography', { gap: 20 });
  const korean = card('Pretendard — 한글 본문', {
    width: 620,
    lines: [
      '앱의 거의 모든 노출 문구가 한글이며 body 상속으로 자동 적용된다.',
      '한글 제목에 라틴식 강한 음수 자간을 적용하지 않는다.',
      'unicode-range 동적 서브셋으로 로드된다 (전체 2MB → 페이지당 ~230KB).',
    ],
    source: 'src/app/layout.tsx · globals.css --font-pretendard',
    accent: T.primary,
  });
  const numerals = card('Geist — 숫자 · 통계', {
    width: 620,
    lines: [
      '.numeric-emphasis 클래스가 점수/지표에 적용된다.',
      'font-variant-numeric: tabular-nums lining-nums · weight 950',
    ],
    source: 'globals.css .numeric-emphasis',
    accent: T.accent,
  });
  const sample = frame('sample', { gap: 8, padding: 20, radius: RADIUS.lg, fill: T.surface, stroke: T.border, width: 620 });
  add(sample, [
    text('학생 답안 채점 결과', { size: 28, font: FONT.bold, width: 580 }),
    text('교사와 학생을 위한 스마트 평가 플랫폼', { size: TYPE.bodySm, color: T.muted, width: 580 }),
    row([text('82.4', { size: TYPE.metric, font: FONT.bold, color: T.primary }), text('평균 점수', { size: TYPE.label, color: T.muted })], 10),
  ]);
  add(typo, [row([korean, numerals], 20, true, 1280), sample]);

  const scale = frame('type scale', { gap: 10 });
  for (const [name, px, token, raw] of TYPE_SCALE) {
    const r = frame('step / ' + name, { horizontal: true, gap: 16, align: 'CENTER', width: 1000 });
    const label = frame('l', { width: 150 });
    add(label, [text(name, { size: TYPE.bodySm, font: FONT.bold })]);
    const tok = frame('t', { width: 190 });
    add(tok, [text(token, { size: TYPE.micro, color: T.muted, font: FONT.medium })]);
    const rawBox = frame('raw', { width: 250 });
    add(rawBox, [text(raw, { size: TYPE.micro, color: T.muted })]);
    add(r, [label, tok, rawBox, text('가나다 Abc 123', { size: px })]);
    add(scale, [r]);
  }

  const radii = row(Object.entries(RADIUS).filter(([k]) => k !== 'full').map(([k, v]) => {
    const f = frame('radius / ' + k, { width: 150, gap: 8, padding: 14, radius: RADIUS.md, fill: T.surface, stroke: T.border });
    const box = figma.createRectangle();
    box.name = 'r';
    box.resize(122, 56); box.cornerRadius = v;
    box.fills = [paint(T.primary, 0.12)]; box.strokes = [paint(T.primary, 0.3)];
    add(f, [box, text('--radius-' + k, { size: TYPE.micro, color: T.muted, font: FONT.medium }), text(v + 'px', { size: TYPE.caption, font: FONT.bold })]);
    return f;
  }).concat([(() => {
    const f = frame('radius / full', { width: 150, gap: 8, padding: 14, radius: RADIUS.md, fill: T.surface, stroke: T.border });
    const box = figma.createRectangle();
    box.name = 'r'; box.resize(122, 56); box.cornerRadius = 9999;
    box.fills = [paint(T.primary, 0.12)]; box.strokes = [paint(T.primary, 0.3)];
    add(f, [box, text('--radius-full', { size: TYPE.micro, color: T.muted, font: FONT.medium }), text('9999px', { size: TYPE.caption, font: FONT.bold })]);
    return f;
  })()]), 16, true, 1000);

  const elevation = row(ELEVATION.map(([name, token, y, blur, alpha]) => {
    const f = frame('elevation / ' + name, { width: 220, gap: 10, padding: 18, radius: RADIUS.md, fill: T.background });
    const box = frame('box', { width: 184, paddingTop: 26, paddingBottom: 26, radius: RADIUS.md, fill: T.surface, stroke: T.border, shadow: shadow(y, blur, alpha) });
    box.primaryAxisAlignItems = 'CENTER'; box.counterAxisAlignItems = 'CENTER';
    add(box, [text(name, { size: TYPE.bodySm, font: FONT.bold })]);
    add(f, [box, text(token, { size: TYPE.micro, color: T.muted, font: FONT.medium })]);
    return f;
  }), 16, true, 1000);

  const motion = row(MOTION.map(([name, token, value]) =>
    card(name, { width: 230, lines: [value], source: token, accent: T.accent })), 16, true, 1000);

  // Reusable UI examples
  const buttons = frame('buttons', { horizontal: true, gap: 12, wrap: true, width: 700, align: 'CENTER' });
  const mkBtn = (label, fill, color, stroke) => {
    const b = frame('button / ' + label, {
      paddingLeft: 20, paddingRight: 20, paddingTop: 12, paddingBottom: 12,
      radius: RADIUS.md, fill, stroke, align: 'CENTER',
    });
    b.primaryAxisAlignItems = 'CENTER'; b.counterAxisAlignItems = 'CENTER';
    add(b, [text(label, { size: TYPE.bodySm, font: FONT.semibold, color })]);
    return b;
  };
  add(buttons, [
    mkBtn('시험 만들기', T.primary, T.surface, null),
    mkBtn('보조 액션', T.surface, T.foreground, T.border),
    mkBtn('재시험 시작', T.retake, T.surface, null),
    mkBtn('삭제', T.surface, T.error, T.error),
  ]);

  const input = frame('input', { width: 420, gap: 6 });
  const field = frame('field', {
    width: 420, paddingLeft: 14, paddingRight: 14, paddingTop: 12, paddingBottom: 12,
    radius: RADIUS.md, fill: T.surface, stroke: T.border,
  });
  add(field, [text('시험 제목을 입력하세요', { size: TYPE.bodySm, color: T.muted })]);
  add(input, [text('입력', { size: TYPE.label, font: FONT.bold }), field, text('도움말 · 오류 메시지 자리', { size: TYPE.micro, color: T.muted })]);

  const pills = frame('StatusPill tones', { gap: 10 });
  for (const [name, color, bg, use] of PILL_TONES) {
    const r = frame('tone / ' + name, { horizontal: true, gap: 14, align: 'CENTER', width: 620 });
    const nameBox = frame('n', { width: 100 });
    add(nameBox, [text(name, { size: TYPE.caption, font: FONT.medium, color: T.muted })]);
    add(r, [nameBox, chip(name, color, bg), text(use, { size: TYPE.caption, color: T.muted })]);
    add(pills, [r]);
  }

  const modal = frame('modal shell', { width: 460, gap: 14, padding: 24, radius: RADIUS.xl, fill: T.surface, stroke: T.border, shadow: shadow(24, 48, 0.16) });
  add(modal, [
    text('시험 배포', { size: TYPE.headingMd, font: FONT.bold }),
    text('반과 접근 방식(PIN/링크)을 선택하면 학생 대시보드에 즉시 표시됩니다.', { size: TYPE.bodySm, color: T.muted, width: 412 }),
    row([mkBtn('배포', T.primary, T.surface, null), mkBtn('취소', T.surface, T.muted, T.border)], 10),
  ]);

  const group = (label, body) => {
    const g = frame('group / ' + label, { gap: 10 });
    add(g, [text(label, { size: TYPE.label, font: FONT.bold, color: T.primary, letterSpacing: 4 }), body]);
    return g;
  };

  const examples = frame('examples', { gap: 28 });
  add(examples, [
    group('버튼 · 입력', row([buttons, input], 32, true, 1240)),
    group('StatusPill — src/components/dashboard/StatusPill.tsx', pills),
    group('모달 셸 (탭 · 헤더는 Screen Inventory 대표 화면에서 편집 가능)', modal),
  ]);

  const colorBlock = frame('color block', { gap: 20 });
  add(colorBlock, [colors, redNote]);

  return pageWrapper('03 Design System', [
    section('색상', 'globals.css :root 라이트 모드 값. 새 값을 임의로 추가하지 않는다.', colorBlock),
    section('타이포그래피', 'Pretendard(한글 본문) + Geist(숫자 · 통계).', typo),
    section('타입 스케일', '--type-* 토큰과 실제 렌더 크기.', scale),
    section('라운드', '--radius-* 토큰.', radii),
    section('엘리베이션', '--shadow-* — 접촉 그림자 + 슬레이트 앰비언트 2겹 구조.', elevation),
    section('모션', '--transition-* 토큰.', motion),
    section('공통 패턴', '실제 컴포넌트를 기준으로 한 편집 가능한 예시.', examples),
  ]);
}

// ───────────────────────────── variables ─────────────────────────────

async function buildVariables() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const c of collections) if (c.name === 'OMR Maker / Product Map') c.remove();

  const collection = figma.variables.createVariableCollection('OMR Maker / Product Map');
  collection.renameMode(collection.modes[0].modeId, 'Light');
  const modeId = collection.modes[0].modeId;

  const made = [];
  for (const [name, hex, , scopes] of SEMANTIC_COLORS) {
    const v = figma.variables.createVariable(name, collection, 'COLOR');
    v.setValueForMode(modeId, rgb(hex));
    v.scopes = scopes.split(',');
    made.push(name);
  }
  return { collectionId: collection.id, variables: made };
}

// ───────────────────────────── validation ─────────────────────────────

function collectText(node, out) {
  if (node.type === 'TEXT') out.push(node.characters);
  if ('children' in node) for (const c of node.children) collectText(c, out);
  return out;
}

function overlaps(a, b) {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

/** Auto Layout guarantees no sibling overlap; this verifies it held (Task 7 Step 3). */
function checkNoOverlap(frameNode) {
  const kids = (frameNode.children || []).filter(c => 'width' in c);
  for (let i = 0; i < kids.length; i++) {
    for (let j = i + 1; j < kids.length; j++) {
      if (overlaps(kids[i], kids[j])) return kids[i].name + ' ↔ ' + kids[j].name;
    }
  }
  return null;
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  await figma.loadAllPagesAsync();
  await resolveFonts();

  const variables = await buildVariables();

  // Rebuild cleanly: drop any pages this builder previously owned.
  const existing = figma.root.children;
  const keep = existing.filter(p => PAGE_NAMES.indexOf(p.name) === -1);
  if (keep.length === 0) {
    // Figma requires at least one page; park on a scratch page while we rebuild.
    const scratch = figma.createPage();
    scratch.name = 'scratch';
    await figma.setCurrentPageAsync(scratch);
    for (const p of existing) p.remove();
    keep.push(scratch);
  } else {
    await figma.setCurrentPageAsync(keep[0]);
    for (const p of existing) if (PAGE_NAMES.indexOf(p.name) !== -1) p.remove();
  }

  const builders = [buildOverview, buildInventory, buildFlows, buildDesignSystem];
  const report = [];

  for (let i = 0; i < PAGE_NAMES.length; i++) {
    const page = figma.createPage();
    page.name = PAGE_NAMES[i];
    page.backgrounds = [paint(T.background)];
    await figma.setCurrentPageAsync(page);
    const wrapper = builders[i]();
    page.appendChild(wrapper);
    wrapper.x = 0;
    wrapper.y = 0;
    created.pages.push(page);
    report.push({ page: page.name, pageId: page.id, wrapper: wrapper.name, wrapperId: wrapper.id });
  }

  // Order the four pages first, in sequence.
  for (let i = 0; i < created.pages.length; i++) {
    figma.root.insertChild(i, created.pages[i]);
  }

  // Task 7 Step 2 — route coverage.
  const inventoryPage = created.pages[1];
  const seen = collectText(inventoryPage, []);
  const missing = ROUTES.map(r => r[0]).filter(r => !seen.includes(r));

  // Task 7 Step 3 — representative frames.
  const repChecks = {
    desktopAutoLayout: created.nodes.desktop.layoutMode !== 'NONE',
    mobileAutoLayout: created.nodes.mobile.layoutMode !== 'NONE',
    desktopOverlap: checkNoOverlap(created.nodes.desktop),
    mobileOverlap: checkNoOverlap(created.nodes.mobile),
  };

  await figma.setCurrentPageAsync(created.pages[0]);
  figma.viewport.scrollAndZoomIntoView([created.pages[0].children[0]]);

  const summary = [
    'OMR Maker Product Map — 생성 완료',
    '',
    'Font: ' + FONT.family + (FONT.fallback ? '  (Pretendard 미설치 → 한글 지원 대체 폰트)' : '  (Pretendard)'),
    'Variables: ' + variables.variables.length + ' colors in "OMR Maker / Product Map"',
    '',
    'Pages:',
    ...report.map(r => '  ' + r.page + '  ' + r.pageId + '  wrapper=' + r.wrapperId),
    '',
    'Route coverage: ' + (ROUTES.length - missing.length) + '/' + ROUTES.length +
      (missing.length ? '  MISSING: ' + missing.join(', ') : '  ✓'),
    'Desktop representative: autoLayout=' + repChecks.desktopAutoLayout + ' overlap=' + (repChecks.desktopOverlap || 'none'),
    'Mobile representative:  autoLayout=' + repChecks.mobileAutoLayout + ' overlap=' + (repChecks.mobileOverlap || 'none'),
  ].join('\n');

  console.log(summary);
  figma.notify(
    'Product Map 생성 완료 · 4 pages · routes ' + (ROUTES.length - missing.length) + '/' + ROUTES.length,
    { timeout: 6000 }
  );
  figma.closePlugin(summary);
}

main().catch(err => {
  console.error(err);
  figma.closePlugin('실패: ' + (err && err.message ? err.message : String(err)));
});
