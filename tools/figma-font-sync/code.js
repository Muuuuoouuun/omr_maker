const OWNED_PAGES = new Set([
  '00 Overview',
  '01 Screen Inventory',
  '02 User Flows',
  '03 Design System',
]);

const FALLBACK_FAMILIES = new Set([
  'Noto Sans KR',
  'Apple SD Gothic Neo',
  'Spoqa Han Sans Neo',
  'Inter',
]);

const STYLE_FALLBACKS = {
  Thin: ['Thin', 'ExtraLight', 'Light', 'Regular'],
  ExtraLight: ['ExtraLight', 'Light', 'Regular'],
  Light: ['Light', 'Regular'],
  DemiLight: ['Light', 'Regular'],
  Regular: ['Regular'],
  Medium: ['Medium', 'Regular'],
  SemiBold: ['SemiBold', 'Bold', 'Medium'],
  Bold: ['Bold', 'SemiBold', 'Medium'],
  ExtraBold: ['ExtraBold', 'Bold'],
  Black: ['Black', 'ExtraBold', 'Bold'],
};

function key(fontName) {
  return `${fontName.family}\u0000${fontName.style}`;
}

async function main() {
  await figma.loadAllPagesAsync();

  const availableFonts = await figma.listAvailableFontsAsync();
  const available = new Map(
    availableFonts.map(({ fontName }) => [key(fontName), fontName]),
  );
  const pretendard = availableFonts
    .map(({ fontName }) => fontName)
    .filter(({ family }) => family === 'Pretendard');

  if (pretendard.length === 0) {
    throw new Error(
      'Pretendard is not visible to Figma Desktop. Restart Figma after installing the font.',
    );
  }

  const loaded = new Set();
  const resolveTarget = (source) => {
    const candidates = STYLE_FALLBACKS[source.style] || [
      source.style,
      'Regular',
    ];

    for (const style of candidates) {
      const candidate = available.get(key({ family: 'Pretendard', style }));
      if (candidate) return candidate;
    }

    return pretendard[0];
  };

  const loadTarget = async (fontName) => {
    const fontKey = key(fontName);
    if (loaded.has(fontKey)) return;
    await figma.loadFontAsync(fontName);
    loaded.add(fontKey);
  };

  let changedLayers = 0;
  let changedRanges = 0;
  const pages = figma.root.children.filter((page) =>
    OWNED_PAGES.has(page.name),
  );

  for (const page of pages) {
    const textNodes = page.findAllWithCriteria({ types: ['TEXT'] });

    for (const node of textNodes) {
      if (node.fontName !== figma.mixed) {
        if (!FALLBACK_FAMILIES.has(node.fontName.family)) continue;
        const target = resolveTarget(node.fontName);
        await loadTarget(target);
        node.fontName = target;
        changedLayers += 1;
        changedRanges += 1;
        continue;
      }

      const segments = node.getStyledTextSegments(['fontName']);
      let changed = false;

      for (const segment of segments) {
        const source = segment.fontName;
        if (!source || !FALLBACK_FAMILIES.has(source.family)) continue;
        const target = resolveTarget(source);
        await loadTarget(target);
        node.setRangeFontName(segment.start, segment.end, target);
        changed = true;
        changedRanges += 1;
      }

      if (changed) changedLayers += 1;
    }
  }

  figma.closePlugin(
    `Pretendard 적용 완료 · ${pages.length}개 페이지 · ${changedLayers}개 텍스트 레이어 · ${changedRanges}개 범위`,
  );
}

main().catch((error) => {
  figma.closePlugin(
    `Pretendard 적용 실패: ${error instanceof Error ? error.message : String(error)}`,
  );
});
