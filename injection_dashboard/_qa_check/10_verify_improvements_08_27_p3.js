'use strict';
/* =========================================================================
 * QA 校验脚本 10：《改善08-27版-3》4 项修改 + 2 项补充修复独立复验（真实执行）
 *  改善1  模具产能 GAP 表格：EMBEDDED_GAP.gap(53周/27模具)、renderGap 27×6×53、
 *         computeGapReal 按核心码+周累加、每周可供产能公式、合计/GAP/弹性
 *  修复A  material 数据非空：EMBEDDED_GAP.material.weeks=38、items[0].weekly 38 非空
 *  修复B  预算行随上传更新：parseBudget6 / gapBudgetArr / lookupBudget6
 *  改善2  原料库存两表：renderMaterialA / renderStockB
 *  改善3  品种可搜索下拉：renderVarietySelect / renderVarietyOptions + 事件绑定
 *  改善4  数据预览筛选：renderPreview 关键字过滤 + 计数
 *  回归   computeDetailRows 300 行金标准、parseBudget/parseDetail/parseAnalysis2/3、
 *         mapMachineGroup、buildMachine、EMBEDDED_ANALYSIS 深度一致
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'D:/WorkBuddy工作资料/injection_dashboard';
const HTML = path.join(ROOT, 'index.html');
const ANALYSIS = path.join(ROOT, 'analysis_data.json');
const TESTDATA = path.join(ROOT, '_qa_check/testdata.json');

const html = fs.readFileSync(HTML, 'utf8');
const analysisRef = JSON.parse(fs.readFileSync(ANALYSIS, 'utf8'));
const testdata = JSON.parse(fs.readFileSync(TESTDATA, 'utf8')).rows;

let total = 0, passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? '  — ' + detail : '')); }
  else { failed++; failures.push(name); console.log('[FAIL] ' + name + (detail ? '  — ' + detail : '')); }
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

// ---------- 抽取内联脚本 ----------
function extractInlineScripts(src) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}
const scripts = extractInlineScripts(html);
const dataScript = scripts.find(s => /EMBEDDED_DATA/.test(s)) || '';
const logicScript = scripts.find(s => /__injectionDebug/.test(s)) || '';
check('内联脚本段识别：数据段 + 逻辑段', !!dataScript && !!logicScript);

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
let EMB_GAP = null, EMB_ANALYSIS = null;
try { EMB_GAP = extractConst(dataScript, 'EMBEDDED_GAP'); } catch (e) { check('抽取 EMBEDDED_GAP', false, e.message); }
try { EMB_ANALYSIS = extractConst(dataScript, 'EMBEDDED_ANALYSIS'); } catch (e) { check('抽取 EMBEDDED_ANALYSIS', false, e.message); }
check('内嵌 EMBEDDED_GAP 可抽取', !!EMB_GAP);
check('内嵌 EMBEDDED_ANALYSIS 可抽取', !!EMB_ANALYSIS);

function canonical(obj) {
  if (Array.isArray(obj)) return obj.map(canonical);
  if (obj && typeof obj === 'object') {
    const out = {};
    Object.keys(obj).sort().forEach(k => { out[k] = canonical(obj[k]); });
    return out;
  }
  return obj;
}

// ---------- SheetJS worksheet 桩工具 ----------
function colIdxToLetter(c) { let s = ''; c = c + 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
function letterToColIdx(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function aoaToWs(aoa) {
  const nrows = aoa.length;
  let ncols = 0;
  for (const r of aoa) ncols = Math.max(ncols, r.length);
  const ws = { '!ref': 'A1:' + colIdxToLetter(ncols - 1) + nrows };
  for (let r = 0; r < nrows; r++) {
    const row = aoa[r];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      ws[colIdxToLetter(c) + (r + 1)] = { v: v };
    }
  }
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

// ---------- DOM 桩（增强：记录事件处理器，支持 fire 手动触发） ----------
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
function fire(el, type, ev) {
  const h = el.__handlers && el.__handlers[type];
  if (h) h(ev || { key: '', target: el, preventDefault: function () {} });
}
const echartsStub = {
  getInstanceByDom: function (el) { return el.__echart || null; },
  init: function (el) {
    const c = {
      setOption: function (opt) { el.__echartOption = opt; },
      clear: function () {}, resize: function () {}
    };
    el.__echart = c;
    return c;
  }
};
const els = {};
function getEl(id) { if (els[id] === undefined) els[id] = makeEl(id); return els[id]; }

const kpiStore = { month: '', days: '', shell: '', value: '' };
function kpiInputEl(key) {
  const el = makeEl('kpiinput-' + key);
  Object.defineProperty(el, 'value', {
    get: function () { return (kpiStore[key] == null) ? '' : String(kpiStore[key]); },
    set: function (v) { kpiStore[key] = v; },
    enumerable: true, configurable: true
  });
  return el;
}

const localStorageStore = {};
const sandbox = {
  window: { echarts: echartsStub, XLSX: xlsxStub, addEventListener: function () {} },
  document: {
    readyState: 'complete', addEventListener: function (type, fn) { if (type === 'DOMContentLoaded') fn(); },
    getElementById: function (id) { return getEl(id); },
    querySelector: function (sel) {
      const m = String(sel).match(/^#kpiGrid\s+input\[data-key="([^"]+)"\]$/);
      if (m) return kpiInputEl(m[1]);
      return null;
    },
    querySelectorAll: function () { return []; },
    body: getEl('body')
  },
  FileReader: function () {},
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null; },
    setItem: function (k, v) { localStorageStore[k] = String(v); },
    removeItem: function (k) { delete localStorageStore[k]; }
  },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  console: console
};
vm.createContext(sandbox);
try {
  vm.runInContext(dataScript + '\n;\n' + logicScript, sandbox, { filename: 'logic.js' });
  console.log('[INFO] 逻辑脚本执行成功');
} catch (e) {
  console.error('[FATAL] 逻辑脚本执行失败：', e.message, '\n', e.stack);
  process.exit(2);
}
const D = sandbox.window && sandbox.window.__injectionDebug;
if (!D) { console.error('[FATAL] 未捕获 __injectionDebug'); process.exit(2); }
check('执行环境. __injectionDebug 已暴露', !!D);
['computeDetailRows', 'parseDetail', 'parseBudget', 'parseBudget6', 'computeGapReal', 'computeMaterialDemand',
 'renderGap', 'renderMaterialA', 'renderStockB', 'renderVarietyOptions', 'renderVarietySelect', 'renderPreview',
 'lookupBudget6', 'gapBudgetArr', 'moldCoreCode', 'moldMatchesVariety', 'mapMachineGroup', 'buildMachine',
 'parseAnalysis2', 'parseAnalysis3'].forEach(f => {
  check('暴露函数 ' + f, typeof D[f] === 'function');
});

// =========================================================================
console.log('\n========== 改善1：GAP 表格（数据常量 + 渲染 + 实单重算 + 产能公式） ==========');
(function testGap() {
  const gap = EMB_GAP.gap;
  check('1. gap.weeks 长度 = 53', !!gap && gap.weeks.length === 53, String(gap && gap.weeks.length));
  check('1. gap.workdays 长度 = 53', !!gap && gap.workdays.length === 53);
  check('1. gap.molds 长度 = 27', !!gap && gap.molds.length === 27, String(gap && gap.molds.length));
  const allKeys = !!gap && gap.molds.every(m => ('mold' in m) && ('cycle' in m) && ('sets' in m) && ('real' in m) && ('budget' in m));
  check('1. 27 模具均含 mold/cycle/sets/real/budget', allKeys);
  const realLenOk = !!gap && gap.molds.every(m => m.real.length === 53 && m.budget.length === 53);
  check('1. 每模具 real/budget 均为 53 周', realLenOk);

  // 每周可供产能公式：3600/cycle×22×sets×workday×0.85（molds[0]: cycle=55,sets=3,workdays[0]=6）
  const m0 = gap.molds[0];
  const wd0 = gap.workdays[0];
  const capExpected = 3600 / m0.cycle * 22 * m0.sets * wd0 * 0.85;
  check('1. 每周可供产能 = 22032（cycle55/sets3/wd6）', close(capExpected, 22032, 1e-6), String(capExpected));

  // renderGap 渲染：27 模具 × 6 行 × 53 周
  const st = D.getState();
  st.gapReal = null;  // 内置模式
  D.renderGap();
  const gapHtml = getEl('gapContainer').innerHTML;
  const trCount = (gapHtml.match(/<tr/g) || []).length;
  const firstMoldCount = (gapHtml.match(/class="first-mold"/g) || []).length;
  check('1. renderGap 输出 <tr> 总数 = 163（1 表头 + 162 数据）', trCount === 163, '实际 ' + trCount);
  check('1. renderGap 27 个模具分组（first-mold=27）', firstMoldCount === 27, '实际 ' + firstMoldCount);
  check('1. renderGap 无 NaN 输出', gapHtml.indexOf('NaN') < 0);
  // 表头：1 标签列（<th class="row-label">）+ 53 周列（<th>）
  const theadTh = (gapHtml.match(/<th\b/g) || []).length;
  check('1. renderGap 表头 <th> = 54（1 标签 + 53 周）', theadTh === 54, '实际 ' + theadTh);
  check('1. gapDesc 文案含 27 模具 × 53 周', getEl('gapDesc').textContent.indexOf('27 个模具 × 53 周') >= 0);
  // 产能数值渲染校验：DH001S 第 1 周（workdays[0]=6）→ 22032 → fmtInt "22,032"
  check('1. 渲染输出含 22,032（产能公式产物）', gapHtml.indexOf('22,032') >= 0);

  // computeGapReal：品种 "DH001-S外壳" 周 2026WK33 L=100 → 仅归入 DH001S
  const weeks = gap.weeks;
  const wk33Idx = weeks.indexOf('2026WK33');
  const detailRows = [{ N: 'DH001-S外壳', P: '2026WK33', L: 100 }];
  const real = D.computeGapReal(detailRows);
  check('1. computeGapReal 返回 27 模具键', !!real && Object.keys(real).length === 27);
  const dh001s = real && real['DH001S'];
  check('1. 品种 DH001-S外壳 → 归入 DH001S（WK33 累加 L=100）', !!dh001s && dh001s[wk33Idx] === 100, dh001s && String(dh001s[wk33Idx]));
  // 不应误归入其它模具
  let leak = 0;
  if (real) Object.keys(real).forEach(k => { if (k !== 'DH001S' && real[k][wk33Idx] !== 0) leak++; });
  check('1. 其它模具不被误匹配（仅 DH001S 累加）', leak === 0, leak + ' 个模具被误匹配');

  // moldMatchesVariety 核心码匹配
  check('1. moldMatchesVariety("DH001S","DH001-S外壳")=true', D.moldMatchesVariety('DH001S', 'DH001-S外壳') === true);
  check('1. moldCoreCode("DH071S  PLAY500")="DH071S"', D.moldCoreCode('DH071S  PLAY500') === 'DH071S', D.moldCoreCode('DH071S  PLAY500'));
})();

// =========================================================================
console.log('\n========== 修复A：material 数据非空 ==========');
(function testMaterialData() {
  const mat = EMB_GAP.material;
  check('A. material.weeks 长度 = 38', !!mat && mat.weeks.length === 38, String(mat && mat.weeks.length));
  check('A. material.items 数量 = 28', !!mat && mat.items.length === 28, String(mat && mat.items.length));
  const it0 = mat.items[0];
  check('A. items[0].code = 1020000001', !!it0 && it0.code === '1020000001', it0 && it0.code);
  check('A. items[0].weekly 长度 = 38', !!it0 && it0.weekly.length === 38, it0 && String(it0.weekly.length));
  check('A. items[0].weekly[0] ≈ 5502.37', !!it0 && close(it0.weekly[0], 5502.37, 0.01), it0 && String(it0.weekly[0]));
  const allLen38 = mat.items.every(it => (it.weekly || []).length === 38);
  const allNonEmpty = mat.items.every(it => (it.weekly || []).every(v => v != null && v !== '' && isFinite(v)));
  check('A. 全部 28 项 weekly 长度=38', allLen38);
  check('A. 全部 28 项 weekly 非空', allNonEmpty);

  // 原料需求表内置模式：检查 renderMaterialA 渲染列数是否与 material.weeks 一致（关键验收点）
  const st = D.getState();
  st.materialDemand = null;  // 内置模式
  D.renderMaterialA();
  const mHtml = getEl('materialAContainer').innerHTML;
  const mTheadTh = (mHtml.match(/<th\b/g) || []).length;  // 3 标签 + N 周列
  const mWeekCols = mTheadTh - 3;
  check('A. 原料需求表渲染周列 = 38（与 material.weeks 一致）', mWeekCols === 38, '实际 ' + mWeekCols + '（gap.weeks=' + EMB_GAP.gap.weeks.length + '）');
  check('A. 原料需求表渲染无 NaN', mHtml.indexOf('NaN') < 0);
  check('A. 内置模式首周值非空渲染（含 5502.37）', mHtml.indexOf('5502.37') >= 0);
  // 28 数据行
  const mDataRows = (mHtml.match(/<tr>/g) || []).length - 1; // 减去 thead tr
  check('A. 原料需求表数据行 = 28', mDataRows === 28, '实际 ' + mDataRows);
})();

// =========================================================================
console.log('\n========== 修复B：预算行随上传更新（parseBudget6 / gapBudgetArr / lookupBudget6） ==========');
(function testBudget6() {
  // 构造原始数据6：第1行周表头（L 列起 WK 周号 + 月份标签间隔），第2行起型号在 J 列
  const aoa = [];
  aoa.push(new Array(16).fill(null)); // 第1行表头
  aoa[0][11] = '2026WK34'; aoa[0][12] = '8月'; aoa[0][13] = '2026WK35'; aoa[0][14] = '9月';
  aoa.push(new Array(16).fill(null)); // 第2行
  aoa[1][9] = 'DH071S PLAY500'; aoa[1][11] = 100; aoa[1][13] = 200;
  aoa.push(new Array(16).fill(null)); // 第3行
  aoa[2][9] = 'DH071S PLAY500'; aoa[2][11] = 50; aoa[2][13] = 70;
  const b6 = D.parseBudget6(aoaToWs(aoa));
  check('B. parseBudget6 返回非空', !!b6 && Object.keys(b6).length === 1, JSON.stringify(Object.keys(b6 || {})));
  const b6m = b6 && b6['DH071S PLAY500'];
  check('B. 型号识别（J 列）', !!b6m);
  check('B. 周列识别 WK34 = 150（100+50）', !!b6m && b6m['2026WK34'] === 150, b6m && String(b6m['2026WK34']));
  check('B. 周列识别 WK35 = 270（200+70）', !!b6m && b6m['2026WK35'] === 270, b6m && String(b6m['2026WK35']));
  check('B. 月份标签（8月/9月）被忽略', !!b6m && !('8月' in b6m) && !('9月' in b6m) && Object.keys(b6m).length === 2, b6m && JSON.stringify(Object.keys(b6m)));

  // lookupBudget6：直接命中 + 经核心码扫描命中
  const st = D.getState();
  st.budget6 = { 'DH001S': { '2026WK34': 111 } };
  check('B. lookupBudget6 直接命中', D.lookupBudget6('DH001S') && D.lookupBudget6('DH001S')['2026WK34'] === 111);
  st.budget6 = { 'DH071S PLAY500': { '2026WK34': 888 } };
  const hit = D.lookupBudget6('DH071S');
  check('B. lookupBudget6 经核心码扫描命中（DH071S PLAY500→DH071S）', !!hit && hit['2026WK34'] === 888, JSON.stringify(hit));
  st.budget6 = { 'DH071S PLAY500': { '2026WK34': 888 } };
  check('B. lookupBudget6 未命中返回 null', D.lookupBudget6('DH999Z') === null);

  // gapBudgetArr：预算6命中用预算6、缺失周回退内置 mold.budget
  const weeks = EMB_GAP.gap.weeks;
  const wk34Idx = weeks.indexOf('2026WK34');
  const m = { mold: 'DH071S PLAY500', budget: weeks.map((w, i) => i + 1), cycle: 55, sets: 3, real: weeks.map(() => 0) };
  st.budget6 = { 'DH071S PLAY500': { '2026WK34': 999 } };
  const arr = D.gapBudgetArr(m);
  check('B. gapBudgetArr 长度 = 53', arr.length === 53);
  check('B. gapBudgetArr 命中周 WK34 = 999', arr[wk34Idx] === 999, 'arr[' + wk34Idx + ']=' + arr[wk34Idx]);
  check('B. gapBudgetArr 缺失周回退内置（WK32 idx0 = 1）', arr[0] === 1, String(arr[0]));
  check('B. gapBudgetArr 另一缺失周（WK33 idx1 = 2）', arr[1] === 2, String(arr[1]));
})();

// =========================================================================
console.log('\n========== 改善2：外壳库存表 ==========');
(function testStock() {
  check('2. stock 数组长度 = 141（含表头「料件编号」）', EMB_GAP.stock.length === 141, String(EMB_GAP.stock.length));
  check('2. stock[0] 为表头（料件编号/品名/规格）', EMB_GAP.stock[0].code === '料件编号' && EMB_GAP.stock[0].name === '品名' && EMB_GAP.stock[0].spec === '规格');
  check('2. stockTotal = 216553 PCS', EMB_GAP.stockTotal === 216553, String(EMB_GAP.stockTotal));
  const st = D.getState();
  st.gapStock = null;  // 内置模式
  D.renderStockB();
  const sHtml = getEl('stockContainer').innerHTML;
  check('2. 顶部总数文案含 216,553', sHtml.indexOf('216,553') >= 0);
  const sDataRows = (sHtml.match(/<tr>/g) || []).length - 1; // 减去 thead
  check('2. 外壳库存数据行 = 140（141 含表头过滤后）', sDataRows === 140, '实际 ' + sDataRows);
  check('2. 表头三列（料件编号/品名/规格）', sHtml.indexOf('料件编号') >= 0 && sHtml.indexOf('品名') >= 0 && sHtml.indexOf('规格') >= 0);
})();

// =========================================================================
console.log('\n========== 改善3：品种可搜索下拉 ==========');
(function testVarietySelect() {
  const st = D.getState();
  const varieties = ['DH001S外壳', 'DH001XS外壳', 'DH010L外壳', 'DH010M外壳', 'DH071S PLAY500', 'K54 S'];
  st.varietyData = { varieties: varieties, weeks: ['2026WK33'], data: {} };
  st.activeVariety = 'DH001S外壳';

  // renderVarietySelect：input.value = activeVariety
  D.renderVarietySelect();
  check('3. renderVarietySelect input.value = activeVariety', getEl('varietySelect').value === 'DH001S外壳', getEl('varietySelect').value);

  // renderVarietyOptions：关键字「包含」过滤
  D.renderVarietyOptions('DH010');
  let dropHtml = getEl('varietyDrop').innerHTML;
  check('3. 过滤 "DH010" → 2 项（DH010L/DH010M）', (dropHtml.match(/ss-opt/g) || []).length === 2, dropHtml.replace(/<[^>]+>/g, ' | '));
  check('3. 过滤结果含 DH010L', dropHtml.indexOf('DH010L外壳') >= 0);
  check('3. 过滤结果不含 DH001S', dropHtml.indexOf('DH001S外壳') < 0);

  // 无匹配 → 空提示
  D.renderVarietyOptions('ZZZ');
  dropHtml = getEl('varietyDrop').innerHTML;
  check('3. 无匹配显示「无匹配品种」', dropHtml.indexOf('无匹配品种') >= 0);

  // 空关键字 → 全量
  D.renderVarietyOptions('');
  dropHtml = getEl('varietyDrop').innerHTML;
  check('3. 空关键字显示全部 6 项', (dropHtml.match(/ss-opt/g) || []).length === 6, '实际 ' + (dropHtml.match(/ss-opt/g) || []).length);

  // 事件绑定存在性（enhanced stub 记录 addEventListener）
  const vsInput = getEl('varietySelect');
  const vsClear = getEl('varietyClear');
  const pf = getEl('previewFilter');
  check('3. varietySelect 绑定 input 事件', typeof vsInput.__handlers.input === 'function');
  check('3. varietySelect 绑定 keydown 事件', typeof vsInput.__handlers.keydown === 'function');
  check('3. varietySelect 绑定 focus 事件', typeof vsInput.__handlers.focus === 'function');
  check('3. varietyClear 绑定 click 事件（清空）', typeof vsClear.__handlers.click === 'function');

  // 回车选中（真实验证完整链路：keydown Enter → selectVariety）
  const drop = getEl('varietyDrop');
  D.renderVarietyOptions('DH010');
  const mockOpts = [
    { className: 'ss-opt', getAttribute: function () { return 'DH010L外壳'; }, scrollIntoView: function () {} },
    { className: 'ss-opt', getAttribute: function () { return 'DH010M外壳'; }, scrollIntoView: function () {} }
  ];
  drop.querySelectorAll = function (sel) { return sel === '.ss-opt' ? mockOpts : []; };
  st.activeVariety = 'DH001S外壳';
  fire(vsInput, 'keydown', { key: 'Enter', preventDefault: function () {} });
  check('3. 回车选中 DH010L外壳（activeVariety 更新）', st.activeVariety === 'DH010L外壳', st.activeVariety);
  check('3. 回车选中后 input.value 更新', vsInput.value === 'DH010L外壳', vsInput.value);
  check('3. 回车选中后下拉隐藏', drop.style.display === 'none', String(drop.style.display));

  // 清空（点击 × → selectVariety('')）
  st.activeVariety = 'DH001S外壳';
  vsInput.value = 'DH001S外壳';
  fire(vsClear, 'click', {});
  check('3. 清空后 activeVariety=""', st.activeVariety === '', JSON.stringify(st.activeVariety));
  check('3. 清空后 input.value=""', vsInput.value === '', JSON.stringify(vsInput.value));
})();

// =========================================================================
console.log('\n========== 改善4：数据预览筛选 ==========');
(function testPreviewFilter() {
  const st = D.getState();
  const rows = [
    ['型号', '数量', '备注'],
    ['DH001S外壳', 100, '黑色'],
    ['DH010L外壳', 200, '白色'],
    ['DH071S PLAY500', 300, '黑色']
  ];
  st.preview = { sheets: [{ title: '工单备料明细', rows: rows, formulas: {}, formulaCount: 0, cols: 3, sR: 0, sC: 0 }], activeSheet: 0, page: 0 };
  st.previewQuery = '';
  D.renderPreview();
  const cnt0 = getEl('previewFilterCount').textContent;
  check('4. 无筛选显示「共 4 行」', cnt0.indexOf('共 4 行') >= 0, cnt0);

  // 输入关键字按行「包含」匹配
  st.previewQuery = '黑色';
  D.renderPreview();
  const cnt1 = getEl('previewFilterCount').textContent;
  check('4. 筛选「黑色」匹配 2 / 共 4 行', cnt1.indexOf('匹配 2') >= 0 && cnt1.indexOf('共 4 行') >= 0, cnt1);
  const pvHtml = getEl('previewContainer').innerHTML;
  check('4. 筛选后含匹配行（DH001S外壳）', pvHtml.indexOf('DH001S外壳') >= 0);
  check('4. 筛选后不含不匹配行（DH010L外壳）', pvHtml.indexOf('DH010L外壳') < 0);

  // 清空恢复
  st.previewQuery = '';
  D.renderPreview();
  const cnt2 = getEl('previewFilterCount').textContent;
  check('4. 清空后恢复「共 4 行」', cnt2.indexOf('共 4 行') >= 0, cnt2);
})();

// =========================================================================
console.log('\n========== 回归 1：金标准 300 行 computeDetailRows ==========');
(function testRegression300() {
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
  const aoa = buildAoa(testdata);
  let result = null;
  try { result = D.computeDetailRows(aoa); } catch (e) { check('回归1. computeDetailRows 正常返回', false, e.message); }
  check('回归1. computeDetailRows 正常返回', !!result && Array.isArray(result.rows));
  if (result && result.rows) {
    check('回归1. 输出行数 = 300', result.rows.length === 300, '实际 ' + result.rows.length);
    const out = result.rows;
    let kBad = 0, lBad = 0, jBad = 0, wBad = 0;
    for (let i = 0; i < out.length; i++) {
      const o = out[i], td = testdata[i];
      if (o.K !== td.K) kBad++;
      if (o.L !== td.L) lBad++;
      const jGot = Math.round((o.J || 0) * 100), jExp = Math.round((td.J || 0) * 100);
      if (jGot !== jExp) jBad++;
      if (Math.abs((o.W || 0) - (td.W || 0)) > 1e-6) wBad++;
    }
    check('回归1. K 300/300 一致', kBad === 0, kBad + ' 行不一致');
    check('回归1. L 300/300 一致', lBad === 0, lBad + ' 行不一致');
    check('回归1. J 300/300 一致(±0.005)', jBad === 0, jBad + ' 行不一致');
    check('回归1. W 300/300 一致(±1e-6)', wBad === 0, wBad + ' 行不一致');
  }
})();

// =========================================================================
console.log('\n========== 回归 2：parseBudget（机台级） ==========');
(function testParseBudget() {
  const aoa = [];
  for (let r = 0; r < 6; r++) aoa.push(new Array(20).fill(null));
  aoa[3][11] = '34.2026'; aoa[3][12] = '34.2026'; aoa[3][13] = '35.2026'; aoa[3][14] = '35.2026';
  aoa[4][7] = '400T-550T';
  aoa[4][11] = 100; aoa[4][12] = 10; aoa[4][13] = 200; aoa[4][14] = 20;
  aoa[5][7] = '400T-550T';
  aoa[5][11] = 999; aoa[5][12] = 5; aoa[5][13] = 999; aoa[5][14] = 7;
  const res = D.parseBudget(aoaToWs(aoa));
  check('回归2. parseBudget 返回非空', !!res && !!res.budget);
  if (res) {
    const b = res.budget['400T-550T'];
    check('回归2. 34.2026 → 2026WK34', !!b && b['2026WK34'] !== undefined);
    check('回归2. 偶数列工时累加 WK34 = 15', !!b && b['2026WK34'] === 15, 'WK34=' + (b && b['2026WK34']));
    check('回归2. WK35 = 27', !!b && b['2026WK35'] === 27, 'WK35=' + (b && b['2026WK35']));
  }
})();

// =========================================================================
console.log('\n========== 回归 3：buildMachine / parseDetail / parseAnalysis2/3 / mapMachineGroup ==========');
(function testRegressionMisc() {
  // buildMachine 周轴不含内置旧周
  const dm = { weeks: ['2026WK30', '2026WK31'], groups: { '400T-550T': { real: [10, 20] } } };
  const budget = { '400T-550T': { '2026WK32': 5 } };
  const res = D.buildMachine(dm, budget);
  check('回归3. 周轴 = 上传周（3 周）', !!res && res.weeks.length === 3 && res.weeks.join(',') === '2026WK30,2026WK31,2026WK32', res && res.weeks.join(','));
  if (res) {
    check('回归3. real 对齐 [10,20,0]', JSON.stringify(res.groups['400T-550T'].real) === JSON.stringify([10, 20, 0]));
    check('回归3. budget 对齐 [0,0,5]', JSON.stringify(res.groups['400T-550T'].budget) === JSON.stringify([0, 0, 5]));
  }

  // parseDetail 未排期行不进机台图
  const aoa = [['h0'], ['h1'], ['h2']];
  const mk = (p) => {
    const row = new Array(23).fill(null);
    row[1] = 'ORD'; row[2] = '2090000283'; row[3] = '塑胶外壳类'; row[4] = '602227342/DH010XS/外壳/ABS/黑色/';
    row[7] = 0; row[8] = 0; row[9] = 100; row[11] = 10;
    row[15] = p; row[16] = '400T-550T'; row[17] = '1*1'; row[18] = 65; row[19] = 186; row[22] = 0;
    return row;
  };
  aoa.push(mk('2026WK30'));
  aoa.push(mk('未排期'));
  const pd = D.parseDetail(aoaToWs(aoa));
  check('回归3. parseDetail 返回', !!pd);
  if (pd) {
    check('回归3. 机台周轴仅 [2026WK30]', JSON.stringify(pd.machine.weeks) === JSON.stringify(['2026WK30']), JSON.stringify(pd.machine.weeks));
    const g = pd.machine.groups['400T-550T'];
    check('回归3. 未排期行工时未进入机台图（real=[100]）', !!g && JSON.stringify(g.real) === JSON.stringify([100]), g && JSON.stringify(g.real));
  }

  // parseAnalysis2 固定列（第5行数据起；400T-550T 周列=1-based2/实单=3，230T-280T 周列=13/实单=14）
  const a2 = [];
  for (let r = 0; r < 45; r++) a2.push(new Array(60).fill(null));
  a2[4][1] = '2026WK34'; a2[4][2] = 100; a2[4][3] = 1320; a2[4][4] = 1452; a2[4][5] = 50;
  a2[4][12] = '2026WK34'; a2[4][13] = 200; a2[4][14] = 900; a2[4][15] = 990; a2[4][16] = 30;
  const r2 = D.parseAnalysis2(aoaToWs(a2));
  check('回归3. parseAnalysis2 返回', !!r2 && r2.weeks.length === 1 && !!r2.groups['400T-550T'] && !!r2.groups['230T-280T']);
  if (r2) {
    check('回归3. parseAnalysis2 400T-550T real=100', r2.groups['400T-550T'].real[0] === 100, String(r2.groups['400T-550T'].real[0]));
    check('回归3. parseAnalysis2 230T-280T real=200', r2.groups['230T-280T'].real[0] === 200, String(r2.groups['230T-280T'].real[0]));
  }

  // parseAnalysis3 固定列（第16行表头，第17行起数据，取前10；外壳 A=品名/B=PCS/C=金额，配件 F=品名/G=PCS/H=金额）
  const a3 = [];
  for (let r = 0; r < 20; r++) a3.push(new Array(10).fill(null));
  a3[16][0] = 'DH001外壳'; a3[16][1] = 500; a3[16][2] = 1000; a3[16][3] = 400; a3[16][4] = 100;
  a3[16][5] = '帽沿'; a3[16][6] = 300; a3[16][7] = 600;
  const r3 = D.parseAnalysis3(aoaToWs(a3));
  check('回归3. parseAnalysis3 返回', !!r3 && r3.shell.length === 1 && r3.acc.length === 1);
  if (r3) {
    check('回归3. parseAnalysis3 shell.name = DH001外壳', r3.shell[0].name === 'DH001外壳', r3.shell[0].name);
    check('回归3. parseAnalysis3 shell.pcs = 500', r3.shell[0].pcs === 500);
    check('回归3. parseAnalysis3 acc.name = 帽沿', r3.acc[0].name === '帽沿');
  }

  // mapMachineGroup('150T-280T')
  check('回归3. mapMachineGroup("150T-280T") = 150T-280T', D.mapMachineGroup('150T-280T') === '150T-280T', D.mapMachineGroup('150T-280T'));
  check('回归3. mapMachineGroup("400T-550T") = 400T-550T', D.mapMachineGroup('400T-550T') === '400T-550T');
})();

// =========================================================================
console.log('\n========== 回归 4：EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致 ==========');
(function testEmbedded() {
  if (EMB_ANALYSIS) {
    check('回归4. 深度一致', JSON.stringify(canonical(EMB_ANALYSIS)) === JSON.stringify(canonical(analysisRef)));
    check('回归4. machine.weeks 长度 = 38', EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.weeks.length === 38, String(EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.weeks.length));
    const gKeys = EMB_ANALYSIS.machine && Object.keys(EMB_ANALYSIS.machine.groups) || [];
    check('回归4. machine.groups 5 键', gKeys.length === 5, JSON.stringify(gKeys));
  }
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);
