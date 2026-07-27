/**
 * Headless verification for the Product Map builder.
 *
 * Runs code.js against a mock of the Figma Plugin API so the whole build can be
 * exercised — and broken — without opening Figma. It catches the failure modes
 * that actually bite when authoring a plugin blind: undefined helpers, nodes
 * appended before they exist, Auto Layout properties set in an order Figma
 * rejects, and route/content drift away from the App Router tree.
 *
 * It is a mock, not an emulator: it approximates Auto Layout well enough to
 * check that sibling frames tile without overlapping, and it enforces the
 * Plugin API's real ordering constraints (layoutWrap needs HORIZONTAL + a fixed
 * primary axis; text needs its font loaded before characters are set). A green
 * run means the builder is sound, not that the visual result is final — that
 * still needs one look in Figma.
 *
 *   node tools/figma-product-map/verify.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const problems = [];
const loadedFonts = new Set();

function fail(msg) { problems.push(msg); }
const key = f => `${f.family}|${f.style}`;

// ───────────────────────────── node model ─────────────────────────────

let idSeq = 0;

class Node {
  constructor(type) {
    this.type = type;
    this.id = `${type}:${++idSeq}`;
    this.name = type;
    this.children = [];
    this.parent = null;
    this.x = 0; this.y = 0;
    this.width = 0; this.height = 0;
    this.fills = []; this.strokes = []; this.effects = [];
  }
  appendChild(child) {
    if (!child) fail(`${this.name}: appendChild(undefined)`);
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
  }
  insertChild(i, child) {
    if (!child) fail(`${this.name}: insertChild(undefined)`);
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.splice(i, 0, child);
  }
  resize(w, h) {
    if (!(w >= 0) || !(h >= 0)) fail(`${this.name}: resize(${w}, ${h}) — non-numeric`);
    this.width = w; this.height = h;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.removed = true;
  }
}

class FrameNode extends Node {
  constructor() {
    super('FRAME');
    this.layoutMode = 'NONE';
    this.itemSpacing = 0;
    this.paddingTop = this.paddingBottom = this.paddingLeft = this.paddingRight = 0;
    this.primaryAxisSizingMode = 'AUTO';
    this.counterAxisSizingMode = 'AUTO';
    this.primaryAxisAlignItems = 'MIN';
    this.counterAxisAlignItems = 'MIN';
    this._layoutWrap = 'NO_WRAP';
    this.layoutGrow = 0;
    this.cornerRadius = 0;
    this.clipsContent = true;
    this.fixedWidth = false;
  }
  set layoutWrap(v) {
    // Figma rejects WRAP unless the frame is horizontal with a fixed primary axis.
    if (v === 'WRAP') {
      if (this.layoutMode !== 'HORIZONTAL') fail(`${this.name}: layoutWrap=WRAP on layoutMode=${this.layoutMode}`);
      else if (!this.fixedWidth) fail(`${this.name}: layoutWrap=WRAP without a fixed width`);
    }
    this._layoutWrap = v;
  }
  get layoutWrap() { return this._layoutWrap; }

  set layoutSizingHorizontal(v) {
    if (this.layoutMode === 'NONE') fail(`${this.name}: layoutSizingHorizontal on a non-auto-layout frame`);
    if (v === 'FIXED') this.fixedWidth = true;
  }
  get layoutSizingHorizontal() { return this.fixedWidth ? 'FIXED' : 'HUG'; }
}

class TextNode extends Node {
  constructor() {
    super('TEXT');
    this._fontName = { family: 'Inter', style: 'Regular' };
    this._characters = '';
    this.fontSize = 12;
    this.textAutoResize = 'WIDTH_AND_HEIGHT';
    this.lineHeight = { unit: 'PERCENT', value: 100 };
  }
  set fontName(f) {
    if (!f || !f.family) fail(`${this.name}: fontName set to ${JSON.stringify(f)}`);
    this._fontName = f;
  }
  get fontName() { return this._fontName; }
  set characters(v) {
    // The real API throws if the font was never loaded.
    if (!loadedFonts.has(key(this._fontName))) {
      fail(`text "${String(v).slice(0, 24)}": font ${key(this._fontName)} used before loadFontAsync`);
    }
    if (v === undefined || v === null) fail('text: characters set to null/undefined');
    this._characters = String(v);
    this.width = Math.max(...this._characters.split('\n').map(l => l.length)) * this.fontSize * 0.62;
    this.height = this._characters.split('\n').length * this.fontSize * (this.lineHeight.value / 100);
  }
  get characters() { return this._characters; }
  resize(w, h) {
    super.resize(w, h);
    if (this.textAutoResize === 'HEIGHT') {
      const perLine = Math.max(1, Math.floor(w / (this.fontSize * 0.62)));
      const lines = Math.max(1, Math.ceil(this._characters.length / perLine));
      this.height = lines * this.fontSize * (this.lineHeight.value / 100);
    }
  }
}

class PageNode extends Node {
  constructor() { super('PAGE'); this.backgrounds = []; }
}

// ───────────────────────── approximate auto layout ─────────────────────────

function layout(node) {
  for (const c of node.children) layout(c);

  if (node.type !== 'FRAME' || node.layoutMode === 'NONE') return;

  const horizontal = node.layoutMode === 'HORIZONTAL';
  const padL = node.paddingLeft, padT = node.paddingTop;
  const gap = node.itemSpacing;
  const kids = node.children;

  const innerWidth = node.fixedWidth ? node.width - padL - node.paddingRight : Infinity;

  let cursorMain = 0, cursorCross = 0, lineExtent = 0, maxMain = 0;
  for (const c of kids) {
    const mainSize = horizontal ? c.width : c.height;
    const crossSize = horizontal ? c.height : c.width;

    if (horizontal && node.layoutWrap === 'WRAP' && cursorMain > 0 && cursorMain + mainSize > innerWidth) {
      cursorCross += lineExtent + gap;
      cursorMain = 0;
      lineExtent = 0;
    }
    if (horizontal) { c.x = padL + cursorMain; c.y = padT + cursorCross; }
    else { c.x = padL + cursorCross; c.y = padT + cursorMain; }

    cursorMain += mainSize + gap;
    maxMain = Math.max(maxMain, cursorMain - gap);
    lineExtent = Math.max(lineExtent, crossSize);
  }

  const contentMain = Math.max(0, maxMain);
  const contentCross = cursorCross + lineExtent;

  if (horizontal) {
    if (!node.fixedWidth) node.width = contentMain + padL + node.paddingRight;
    node.height = contentCross + padT + node.paddingBottom;
  } else {
    if (!node.fixedWidth) node.width = contentCross + padL + node.paddingRight;
    node.height = contentMain + padT + node.paddingBottom;
  }
}

// ───────────────────────────── figma mock ─────────────────────────────

const AVAILABLE_FONTS = [
  // Deliberately no Pretendard: exercises the Korean-capable fallback path
  // the plan calls for in Task 2 Step 3.
  { fontName: { family: 'Noto Sans KR', style: 'Regular' } },
  { fontName: { family: 'Noto Sans KR', style: 'Medium' } },
  { fontName: { family: 'Noto Sans KR', style: 'Bold' } },
  { fontName: { family: 'Inter', style: 'Regular' } },
];

const root = new Node('DOCUMENT');
let currentPage = null;
let closedWith = null;
const variableCollections = [];

const figma = {
  root,
  get currentPage() { return currentPage; },
  createFrame: () => new FrameNode(),
  createText: () => new TextNode(),
  createRectangle: () => { const n = new Node('RECTANGLE'); n.cornerRadius = 0; return n; },
  createPolygon: () => { const n = new Node('POLYGON'); n.pointCount = 3; return n; },
  createPage: () => { const p = new PageNode(); root.appendChild(p); return p; },
  loadAllPagesAsync: async () => {},
  listAvailableFontsAsync: async () => AVAILABLE_FONTS,
  loadFontAsync: async f => {
    if (!AVAILABLE_FONTS.some(a => key(a.fontName) === key(f))) {
      fail(`loadFontAsync(${key(f)}) — font not available`);
    }
    loadedFonts.add(key(f));
  },
  setCurrentPageAsync: async p => {
    if (!p || p.removed) fail('setCurrentPageAsync on a removed/missing page');
    currentPage = p;
  },
  viewport: { scrollAndZoomIntoView: nodes => { if (!nodes || !nodes.length || !nodes[0]) fail('scrollAndZoomIntoView([]) — nothing to focus'); } },
  notify: () => {},
  closePlugin: msg => { closedWith = msg; },
  variables: {
    getLocalVariableCollectionsAsync: async () => variableCollections.slice(),
    createVariableCollection: name => {
      const c = {
        id: 'coll:' + name, name, modes: [{ modeId: 'm1', name: 'Mode 1' }], variables: [],
        renameMode: (id, n) => { c.modes.find(m => m.modeId === id).name = n; },
        remove: () => variableCollections.splice(variableCollections.indexOf(c), 1),
      };
      variableCollections.push(c);
      return c;
    },
    createVariable: (name, collection, type) => {
      if (type !== 'COLOR') fail(`createVariable(${name}) unexpected type ${type}`);
      const v = {
        id: 'var:' + name, name, _values: {}, _scopes: [],
        setValueForMode: (modeId, value) => {
          if (!collection.modes.some(m => m.modeId === modeId)) fail(`${name}: unknown modeId`);
          if (!value || typeof value.r !== 'number') fail(`${name}: bad colour value`);
          v._values[modeId] = value;
        },
        set scopes(s) { v._scopes = s; },
        get scopes() { return v._scopes; },
      };
      collection.variables.push(v);
      return v;
    },
  },
};

// ───────────────────────────── run the builder ─────────────────────────────

const source = readFileSync(join(here, 'code.js'), 'utf8');
const sandbox = { figma, console: { log: () => {}, error: (...a) => fail('console.error: ' + a.join(' ')) } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  new vm.Script(source, { filename: 'code.js' }).runInContext(sandbox);
} catch (err) {
  fail('threw while loading: ' + err.stack);
}

await new Promise(r => setTimeout(r, 50));

// ───────────────────────────── assertions ─────────────────────────────

const pages = root.children.filter(n => n.type === 'PAGE' && !n.removed);
const EXPECTED = ['00 Overview', '01 Screen Inventory', '02 User Flows', '03 Design System'];

const named = pages.filter(p => EXPECTED.includes(p.name));
if (named.length !== 4) fail(`expected 4 named pages, got ${named.length}: ${pages.map(p => p.name).join(', ')}`);

const order = pages.slice(0, 4).map(p => p.name);
if (order.join('|') !== EXPECTED.join('|')) fail(`page order is ${order.join(' → ')}`);

for (const p of named) {
  const wrappers = p.children.filter(c => c.type === 'FRAME');
  if (wrappers.length !== 1) fail(`${p.name}: expected exactly 1 top-level wrapper frame, got ${wrappers.length}`);
  else if (wrappers[0].name !== p.name) fail(`${p.name}: wrapper is named "${wrappers[0].name}"`);
}

for (const p of named) layout(p);

function walk(n, visit) { visit(n); for (const c of n.children) walk(c, visit); }

// Route coverage against the App Router tree.
const ROUTES_ON_DISK = [
  '/', '/create', '/groups', '/pwa-check', '/solve/[id]',
  '/student/dashboard', '/student/history', '/student/review/[attemptId]',
  '/teacher/attempt/[attemptId]', '/teacher/billing', '/teacher/dashboard',
  '/teacher/exam/[id]', '/teacher/live', '/teacher/settings', '/teacher/users',
  '/_not-found',
];
const inventory = named.find(p => p.name === '01 Screen Inventory');
const inventoryText = [];
walk(inventory, n => { if (n.type === 'TEXT') inventoryText.push(n.characters); });
const missing = ROUTES_ON_DISK.filter(r => !inventoryText.includes(r));
if (missing.length) fail(`Screen Inventory is missing routes: ${missing.join(', ')}`);

// Representative frames: Auto Layout + no overlapping siblings.
function findByPrefix(prefix) {
  let hit = null;
  for (const p of named) walk(p, n => { if (!hit && n.name && n.name.startsWith(prefix)) hit = n; });
  return hit;
}
function overlapIn(node) {
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i], b = kids[j];
      if (a.width === 0 || b.width === 0 || a.height === 0 || b.height === 0) continue;
      const hit = !(a.x + a.width <= b.x + 0.01 || b.x + b.width <= a.x + 0.01 ||
                    a.y + a.height <= b.y + 0.01 || b.y + b.height <= a.y + 0.01);
      if (hit) return `${a.name} ↔ ${b.name}`;
    }
  }
  return null;
}
for (const prefix of ['Desktop 1440', 'Mobile 390']) {
  const rep = findByPrefix(prefix);
  if (!rep) { fail(`${prefix} representative frame not found`); continue; }
  if (rep.layoutMode === 'NONE') fail(`${prefix}: not Auto Layout`);
  const clash = overlapIn(rep);
  if (clash) fail(`${prefix}: overlapping children — ${clash}`);
}

// Variables.
const coll = variableCollections.find(c => c.name === 'OMR Maker / Product Map');
if (!coll) fail('variable collection "OMR Maker / Product Map" was not created');
else {
  if (coll.variables.length !== 11) fail(`expected 11 colour variables, got ${coll.variables.length}`);
  const unscoped = coll.variables.filter(v => !v.scopes.length).map(v => v.name);
  if (unscoped.length) fail(`variables without explicit scopes: ${unscoped.join(', ')}`);
  if (coll.modes[0].name !== 'Light') fail(`mode is named "${coll.modes[0].name}", expected "Light"`);
}

// Every page carries the shared header stamp.
for (const p of named) {
  const texts = [];
  walk(p, n => { if (n.type === 'TEXT') texts.push(n.characters); });
  if (!texts.includes('OMR Maker')) fail(`${p.name}: header brand line missing`);
  if (!texts.some(t => t.startsWith('Current implementation map'))) fail(`${p.name}: header stamp missing`);
}

// Empty text nodes are almost always a data hole rather than an intent.
let empties = 0;
for (const p of named) walk(p, n => { if (n.type === 'TEXT' && n.characters.trim() === '') empties++; });
if (empties) fail(`${empties} empty text node(s)`);

if (!closedWith) fail('plugin never called figma.closePlugin');
else if (/^실패/.test(closedWith)) fail('builder reported failure: ' + closedWith);

// ───────────────────────────── report ─────────────────────────────

const counts = { FRAME: 0, TEXT: 0, RECTANGLE: 0, POLYGON: 0 };
for (const p of named) walk(p, n => { if (counts[n.type] !== undefined) counts[n.type]++; });

if (problems.length) {
  console.error('✗ product map verification FAILED\n');
  for (const p of problems) console.error('  • ' + p);
  process.exit(1);
}

console.log('✓ product map verification passed');
console.log(`  pages     ${named.map(p => p.name).join(' · ')}`);
console.log(`  routes    ${ROUTES_ON_DISK.length}/${ROUTES_ON_DISK.length} present in Screen Inventory`);
console.log(`  variables ${coll.variables.length} colours, mode "${coll.modes[0].name}"`);
console.log(`  nodes     ${counts.FRAME} frames · ${counts.TEXT} text · ${counts.RECTANGLE} rect · ${counts.POLYGON} polygon`);
console.log(`  font      resolved via fallback path (no Pretendard in the mock font list)`);
