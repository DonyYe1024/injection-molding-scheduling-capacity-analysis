'use strict';
/* =========================================================================
 * QA 校验脚本 14：《改善08-30版-3》独立验证（QA 全新视角，独立构造桩数据）
 * 验证范围：
 *   改善1  斑马纹 CSS（.data-table 隔行极浅底色 + sticky 首列同色 + first-mold/cell-total 兼容）
 *   改善2  top10 动态重算（删周别下拉 + computeDetailRows 新增 M 列 + computeTop10ByMonth
 *          + renderTop10 分支 + 触发 renderKPI/shiftCalendarMonth + J/K/L/W 300 回归）
 *   改善3  预览筛选（仅工单备料明细生效 + E列规格匹配 + H列求和按分析月累计穿透分页/筛选）
 *   回归   parseBudget / parseAnalysis2/3 固定列 / mapMachineGroup / EMBEDDED 深度一致
 * 运行：NODE_OPTIONS= node 14_verify_improvements_08_30_v3.js
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'D:/WorkBuddy工作资料/injection_dashboard';
const HTML = path.join(ROOT, 'index.html');
const TESTDATA = path.join(ROOT, '_qa_check/testdata.json');
const ANALYSIS_JSON = path.join(ROOT, 'analysis_data.json');
const GAP_JSON = path.join(ROOT, 'gap_material_data.json');

const html = fs.readFileSync(HTML, 'utf8');

let total = 0, passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail != null ? '  — ' + detail : '')); }
  else { failed++; failures.push(name); console.log('[FAIL] ' + name + (detail != null ? '  — ' + detail : '')); }
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------- 抽取内联脚本 ----------
function extractInlineScripts(src) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = []; let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}
const scripts = extractInlineScripts(html);
const dataScript = scripts.find(s => /EMBEDDED_DATA/.test(s)) || '';
const logicScript = scripts.find(s => /__injectionDebug/.test(s)) || '';

// =========================================================================
// 改善1：斑马纹 CSS（静态）
// =========================================================================
console.log('========== 改善1：斑马纹 CSS ==========');
(function testZebra() {
  const evenTd = (html.match(/\.data-table\s+tbody\s+tr:nth-child\(even\)\s+td\s*\{[^}]*\}/) || [''])[0];
  const evenLabel = (html.match(/\.data-table\s+tbody\s+tr:nth-child\(even\)\s+td\.row-label\s*\{[^}]*\}/) || [''])[0];
  const baseLabel = (html.match(/\.data-table\s+td\.row-label\s*\{[^}]*\}/) || [''])[0];
  const cellTotal = (html.match(/\.data-table\s+td\.cell-total\s*\{[^}]*\}/) || [''])[0];
  const firstMold = (html.match(/\.data-table\s+tr\.first-mold\s+td\s*\{[^}]*\}/) || [''])[0];

  check('1. 偶数行 td 斑马纹规则存在', evenTd.length > 0);
  const mBg = evenTd.match(/background:\s*([^;]+);/);
  check('1. 偶数行有 background 声明', !!mBg, mBg && mBg[1].trim());
  // 极浅颜色：解析 hex 并检查每个通道 >= 240
  let light = false, hexVal = '';
  if (mBg) {
    const hexm = mBg[1].match(/#([0-9a-fA-F]{6})/);
    if (hexm) {
      hexVal = hexm[1].toLowerCase();
      const r = parseInt(hexVal.slice(0, 2), 16), g = parseInt(hexVal.slice(2, 4), 16), b = parseInt(hexVal.slice(4, 6), 16);
      light = r >= 240 && g >= 240 && b >= 240;
    }
  }
  check('1. 偶数行底色极浅（RGB 各通道 >=240）', light, hexVal);

  check('1. 偶数行 sticky 首列 td.row-label 同色覆盖规则存在', evenLabel.length > 0);
  const mlBg = evenLabel.match(/background:\s*([^;]+);/);
  const labelColorOk = mlBg && mBg && mlBg[1].trim() === mBg[1].trim();
  check('1. row-label 覆盖色与偶数行 body 色一致', !!labelColorOk, mlBg && mlBg[1].trim());

  // 兼容 first-mold / cell-total：不得覆盖 background（只设 border-top / font-weight）
  check('1. .cell-total 规则存在且不覆盖背景', cellTotal.length > 0 && !/background/.test(cellTotal));
  check('1. .first-mold 规则存在且不覆盖背景', firstMold.length > 0 && !/background/.test(firstMold));
  check('1. 基础 row-label sticky 左列存在', baseLabel.length > 0 && /position:\s*sticky/.test(baseLabel) && /left:\s*0/.test(baseLabel));
})();

// =========================================================================
// 改善2 前置：死代码删除（周别下拉）
// =========================================================================
console.log('\n========== 改善2a：周别下拉已删除 ==========');
(function testDeadTop10Week() {
  const needles = ['top10WeekSelect', 'state.top10Week', 'renderTop10Select', 'computeTop10Week', 'top10WeekOptions'];
  for (const n of needles) check('2a. 全文无残留 "' + n + '"', html.indexOf(n) < 0);
  check('2a. HTML 无 top10WeekSelect 元素 id', /id=["']top10WeekSelect/.test(html) === false);
  // bindEvents / renderAll / restoreEmbedded / __injectionDebug 均无引用（全量 grep 已覆盖，这里再校验关键块）
  check('2a. __injectionDebug 无 renderTop10Select/computeTop10Week', !/renderTop10Select|computeTop10Week/.test(logicScript.match(/window\.__injectionDebug\s*=[\s\S]*?\};/)[0] || ''));
})();

// =========================================================================
// 桩环境构建（扩展自 13 脚本，支持 KPI 输入/图表捕获/预览元素）
// =========================================================================
let Dbg = null, state = null;
const kpiStore = { month: '', days: '', shell: '', value: '' };
const localStorageStore = {};
const els = {};

(function buildStubAndInit() {
  function colIdxToLetter(c) { let s = ''; c = c + 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
  function letterToColIdx(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
  const xlsxUtils = {
    decode_range(ref) { const m = String(ref).match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i); if (!m) return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }; const c1 = letterToColIdx(m[1]), r1 = Number(m[2]) - 1; const c2 = m[3] ? letterToColIdx(m[3]) : c1, r2 = m[4] ? Number(m[4]) - 1 : r1; return { s: { r: r1, c: c1 }, e: { r: r2, c: c2 } }; },
    encode_cell(cell) { return colIdxToLetter(cell.c) + (cell.r + 1); },
    sheet_to_json(ws) { return ws; }
  };
  const xlsxStub = { utils: xlsxUtils };
  function makeClassList() { const set = new Set(); return { add: function () { for (const a of arguments) set.add(a); }, remove: function () { for (const a of arguments) set.delete(a); }, toggle: function (n, f) { const on = (f === undefined) ? !set.has(n) : !!f; if (on) set.add(n); else set.delete(n); return on; }, contains: function (n) { return set.has(n); } }; }
  function makeEl(id) { const el = { id: id, innerHTML: '', style: {}, className: '', textContent: '', value: '', classList: makeClassList(), __handlers: {}, addEventListener: function (t, fn) { el.__handlers[t] = fn; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, setAttribute: function () {}, getAttribute: function () { return null; }, disabled: false, __echart: null, __echartOption: null }; return el; }
  function getEl(id) { if (els[id] === undefined) els[id] = makeEl(id); return els[id]; }

  // KPI 输入元素（month/days/shell/value），值由 kpiStore 控制（缓存，保证 renderKPI 绑定与读取同元素）
  const kpiInputCache = {};
  function kpiInputEl(key) {
    if (kpiInputCache[key]) return kpiInputCache[key];
    const el = makeEl('kpiinput-' + key);
    el.getAttribute = function (a) { return a === 'data-key' ? key : null; };
    Object.defineProperty(el, 'value', { get: function () { return kpiStore[key] == null ? '' : String(kpiStore[key]); }, set: function (v) { kpiStore[key] = v; }, enumerable: true, configurable: true });
    kpiInputCache[key] = el;
    return el;
  }
  // 月历 nav 按钮（data-nav = ±1），供 shiftCalendarMonth 触发测试（缓存，保证 renderCalendar 绑定与读取同元素）
  const navCache = {};
  function navEl(delta) {
    const k = String(delta);
    if (navCache[k]) return navCache[k];
    const el = makeEl('calnav' + delta); el.getAttribute = function (a) { return a === 'data-nav' ? k : null; };
    navCache[k] = el;
    return el;
  }

  const echartsStub = { getInstanceByDom: function (el) { return el.__echart || null; }, init: function (el) { const c = { setOption: function (o) { el.__echartOption = o; }, clear: function () {}, resize: function () {} }; el.__echart = c; return c; } };

  const sandbox = {
    window: { echarts: echartsStub, XLSX: xlsxStub, addEventListener: function () {} },
    document: {
      readyState: 'complete',
      addEventListener: function (t, fn) { if (t === 'DOMContentLoaded') fn(); },
      getElementById: function (id) {
        if (id === 'kpiGrid') {
          const g = getEl('kpiGrid');
          g.querySelectorAll = function (sel) { return sel === '.kpi-input' ? ['month', 'days', 'shell', 'value'].map(kpiInputEl) : []; };
          return g;
        }
        if (id === 'metaCalendar') {
          const c = getEl('metaCalendar');
          c.querySelectorAll = function (sel) { return sel === '.cal-nav' ? [navEl(-1), navEl(1)] : []; };
          return c;
        }
        return getEl(id);
      },
      querySelector: function (sel) { const m = String(sel).match(/^#kpiGrid\s+input\[data-key="([^"]+)"\]$/); if (m) return kpiInputEl(m[1]); return null; },
      querySelectorAll: function () { return []; },
      body: getEl('body')
    },
    FileReader: function () {},
    localStorage: { getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null; }, setItem: function (k, v) { localStorageStore[k] = String(v); }, removeItem: function (k) { delete localStorageStore[k]; } },
    setTimeout: setTimeout, clearTimeout: clearTimeout, console: console
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(dataScript + '\n;\n' + logicScript, sandbox, { filename: 'logic.js' });
    check('桩. 逻辑 IIFE + init 加载无异常', true);
  } catch (e) {
    check('桩. 逻辑 IIFE + init 加载无异常', false, e.message);
    return;
  }
  Dbg = sandbox.window && sandbox.window.__injectionDebug;
  check('桩. __injectionDebug 已暴露', !!Dbg);
  if (Dbg && typeof Dbg.getState === 'function') state = Dbg.getState();
})();

// 工具：设置分析月份（同步 kpiStore + localStorage），确保 getKpiValue 一致
function setMonth(v) {
  kpiStore.month = (v == null ? '' : String(v));
  let cfg = {};
  try { cfg = JSON.parse(localStorageStore['injectionKpi'] || '{}'); } catch (e) { cfg = {}; }
  cfg.month = kpiStore.month;
  localStorageStore['injectionKpi'] = JSON.stringify(cfg);
}
// 工具：aoa → worksheet（与 13 脚本一致）
function colIdxToLetter(c) { let s = ''; c = c + 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
function aoaToWs(aoa) { const nrows = aoa.length; let ncols = 0; for (const r of aoa) ncols = Math.max(ncols, r.length); const ws = { '!ref': 'A1:' + colIdxToLetter(ncols - 1) + nrows }; for (let r = 0; r < nrows; r++) { const row = aoa[r]; for (let c = 0; c < row.length; c++) { const v = row[c]; if (v === null || v === undefined) continue; ws[colIdxToLetter(c) + (r + 1)] = { v: v }; } } return ws; }

// =========================================================================
// 改善2b：computeDetailRows 新增 M 列 + J/K/L/W 300 回归
// =========================================================================
console.log('\n========== 改善2b：computeDetailRows M 列 + J/K/L/W 回归 ==========');
(function testComputeDetail() {
  if (!Dbg) { check('2b. 前置 Dbg 可用', false); return; }

  // M 列：构造含 index12 的 aoa，验证 M = row[12]
  const aoaM = [['h0'], ['h1'], ['h2'], []];
  const rM = new Array(13).fill(null); rM[12] = '2026-08-10'; rM[1] = 'B'; rM[2] = 'C'; rM[7] = 5; aoaM.push(rM);
  const resM = Dbg.computeDetailRows(aoaM);
  check('2b. computeDetailRows 输出含 M 字段 = row[12]', !!resM && resM.rows.length === 1 && resM.rows[0].M === '2026-08-10', resM && JSON.stringify(resM.rows[0] && resM.rows[0].M));
  check('2b. 输出仍含 J/K/L/W 字段', !!resM && resM.rows[0] && 'J' in resM.rows[0] && 'K' in resM.rows[0] && 'L' in resM.rows[0] && 'W' in resM.rows[0]);

  // J/K/L/W 300 金标准（与 13 脚本同口径）
  const testdata = JSON.parse(fs.readFileSync(TESTDATA, 'utf8')).rows;
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
  const result = Dbg.computeDetailRows(buildAoa(testdata));
  check('2b. computeDetailRows 返回 300 行', !!result && result.rows.length === 300);
  if (result && result.rows) {
    let badJ = 0, badK = 0, badL = 0, badW = 0;
    for (let i = 0; i < result.rows.length; i++) {
      const o = result.rows[i], td = testdata[i];
      if (o.K !== td.K) badK++;
      if (o.L !== td.L) badL++;
      if (Math.abs((o.W || 0) - (td.W || 0)) > 1e-6) badW++;
      if (Math.round((o.J || 0) * 100) !== Math.round((td.J || 0) * 100)) badJ++;
    }
    check('2b. J/K/L/W 300/300 一致（回归金标准）', badJ + badK + badL + badW === 0, 'J=' + badJ + ' K=' + badK + ' L=' + badL + ' W=' + badW);
  }
})();

// =========================================================================
// 改善2c：computeTop10ByMonth 动态重算（独立构造桩 detailRows + budgetQtyByVariety）
// =========================================================================
console.log('\n========== 改善2c：computeTop10ByMonth ==========');
(function testTop10Compute() {
  if (!Dbg || !state) { check('2c. 前置 state 可用', false); return; }
  state.detailRows = [
    { P: '2026WK34', M: '2026-08-10', N: '外壳A', L: 100, Q: '400T-550T' },
    { P: '2026WK36', M: '2026-09-10', N: '外壳B', L: 200, Q: '400T-550T' },
    { P: '未排期', M: '2026-08-15', N: '外壳C', L: 300, Q: '400T-550T' },
    { P: '2026WK35', M: '2026-08-20', N: '配件D', L: 50, Q: '230T-280T' },
    { P: '2026WK35', M: '', N: '外壳E', L: 70, Q: '400T-550T' }
  ];
  state.budgetQtyByVariety = {
    '外壳A': { '2026WK34': 1000, '2026WK40': 500 },
    '配件D': { '2026WK36': 300 },
    '外壳F': { '2026WK34': 800 }
  };
  state.budgetVarietyMachine = { '外壳A': '400T-550T', '配件D': '230T-280T', '外壳F': '400T-550T' };

  const r = Dbg.computeTop10ByMonth({ y: 2026, m: 8 });
  check('2c. 返回 {shell,acc}', !!r && Array.isArray(r.shell) && Array.isArray(r.acc));

  function find(arr, name) { return (arr || []).filter(x => x.name === name)[0]; }
  const sA = find(r.shell, '外壳A'), sF = find(r.shell, '外壳F'), aD = find(r.acc, '配件D');
  // 实单 PCS：仅「已排期 且 M ≤ 月末」的 L；外壳B(09-10)、外壳C(未排期)、外壳E(M空) 均应排除
  check('2c. 外壳A 实单=100（已排期且≤月末）', !!sA && sA.realQty === 100, sA && JSON.stringify(sA));
  check('2c. 外壳A PCS = 实单100 + 预算1500 = 1600', !!sA && sA.pcs === 1600 && sA.budgetQty === 1500, sA && (sA.pcs + '/' + sA.budgetQty));
  check('2c. 外壳F 纯预算 PCS=800（预算全量不按月份截断）', !!sF && sF.pcs === 800 && sF.realQty === 0, sF && JSON.stringify(sF));
  check('2c. 配件D PCS = 50 + 300 = 350', !!aD && aD.pcs === 350 && aD.realQty === 50 && aD.budgetQty === 300, aD && JSON.stringify(aD));
  // 分类：400T-550T → shell，其余 → acc
  check('2c. 外壳A/外壳F 归 shell（400T-550T）', !!sA && !!sF);
  check('2c. 配件D 归 acc（230T-280T）', !!aD);
  // 排除项不在结果中
  const allNames = r.shell.concat(r.acc).map(x => x.name);
  check('2c. 未排期/超月末/无日期行 均不进入结果（外壳B/C/E）', ['外壳B', '外壳C', '外壳E'].every(n => allNames.indexOf(n) < 0), allNames.join(','));
  // amount=null
  check('2c. 所有项 amount=null', r.shell.concat(r.acc).every(x => x.amount === null));
  // PCS = 实单 + 预算 一致性
  check('2c. 每项 PCS === realQty + budgetQty', r.shell.concat(r.acc).every(x => x.pcs === x.realQty + x.budgetQty));

  // buildTop10Option 对 null 金额不报错 + tooltip 显示 '-'（fmtMoney(null)='-'）
  let optErr = null, opt = null;
  try { opt = Dbg.buildTop10Option([{ name: 'A', pcs: 10, amount: null }, { name: 'B', pcs: 5, amount: null }]); } catch (e) { optErr = e.message; }
  check('2c. buildTop10Option(null 金额) 不报错', optErr === null && !!opt, optErr || '');
  let tip = '';
  try { tip = opt.tooltip.formatter({ data: { name: 'A', value: 10, pct: '66.7', amount: null } }); } catch (e) { tip = 'ERR:' + e.message; }
  check('2c. tooltip 对 null 金额渲染为 "-"（不报错）', /金额：-/.test(tip), tip);
  check('2c. buildTop10Option 数据保留 amount=null', !!opt && opt.series[0].data.length === 2 && opt.series[0].data.every(d => d.amount === null));
})();

// =========================================================================
// 改善2d：renderTop10 分支 + 触发（renderKPI month / shiftCalendarMonth）
// =========================================================================
console.log('\n========== 改善2d：renderTop10 分支与触发 ==========');
(function testRenderTop10() {
  if (!Dbg || !state) { check('2d. 前置 state 可用', false); return; }
  // 复用一个确定性 stub：外壳A M=2026-08-10（月08含、月07不含）
  state.detailRows = [
    { P: '2026WK34', M: '2026-08-10', N: '外壳A', L: 100, Q: '400T-550T' }
  ];
  state.budgetQtyByVariety = null;
  state.budgetVarietyMachine = null;
  function shellNames() {
    const el = els['top10ShellChart'];
    if (!el || !el.__echartOption) return [];
    const data = el.__echartOption.series && el.__echartOption.series[0] && el.__echartOption.series[0].data || [];
    return data.map(d => d.name);
  }

  // 分支1：月份有值 + detailRows 存在 → computeTop10ByMonth
  setMonth('2026-08');
  Dbg.renderTop10();
  check('2d. 分支1（月08+明细）走 computeTop10ByMonth → shell 含 外壳A', shellNames().indexOf('外壳A') >= 0, shellNames().join(','));

  // 分支2：月份为空 → buildTop10Data（内置）
  setMonth('');
  Dbg.renderTop10();
  const builtin = Dbg.buildTop10Data().shell.map(x => x.name);
  check('2d. 分支2（月空）走 buildTop10Data → shell 与内置一致', deepEq(shellNames().slice(0, builtin.length), builtin), shellNames().join(','));

  // 触发1：shiftCalendarMonth（通过月历 nav 点击）。先 renderCalendar 绑定并确定 calendarMonth
  setMonth('2026-08');
  Dbg.renderCalendar();
  Dbg.renderTop10();
  check('2d. 触发前 shell 含 外壳A（月08）', shellNames().indexOf('外壳A') >= 0);
  const navs = els['metaCalendar'] ? els['metaCalendar'].querySelectorAll('.cal-nav') : [];
  check('2d. 月历 nav 按钮已绑定（2 个）', navs.length === 2, navs.length + ' 个');
  if (navs.length) {
    // 触发 nav[-1]（上一月 → 07），内部调用 shiftCalendarMonth(-1) → renderTop10
    let navErr = null;
    try { navs[0].__handlers['click'].call(navs[0]); } catch (e) { navErr = e.message; }
    check('2d. shiftCalendarMonth(-1) 无异常', navErr === null, navErr || '');
    check('2d. 翻到月07后 shell 不再含 外壳A（08-10 > 07-31 被排除）', shellNames().indexOf('外壳A') < 0, shellNames().join(','));
    check('2d. 月份输入框已同步为 2026-07', kpiStore.month === '2026-07', kpiStore.month);
  }

  // 触发2：renderKPI month 输入变化 → renderTop10
  setMonth('2026-07');
  Dbg.renderTop10();
  check('2d. 触发前（月07）shell 不含 外壳A', shellNames().indexOf('外壳A') < 0);
  Dbg.renderKPI(); // 绑定 input 事件
  const monthInput = els['kpiGrid'] ? els['kpiGrid'].querySelectorAll('.kpi-input').filter(i => i.getAttribute('data-key') === 'month')[0] : null;
  check('2d. renderKPI 已为 month 输入绑定事件', !!monthInput && !!monthInput.__handlers['input'], monthInput && 'bound');
  if (monthInput && monthInput.__handlers['input']) {
    // 模拟用户把月份改为 08
    kpiStore.month = '2026-08';
    let kpiErr = null;
    try { monthInput.__handlers['input'].call(monthInput); } catch (e) { kpiErr = e.message; }
    check('2d. renderKPI month 输入变化无异常', kpiErr === null, kpiErr || '');
    check('2d. month 变化后触发 renderTop10 → shell 含 外壳A（月08）', shellNames().indexOf('外壳A') >= 0, shellNames().join(','));
    check('2d. month 值已持久化 localStorage', (JSON.parse(localStorageStore['injectionKpi'] || '{}').month) === '2026-08');
  }
})();

// =========================================================================
// 改善3：预览筛选（仅明细表生效 + E列规格 + H列求和穿透分页/筛选）
// =========================================================================
console.log('\n========== 改善3：预览筛选 ==========');
(function testPreview() {
  if (!Dbg || !state) { check('3. 前置 state 可用', false); return; }

  // isDetailSheet
  check('3. isDetailSheet(工单备料明细)=true', Dbg.isDetailSheet({ title: '原始数据1（工单备料明细）' }) === true);
  check('3. isDetailSheet(主排程)=false', Dbg.isDetailSheet({ title: '原始数据2（最新主排程上线日期）' }) === false);
  check('3. isDetailSheet(预算)=false', Dbg.isDetailSheet({ title: '原始数据3（DKL最新预算数据-工时）' }) === false);

  // 明细表：3 表头 + 5 数据行；E=index4 规格，H=index7 未发数量，M=index12 上线日期
  function mkRow() { return new Array(13).fill(''); }
  const h0 = mkRow(); h0[4] = '规格'; h0[7] = '未发数量'; h0[12] = '上线日期';
  const h1 = mkRow(), h2 = mkRow();
  const d0 = mkRow(); d0[4] = 'DH010-ABC'; d0[5] = '含关键字在品名列'; d0[7] = 10; d0[12] = '2026-08-10';
  const d1 = mkRow(); d1[4] = '关键字外壳'; d1[5] = 'normal'; d1[7] = 20; d1[12] = '2026-08-20';
  const d2 = mkRow(); d2[4] = 'DH020'; d2[5] = 'x'; d2[7] = 30; d2[12] = '2026-09-05';
  const d3 = mkRow(); d3[4] = 'DH030-关键字'; d3[5] = 'y'; d3[7] = 40; d3[12] = '2026-07-15';
  const d4 = mkRow(); d4[4] = 'DH040'; d4[5] = 'z'; d4[7] = '#N/A'; d4[12] = '2026-08-10'; // #N/A 容错
  const detailRows = [h0, h1, h2, d0, d1, d2, d3, d4];
  const detailSheet = { title: '原始数据1（工单备料明细）', rows: detailRows, formulas: {}, formulaCount: 0, cols: 13, sR: 0, sC: 0 };
  const scheduleSheet = { title: '原始数据2（最新主排程上线日期）', rows: [['订单号', '上线日期'], ['SO关键字1', '2026-08-01'], ['SO2', '2026-08-02']], formulas: {}, formulaCount: 0, cols: 2, sR: 0, sC: 0 };
  const budgetSheet = { title: '原始数据3（DKL最新预算数据-工时）', rows: [['品名'], ['关键字row'], ['row2']], formulas: {}, formulaCount: 0, cols: 1, sR: 0, sC: 0 };

  // computePreviewHSum：按分析月累计
  state.preview = { sheets: [detailSheet, scheduleSheet, budgetSheet], activeSheet: 0, page: 0 };
  setMonth('2026-08');
  check('3. computePreviewHSum(月08)=70（含 #N/A 容错）', Dbg.computePreviewHSum(detailSheet) === 70, Dbg.computePreviewHSum(detailSheet));
  setMonth('');
  check('3. computePreviewHSum(月空)=100（全表）', Dbg.computePreviewHSum(detailSheet) === 100, Dbg.computePreviewHSum(detailSheet));

  // renderPreview：明细表筛选（E列规格）+ H求和显示
  setMonth('2026-08');
  state.preview.activeSheet = 0;
  state.preview.page = 0;
  state.previewQuery = '关键字';
  Dbg.renderPreview();
  const countEl = els['previewFilterCount'], hSumEl = els['previewHSum'];
  check('3. 明细表 筛选计数="匹配 2 / 共 8 行"（仅E列规格匹配，品名列关键字不命中）', !!countEl && countEl.textContent === '匹配 2 / 共 8 行', countEl && countEl.textContent);
  check('3. 明细表 H求和显示 "未发数量合计：70（截至 2026-08 月末）"', !!hSumEl && /未发数量合计：70/.test(hSumEl.textContent) && /2026-08/.test(hSumEl.textContent), hSumEl && hSumEl.textContent);

  // renderPreview：非明细表（主排程/预算）不筛选 + H求和隐藏
  for (const idx of [1, 2]) {
    state.preview.activeSheet = idx;
    state.preview.page = 0;
    state.previewQuery = '关键字';
    Dbg.renderPreview();
    const n = idx === 1 ? 3 : 3; // 两表均 3 行
    check('3. 非明细表(sheet' + idx + ') 有关键字仍显示全部行（不筛选）', !!countEl && countEl.textContent === '共 ' + n + ' 行', countEl && countEl.textContent);
    check('3. 非明细表(sheet' + idx + ') H求和隐藏（空）', !!hSumEl && hSumEl.textContent === '', JSON.stringify(hSumEl && hSumEl.textContent));
  }

  // 明细表 翻页穿透：H求和 与 筛选计数 不随分页变化
  const big = [mkRow(), mkRow(), mkRow()];
  for (let i = 0; i < 55; i++) { const rr = mkRow(); rr[4] = 'DH' + i; rr[7] = 1; rr[12] = '2026-08-10'; big.push(rr); }
  const bigSheet = { title: '原始数据1（工单备料明细）', rows: big, formulas: {}, formulaCount: 0, cols: 13, sR: 0, sC: 0 };
  setMonth('2026-08');
  state.preview = { sheets: [bigSheet], activeSheet: 0, page: 0 };
  state.previewQuery = '';
  Dbg.renderPreview();
  const sumPage0 = els['previewHSum'].textContent;
  state.preview.page = 1;
  Dbg.renderPreview();
  const sumPage1 = els['previewHSum'].textContent;
  check('3. H求和 翻页不变（55 行 × 1 = 55）', /未发数量合计：55/.test(sumPage0) && sumPage0 === sumPage1, sumPage0 + ' | ' + sumPage1);
  check('3. 翻页后筛选计数仍 = 共 58 行（含3表头）', els['previewFilterCount'].textContent === '共 58 行', els['previewFilterCount'].textContent);
})();

// =========================================================================
// 回归：parseBudget / parseAnalysis2/3 固定列 / mapMachineGroup / EMBEDDED 深度一致
// =========================================================================
console.log('\n========== 回归 ==========');
(function testRegression() {
  if (!Dbg) { check('回归. 前置 Dbg 可用', false); return; }

  // parseBudget：机台级聚合 + budgetQtyByVariety + 偶列工时 + #N/A 排除
  const ba = [];
  for (let i = 0; i < 8; i++) ba.push(new Array(16).fill(null));
  ba[3][11] = '34.2026'; ba[3][12] = '34.2026工时'; ba[3][13] = '35.2026'; ba[3][14] = '35.2026工时';
  ba[4][6] = '外壳A'; ba[4][7] = '400T-550T'; ba[4][11] = 100; ba[4][12] = 5; ba[4][13] = 200; ba[4][14] = 7;
  ba[5][6] = '#N/A'; ba[5][7] = '400T-550T'; ba[5][11] = 999; ba[5][12] = 1; ba[5][13] = 999; ba[5][14] = 1;
  ba[6][6] = '配件D'; ba[6][7] = ''; ba[6][11] = 50; ba[6][12] = 3; ba[6][13] = 60; ba[6][14] = 4;
  ba[7][6] = ''; ba[7][7] = '400T-550T'; ba[7][11] = 0; ba[7][12] = 2; ba[7][13] = 0; ba[7][14] = 2;
  const pb = Dbg.parseBudget(aoaToWs(ba));
  check('回归. parseBudget 机台级聚合 budget[400T-550T][2026WK34]=8（5+1+2）', !!pb && pb.budget['400T-550T'] && pb.budget['400T-550T']['2026WK34'] === 8, pb && JSON.stringify(pb.budget));
  check('回归. parseBudget budget[400T-550T][2026WK35]=10（7+1+2）', !!pb && pb.budget['400T-550T'] && pb.budget['400T-550T']['2026WK35'] === 10);
  check('回归. budgetQtyByVariety[外壳A]={34:100,35:200}', !!pb && deepEq(pb.budgetQtyByVariety['外壳A'], { '2026WK34': 100, '2026WK35': 200 }), pb && JSON.stringify(pb.budgetQtyByVariety));
  check('回归. budgetQtyByVariety[配件D]={34:50,35:60}（无机台仍计入品名级数量）', !!pb && deepEq(pb.budgetQtyByVariety['配件D'], { '2026WK34': 50, '2026WK35': 60 }));
  check('回归. #N/A 品名已排除（budgetQtyByVariety/budgetByVariety 无 #N/A 键）', !!pb && !('#N/A' in pb.budgetQtyByVariety) && !('#N/A' in pb.budgetByVariety));
  check('回归. budgetByVariety[外壳A]={34:5,35:7}（偶列=工时）', !!pb && deepEq(pb.budgetByVariety['外壳A'], { '2026WK34': 5, '2026WK35': 7 }));
  check('回归. budgetVarietyMachine[外壳A]=400T-550T', !!pb && pb.budgetVarietyMachine['外壳A'] === '400T-550T', pb && JSON.stringify(pb.budgetVarietyMachine));

  // parseAnalysis2 固定列
  const a2 = [];
  for (let i = 0; i < 6; i++) a2.push(new Array(51).fill(null));
  const r2 = new Array(51).fill(null);
  r2[1] = '2026WK34'; r2[2] = 111; r2[3] = 112; r2[4] = 113; r2[5] = 114;
  r2[13] = 121; r2[14] = 122; r2[15] = 123; r2[16] = 124;
  r2[23] = 131; r2[24] = 132; r2[25] = 133; r2[26] = 134;
  r2[32] = 141; r2[33] = 142; r2[34] = 143; r2[35] = 144;
  r2[46] = 151; r2[47] = 152; r2[48] = 153; r2[49] = 154;
  a2.push(r2);
  const p2 = Dbg.parseAnalysis2(aoaToWs(a2));
  check('回归. parseAnalysis2 5 组均解析', !!p2 && Object.keys(p2.groups).length === 5);
  check('回归. parseAnalysis2 400T-550T 固定列 real/cap6/cap7/budget', !!p2 && deepEq(p2.groups['400T-550T'], { real: [111], cap6: [112], cap7: [113], budget: [114] }), p2 && JSON.stringify(p2.groups['400T-550T']));
  check('回归. parseAnalysis2 150T-280T 固定列', !!p2 && deepEq(p2.groups['150T-280T'], { real: [151], cap6: [152], cap7: [153], budget: [154] }), p2 && JSON.stringify(p2.groups['150T-280T']));

  // parseAnalysis3 固定列（DATA_START=17）
  const a3 = [];
  for (let i = 0; i < 17; i++) a3.push(new Array(9).fill(null));
  const r3 = new Array(9).fill(null);
  r3[0] = '外壳X'; r3[1] = 100; r3[2] = 5000; r3[3] = 60; r3[4] = 40;
  r3[5] = '配件Y'; r3[6] = 50; r3[7] = 2000;
  a3.push(r3);
  const p3 = Dbg.parseAnalysis3(aoaToWs(a3));
  check('回归. parseAnalysis3 外壳固定列 A=品名/B=PCS/C=金额/D=实单/E=预算', !!p3 && deepEq(p3.shell[0], { name: '外壳X', pcs: 100, amount: 5000, realQty: 60, budgetQty: 40 }), p3 && JSON.stringify(p3.shell));
  check('回归. parseAnalysis3 配件固定列 F=品名/G=PCS/H=金额', !!p3 && deepEq(p3.acc[0], { name: '配件Y', pcs: 50, amount: 2000 }), p3 && JSON.stringify(p3.acc));

  // mapMachineGroup
  check('回归. mapMachineGroup(150T-280T)', Dbg.mapMachineGroup('150T-280T') === '150T-280T');
  check('回归. mapMachineGroup(400T/550T)', Dbg.mapMachineGroup('400T/550T') === '400T-550T');

  // EMBEDDED_ANALYSIS / EMBEDDED_GAP 深度一致（重新从数据脚本读取）
  try {
    const dataCtx = {};
    vm.createContext(dataCtx);
    vm.runInContext(dataScript + '\n;globalThis.__EMB = { ANALYSIS: EMBEDDED_ANALYSIS, GAP: EMBEDDED_GAP };', dataCtx, { filename: 'data.js' });
    const A = dataCtx.__EMB.ANALYSIS, G = dataCtx.__EMB.GAP;
    const analysisRef = JSON.parse(fs.readFileSync(ANALYSIS_JSON, 'utf8'));
    const gapRef = JSON.parse(fs.readFileSync(GAP_JSON, 'utf8'));
    check('回归. EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致', deepEq(A, analysisRef));
    check('回归. EMBEDDED_GAP 与 gap_material_data.json 深度一致', deepEq(G, gapRef));
  } catch (e) { check('回归. EMBEDDED 深度一致', false, e.message); }
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);
