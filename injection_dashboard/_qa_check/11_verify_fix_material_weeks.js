'use strict';
/* =========================================================================
 * QA 校验脚本 11：回归确认《原料需求表周轴错位》P1 修复 + 关键回归（真实执行）
 *  1. renderMaterialA 表头 = material.weeks 38 列（2026WK34~2027WK18），不含 WK32/WK31
 *     首行首数据格 5502.37 对齐到 2026WK34 列（不再左移）
 *  2. computeMaterialDemand 周轴以 material.weeks 为基准；额外周追加排序；未排期忽略
 *  3. 回归：computeDetailRows 300、parseBudget6、computeGapReal、renderGap 产能公式、
 *            renderVarietyOptions、renderPreview
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'D:/WorkBuddy工作资料/injection_dashboard';
const HTML = path.join(ROOT, 'index.html');
const TESTDATA = path.join(ROOT, '_qa_check/testdata.json');

const html = fs.readFileSync(HTML, 'utf8');
const testdata = JSON.parse(fs.readFileSync(TESTDATA, 'utf8')).rows;

let total = 0, passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? '  — ' + detail : '')); }
  else { failed++; failures.push(name); console.log('[FAIL] ' + name + (detail ? '  — ' + detail : '')); }
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

function extractInlineScripts(src) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = []; let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}
const scripts = extractInlineScripts(html);
const dataScript = scripts.find(s => /EMBEDDED_DATA/.test(s)) || '';
const logicScript = scripts.find(s => /__injectionDebug/.test(s)) || '';

function extractConst(code, name) {
  const key = 'const ' + name + ' = ';
  const i = code.indexOf(key);
  if (i < 0) return null;
  const tail = code.slice(i + key.length);
  let depth = 0, inStr = false, esc = false;
  for (let j = 0; j < tail.length; j++) {
    const ch = tail[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ';' && depth === 0) return JSON.parse(tail.slice(0, j).trim());
  }
  return null;
}
let EMB_GAP = null;
try { EMB_GAP = extractConst(dataScript, 'EMBEDDED_GAP'); } catch (e) { check('抽取 EMBEDDED_GAP', false, e.message); }

function colIdxToLetter(c) { let s = ''; c = c + 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
function letterToColIdx(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function aoaToWs(aoa) {
  const nrows = aoa.length; let ncols = 0;
  for (const r of aoa) ncols = Math.max(ncols, r.length);
  const ws = { '!ref': 'A1:' + colIdxToLetter(ncols - 1) + nrows };
  for (let r = 0; r < nrows; r++) { const row = aoa[r]; for (let c = 0; c < row.length; c++) { const v = row[c]; if (v === null || v === undefined) continue; ws[colIdxToLetter(c) + (r + 1)] = { v: v }; } }
  return ws;
}
const xlsxUtils = {
  decode_range(ref) {
    const m = String(ref).match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
    if (!m) return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const c1 = letterToColIdx(m[1]), r1 = Number(m[2]) - 1;
    const c2 = m[3] ? letterToColIdx(m[3]) : c1, r2 = m[4] ? Number(m[4]) - 1 : r1;
    return { s: { r: r1, c: c1 }, e: { r: r2, c: c2 } };
  },
  encode_cell(cell) { return colIdxToLetter(cell.c) + (cell.r + 1); },
  sheet_to_json(ws) { return ws; }
};
const xlsxStub = { utils: xlsxUtils };

function makeClassList() {
  const set = new Set();
  return {
    add: function () { for (const a of arguments) set.add(a); },
    remove: function () { for (const a of arguments) set.delete(a); },
    toggle: function (name, force) { const on = (force === undefined) ? !set.has(name) : !!force; if (on) set.add(name); else set.delete(name); return on; },
    contains: function (name) { return set.has(name); }
  };
}
function makeEl(id) {
  const el = {
    id: id, innerHTML: '', style: {}, className: '', textContent: '', value: '',
    classList: makeClassList(), __handlers: {}, addEventListener: function (type, fn) { el.__handlers[type] = fn; },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }, disabled: false,
    __echart: null, __echartOption: null
  };
  return el;
}
const echartsStub = {
  getInstanceByDom: function (el) { return el.__echart || null; },
  init: function (el) { const c = { setOption: function (opt) { el.__echartOption = opt; }, clear: function () {}, resize: function () {} }; el.__echart = c; return c; }
};
const els = {};
function getEl(id) { if (els[id] === undefined) els[id] = makeEl(id); return els[id]; }
const kpiStore = { month: '', days: '', shell: '', value: '' };
function kpiInputEl(key) {
  const el = makeEl('kpiinput-' + key);
  Object.defineProperty(el, 'value', {
    get: function () { return (kpiStore[key] == null) ? '' : String(kpiStore[key]); },
    set: function (v) { kpiStore[key] = v; }, enumerable: true, configurable: true
  });
  return el;
}
const localStorageStore = {};
const sandbox = {
  window: { echarts: echartsStub, XLSX: xlsxStub, addEventListener: function () {} },
  document: {
    readyState: 'complete', addEventListener: function (type, fn) { if (type === 'DOMContentLoaded') fn(); },
    getElementById: function (id) { return getEl(id); },
    querySelector: function (sel) { const m = String(sel).match(/^#kpiGrid\s+input\[data-key="([^"]+)"\]$/); if (m) return kpiInputEl(m[1]); return null; },
    querySelectorAll: function () { return []; }, body: getEl('body')
  },
  FileReader: function () {},
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null; },
    setItem: function (k, v) { localStorageStore[k] = String(v); }, removeItem: function (k) { delete localStorageStore[k]; }
  },
  setTimeout: setTimeout, clearTimeout: clearTimeout, console: console
};
vm.createContext(sandbox);
try { vm.runInContext(dataScript + '\n;\n' + logicScript, sandbox, { filename: 'logic.js' }); }
catch (e) { console.error('[FATAL] 逻辑脚本执行失败：', e.message); process.exit(2); }
const D = sandbox.window && sandbox.window.__injectionDebug;
if (!D) { console.error('[FATAL] 未捕获 __injectionDebug'); process.exit(2); }

// ---------- 工具：从 innerHTML 提取 thead 周列标签 + 首行数据格 ----------
function extractMaterialHeaderAndFirstRow(htmlStr) {
  // 表头：取 thead 内所有 <th>（含 class 的 3 个标签 + 无 class 的周列）
  const thead = (htmlStr.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
  const ths = thead.match(/<th[^>]*>([^<]*)<\/th>/g) || [];
  const weekCols = [];
  for (const th of ths) {
    if (/<th>/.test(th)) { // 无 class 的周列 <th>xxx</th>
      weekCols.push(th.replace(/<\/?th>/g, ''));
    }
  }
  // 首数据行：tbody 第一个 <tr>
  const tbody = (htmlStr.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0];
  const firstTr = (tbody.match(/<tr>[\s\S]*?<\/tr>/) || [''])[0];
  const tds = firstTr.match(/<td[^>]*>([^<]*)<\/td>/g) || [];
  const dataCols = [];
  for (const td of tds) {
    if (/<td>/.test(td)) dataCols.push(td.replace(/<\/?td>/g, ''));
  }
  return { weekCols: weekCols, dataCols: dataCols };
}

// =========================================================================
console.log('\n========== 修复确认 1：renderMaterialA 表头 38 列 + 首格对齐 ==========');
(function testRenderMaterialA() {
  const mat = EMB_GAP.material;
  const st = D.getState();
  st.materialDemand = null; // 内置模式
  D.renderMaterialA();
  const mHtml = getEl('materialAContainer').innerHTML;
  const { weekCols, dataCols } = extractMaterialHeaderAndFirstRow(mHtml);

  check('1. 表头周列 = 38', weekCols.length === 38, '实际 ' + weekCols.length);
  check('1. 表头首周 = 2026WK34', weekCols[0] === '2026WK34', weekCols[0]);
  check('1. 表头末周 = 2027WK18', weekCols[37] === '2027WK18', weekCols[37]);
  check('1. 表头不含 2026WK32', weekCols.indexOf('2026WK32') < 0);
  check('1. 表头不含 2026WK33', weekCols.indexOf('2026WK33') < 0);
  check('1. 表头不含 2027WK31', weekCols.indexOf('2027WK31') < 0);
  check('1. 表头与 material.weeks 完全一致', JSON.stringify(weekCols) === JSON.stringify(mat.weeks));

  // 首数据行首格 = 5502.37（items[0].weekly[0]），对齐到 2026WK34 列（index 0）
  check('1. 首数据行数据格数量 = 38', dataCols.length === 38, '实际 ' + dataCols.length);
  check('1. 首格 = 5502.37（对齐 2026WK34）', close(Number(dataCols[0]), 5502.37, 0.01), dataCols[0]);
  check('1. 次格 = 6566.61（对齐 2026WK35）', close(Number(dataCols[1]), 6566.61, 0.01), dataCols[1]);
  // 关键：5502.37 不再出现在错位位置（如原 WK32 列，现已不存在该列）
  check('1. 渲染无 NaN', mHtml.indexOf('NaN') < 0);
})();

// =========================================================================
console.log('\n========== 修复确认 2：computeMaterialDemand 周轴基准/额外周/未排期 ==========');
(function testComputeMaterialDemand() {
  const mat = EMB_GAP.material;
  const st = D.getState();
  // 构造：material 周内累加 + 额外周（早/晚）+ 未排期（忽略）
  const detailRows = [
    { U: '1020000001', P: '2026WK34', W: 10 },
    { U: '1020000001', P: '2026WK34', W: 5 },    // 累加 → 15
    { U: '1020000001', P: '2027WK40', W: 20 },   // 额外周（晚于 material 末周）
    { U: '1020000001', P: '2026WK20', W: 30 },   // 额外周（早于 material 首周）
    { U: '1020000001', P: '未排期', W: 999 },     // 未排期 → 忽略
    { U: '', P: '2026WK34', W: 88 }              // 空原料代码 → 忽略
  ];
  const r = D.computeMaterialDemand(detailRows);
  check('2. 返回结构含 weeks + data', !!r && Array.isArray(r.weeks) && !!r.data);
  check('2. weeks 长度 = 40（38 内置 + 2 额外周）', r.weeks.length === 40, '实际 ' + r.weeks.length);
  check('2. weeks[0] = 2026WK20（额外早周排序到最前）', r.weeks[0] === '2026WK20', r.weeks[0]);
  check('2. weeks 末 = 2027WK40（额外晚周排序到末尾）', r.weeks[39] === '2027WK40', r.weeks[39]);
  check('2. weeks 含全部 material.weeks 38 周', mat.weeks.every(w => r.weeks.indexOf(w) >= 0));
  check('2. 未排期不进 weeks', r.weeks.indexOf('未排期') < 0);
  check('2. data["1020000001"]["2026WK34"] = 15（累加）', r.data['1020000001'] && r.data['1020000001']['2026WK34'] === 15, r.data['1020000001'] && String(r.data['1020000001']['2026WK34']));
  check('2. data["1020000001"]["2027WK40"] = 20', r.data['1020000001'] && r.data['1020000001']['2027WK40'] === 20);
  check('2. data["1020000001"]["2026WK20"] = 30', r.data['1020000001'] && r.data['1020000001']['2026WK20'] === 30);
  check('2. 未排期无 data 记录', !r.data['1020000001'] || !('未排期' in r.data['1020000001']));
  check('2. 空原料代码被忽略', !r.data['']);

  // 上传模式渲染：demand.weeks 驱动表头，data 值覆盖内置
  st.materialDemand = r;
  D.renderMaterialA();
  const upHtml = getEl('materialAContainer').innerHTML;
  const up = extractMaterialHeaderAndFirstRow(upHtml);
  check('2. 上传模式表头 = 40 列', up.weekCols.length === 40, '实际 ' + up.weekCols.length);
  check('2. 上传模式表头首周 = 2026WK20', up.weekCols[0] === '2026WK20', up.weekCols[0]);
  // 首行 2026WK34 列（index = r.weeks.indexOf('2026WK34') = 2）应显示 15（重算覆盖内置 5502.37）
  const idx34 = r.weeks.indexOf('2026WK34');
  check('2. 上传模式首行 2026WK34 格 = 15（重算覆盖内置）', close(Number(up.dataCols[idx34]), 15, 1e-9), up.dataCols[idx34]);
  check('2. 上传模式首行 2026WK20 格 = 30', close(Number(up.dataCols[0]), 30, 1e-9), up.dataCols[0]);
  // 未在 demand 中覆盖的周（如 material 其它周）回退内置 weekly
  const idx35 = r.weeks.indexOf('2026WK35');
  check('2. 上传模式未覆盖周 2026WK35 回退内置 6566.61', close(Number(up.dataCols[idx35]), 6566.61, 0.01), up.dataCols[idx35]);
})();

// =========================================================================
console.log('\n========== 回归：computeDetailRows 300 / parseBudget6 / GAP / 下拉 / 预览 ==========');
(function testRegression() {
  // computeDetailRows 300
  function buildAoa(rows) {
    const header = ['h0', 'h1', 'h2'];
    const data = rows.map(r => {
      const row = new Array(23).fill(null);
      row[1] = r.B; row[2] = r.C; row[3] = r.D; row[4] = r.E;
      row[5] = r.F; row[6] = r.G; row[7] = r.H; row[8] = r.I;
      return row;
    });
    return header.concat(data);
  }
  const result = D.computeDetailRows(buildAoa(testdata));
  check('回归. computeDetailRows 返回 300 行', !!result && result.rows.length === 300);
  if (result && result.rows) {
    let bad = 0;
    for (let i = 0; i < result.rows.length; i++) {
      const o = result.rows[i], td = testdata[i];
      if (o.K !== td.K || o.L !== td.L || Math.abs((o.W || 0) - (td.W || 0)) > 1e-6) bad++;
      const jGot = Math.round((o.J || 0) * 100), jExp = Math.round((td.J || 0) * 100);
      if (jGot !== jExp) bad++;
    }
    check('回归. J/K/L/W 300/300 一致', bad === 0, bad + ' 行不一致');
  }

  // parseBudget6
  const aoa6 = [];
  aoa6.push(new Array(16).fill(null));
  aoa6[0][11] = '2026WK34'; aoa6[0][12] = '8月'; aoa6[0][13] = '2026WK35'; aoa6[0][14] = '9月';
  aoa6.push(new Array(16).fill(null)); aoa6[1][9] = 'DH071S PLAY500'; aoa6[1][11] = 100; aoa6[1][13] = 200;
  aoa6.push(new Array(16).fill(null)); aoa6[2][9] = 'DH071S PLAY500'; aoa6[2][11] = 50; aoa6[2][13] = 70;
  const b6 = D.parseBudget6(aoaToWs(aoa6));
  check('回归. parseBudget6 WK34=150/WK35=270', !!b6 && b6['DH071S PLAY500'] && b6['DH071S PLAY500']['2026WK34'] === 150 && b6['DH071S PLAY500']['2026WK35'] === 270);

  // computeGapReal
  const weeks = EMB_GAP.gap.weeks;
  const real = D.computeGapReal([{ N: 'DH001-S外壳', P: '2026WK33', L: 100 }]);
  check('回归. computeGapReal DH001S WK33 = 100', !!real && real['DH001S'] && real['DH001S'][weeks.indexOf('2026WK33')] === 100);

  // renderGap 产能公式
  const st = D.getState();
  st.gapReal = null;
  D.renderGap();
  const gapHtml = getEl('gapContainer').innerHTML;
  check('回归. renderGap 含 22,032（产能公式）', gapHtml.indexOf('22,032') >= 0);
  check('回归. renderGap 162 数据行（27×6）', (gapHtml.match(/class="first-mold"/g) || []).length === 27);

  // renderVarietyOptions
  st.varietyData = { varieties: ['DH001S外壳', 'DH010L外壳', 'DH010M外壳'], weeks: [], data: {} };
  D.renderVarietyOptions('DH010');
  const vDrop = getEl('varietyDrop').innerHTML;
  check('回归. 品种下拉过滤 "DH010" → 2 项', (vDrop.match(/ss-opt/g) || []).length === 2);

  // renderPreview 筛选
  st.preview = { sheets: [{ title: 't', rows: [['a'], ['DH001S外壳'], ['DH010L外壳']], formulas: {}, formulaCount: 0, cols: 1, sR: 0, sC: 0 }], activeSheet: 0, page: 0 };
  st.previewQuery = 'DH001';
  D.renderPreview();
  check('回归. 预览筛选计数正确', getEl('previewFilterCount').textContent.indexOf('匹配 1') >= 0, getEl('previewFilterCount').textContent);
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);
