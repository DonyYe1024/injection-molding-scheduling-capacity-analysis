'use strict';
/* =========================================================================
 * QA 校验脚本 09：《改善08-27版-2》5 项修改独立复验（真实执行）
 *  1. 改善1 标题：<h1>=惠州注塑部产能分析看板；.header h1 字号 24px
 *  2. 改善2 删除设置面板：无残留符号；各 section 默认显示
 *  3. 改善3 月历：parseMonthValue / renderCalendar / shiftCalendarMonth 全链路
 *  4. 改善4 仪表盘：computeGauge 数值 + renderGauge axisLine 颜色分段/detail 百分比
 *  5. 改善5 机台图横坐标起点：buildMachineOption 截断前导全 0 周
 *  6. 回归：computeDetailRows 金标准 300 行 J/K/L/W；parseBudget；buildMachine；
 *           parseDetail 未排期不进机台图；EMBEDDED_ANALYSIS 深度一致
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
const logicScript0 = scripts.find(s => /__injectionDebug/.test(s)) || '';
check('内联脚本段识别：数据段 + 逻辑段', !!dataScript && !!logicScript0);

// 注入额外导出（shiftCalendarMonth 等未在 __injectionDebug 暴露）
const EXTRA = '\n  globalThis.__QA_EXTRA = { shiftCalendarMonth: shiftCalendarMonth, getMonthInputValue: getMonthInputValue, setMonthInputValue: setMonthInputValue, getKpiValue: getKpiValue, buildHolidayMap: buildHolidayMap, renderCalendar: renderCalendar };\n';
let logicScript = logicScript0;
const iEnd = logicScript.lastIndexOf('})();');
if (iEnd < 0) { console.error('[FATAL] 未找到 IIFE 结尾'); process.exit(2); }
logicScript = logicScript.slice(0, iEnd) + EXTRA + logicScript.slice(iEnd);

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
let EMB_ANALYSIS = null;
try { EMB_ANALYSIS = extractConst(dataScript, 'EMBEDDED_ANALYSIS'); } catch (e) { check('抽取 EMBEDDED_ANALYSIS', false, e.message); }
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

// ---------- DOM 桩 ----------
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
  return {
    id: id, innerHTML: '', style: {}, className: '', textContent: '', value: '',
    classList: makeClassList(), addEventListener: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }, disabled: false,
    __echart: null, __echartOption: null
  };
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

// KPI 输入框（value 代理到 kpiStore，供 getKpiValue/getMonthInputValue 读取）
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
    readyState: 'loading', addEventListener: function () {},
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
const Q = sandbox.__QA_EXTRA;
if (!D) { console.error('[FATAL] 未捕获 __injectionDebug'); process.exit(2); }
check('执行环境. __injectionDebug 已暴露', !!D);
check('执行环境. __QA_EXTRA 已注入', !!Q && typeof Q.shiftCalendarMonth === 'function');
['computeDetailRows', 'parseDetail', 'parseBudget', 'buildMachine', 'buildMachineOption', 'parseMonthValue', 'renderCalendar', 'computeGauge', 'renderGauge'].forEach(f => {
  check('暴露函数 ' + f, typeof D[f] === 'function');
});

// =========================================================================
console.log('\n========== 改善1 标题 ==========');
(function testTitle() {
  check('1. <h1> 文字 = 惠州注塑部产能分析看板', html.indexOf('<h1>惠州注塑部产能分析看板</h1>') >= 0);
  const m = html.match(/\.header\s+h1\s*\{([^}]*)\}/);
  check('1. 存在 .header h1 规则', !!m);
  if (m) check('1. .header h1 font-size = 24px', /font-size\s*:\s*24px/.test(m[1]), m[1].trim());
  check('1. 无残留「惠州注塑厂」<h1>', html.indexOf('<h1>惠州注塑厂') < 0);
})();

// =========================================================================
console.log('\n========== 改善2 删除设置面板 ==========');
(function testRemoveSettings() {
  const forbidden = ['设置面板', 'applySettings', 'openSettings', 'closeSettings', 'setRadio', 'applyModuleVisibility', 'DEFAULT_MODULES', 'body.dark', 'body.font-'];
  forbidden.forEach(tok => {
    check('2. 无残留 "' + tok + '"', html.indexOf(tok) < 0);
  });
  // MODULES 大写常量（作为独立词；data-module 小写属性不属于设置面板残留）
  check('2. 无大写 MODULES 常量残留', /(^|[^a-zA-Z])MODULES([^a-zA-Z]|$)/.test(html) === false);
  // 各 section 默认显示：无 display:none 隐藏 section
  const sections = ['machine', 'moldVariety', 'preview'];
  let hidden = 0;
  sections.forEach(id => { if (html.indexOf('id="' + id + '"') >= 0 && /section[^>]*display\s*:\s*none/i.test(html)) hidden++; });
  check('2. 各 section 默认显示（无 display:none）', hidden === 0);
})();

// =========================================================================
console.log('\n========== 改善3 月历 ==========');
(function testCalendar() {
  const nowY = new Date().getFullYear();
  // parseMonthValue 各输入
  const t1 = D.parseMonthValue('2026-08');
  check('3. parseMonthValue("2026-08")', !!t1 && t1.y === 2026 && t1.m === 8, JSON.stringify(t1));
  const t2 = D.parseMonthValue('8月');
  check('3. parseMonthValue("8月") → 当前年8月', !!t2 && t2.y === nowY && t2.m === 8, JSON.stringify(t2));
  const t3 = D.parseMonthValue('8');
  check('3. parseMonthValue("8") → 当前年8月', !!t3 && t3.y === nowY && t3.m === 8, JSON.stringify(t3));
  const t4 = D.parseMonthValue('2026/8');
  check('3. parseMonthValue("2026/8")', !!t4 && t4.y === 2026 && t4.m === 8, JSON.stringify(t4));
  const t5 = D.parseMonthValue('2026年8月');
  check('3. parseMonthValue("2026年8月")', !!t5 && t5.y === 2026 && t5.m === 8, JSON.stringify(t5));
  check('3. parseMonthValue("") → null（由 renderCalendar 兜底为当前月）', D.parseMonthValue('') === null);
  check('3. parseMonthValue("2026-13") → null（非法月）', D.parseMonthValue('2026-13') === null);
  check('3. parseMonthValue("abc") → null', D.parseMonthValue('abc') === null);

  // buildHolidayMap 关键日期
  const hm = Q.buildHolidayMap();
  const expHolidays = ['2026-01-01', '2026-02-15', '2026-02-23', '2026-04-04', '2026-05-01', '2026-05-05', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-07'];
  let holidayOk = true;
  expHolidays.forEach(k => { if (!hm[k]) holidayOk = false; });
  check('3. 法定节假日关键日期均在表内', holidayOk);
  check('3. 2026-02-17 标为春节', hm['2026-02-17'] === '春节', String(hm['2026-02-17']));
  check('3. 非节假日日期不在表内', !hm['2026-02-10'] && !hm['2026-08-27']);

  // renderCalendar：2 月（含春节 02-17、调休上班 02-14）
  kpiStore.month = '2026-02';
  D.renderCalendar();
  const febHtml = getEl('metaCalendar').innerHTML;
  check('3. renderCalendar 渲染 2026-02 标题', febHtml.indexOf('2026年2月') >= 0, (febHtml.match(/cal-title">[^<]*</) || [''])[0]);
  check('3. 02-17（春节）标红 cal-holiday', /class="cal-cell cal-holiday"[^>]*>17</.test(febHtml) || /cal-holiday[^"]*"[^>]*>17</.test(febHtml));
  check('3. 02-14（调休上班）标「班」', /cal-work[^"]*"[^>]*>14<i class="cal-ban">班</.test(febHtml));

  // renderCalendar：8 月（08-30 周日）
  kpiStore.month = '2026-08';
  D.renderCalendar();
  const augHtml = getEl('metaCalendar').innerHTML;
  check('3. renderCalendar 渲染 2026-08 标题', augHtml.indexOf('2026年8月') >= 0);
  // 08-30 为周日 → cal-sun（且非节假日非调休，class 恰好 cal-cell cal-sun）
  check('3. 08-30（周日）周日色 cal-sun', /cal-sun[^"]*"[^>]*>30</.test(augHtml) || />30<\/div>/.test(augHtml) && /cal-sun/.test(augHtml));

  // shiftCalendarMonth 切月 + 回写输入框
  kpiStore.month = '2026-08';
  D.renderCalendar();
  Q.shiftCalendarMonth(1);
  check('3. shiftCalendarMonth(+1) 回写 2026-09', kpiStore.month === '2026-09', kpiStore.month);
  Q.shiftCalendarMonth(-1);
  check('3. shiftCalendarMonth(-1) 回到 2026-08', kpiStore.month === '2026-08', kpiStore.month);
  // 跨年：2026-01 → -1 → 2025-12
  kpiStore.month = '2026-01';
  D.renderCalendar();
  Q.shiftCalendarMonth(-1);
  check('3. shiftCalendarMonth 跨年 2026-01 -1 → 2025-12', kpiStore.month === '2025-12', kpiStore.month);
  // 跨年：2026-12 → +1 → 2027-01
  kpiStore.month = '2026-12';
  D.renderCalendar();
  Q.shiftCalendarMonth(1);
  check('3. shiftCalendarMonth 跨年 2026-12 +1 → 2027-01', kpiStore.month === '2027-01', kpiStore.month);

  // 空 → 当前月兜底
  kpiStore.month = '';
  D.renderCalendar();
  const curTitle = new Date().getFullYear() + '年' + (new Date().getMonth() + 1) + '月';
  check('3. 空输入兜底为当前月', getEl('metaCalendar').innerHTML.indexOf(curTitle) >= 0, curTitle);
})();

// =========================================================================
console.log('\n========== 改善4 仪表盘 ==========');
(function testGauge() {
  // 26 / 24.5 → max=42.9, pct≈57.1096%
  kpiStore.days = '26';
  kpiStore.shell = '24.5';
  const g = D.computeGauge();
  check('4. computeGauge max = 42.9', close(g.max, 42.9, 1e-9), String(g.max));
  check('4. computeGauge pct ≈ 57.11%', close(g.pct, 57.1095571, 1e-6), String(g.pct));
  check('4. pct 无 NaN/Infinity', isFinite(g.pct) && !isNaN(g.pct));

  // days=0 → pct=0
  kpiStore.days = '0';
  kpiStore.shell = '24.5';
  const g2 = D.computeGauge();
  check('4. days=0 → pct=0', g2.pct === 0 && g2.max === 0, 'pct=' + g2.pct + ' max=' + g2.max);

  // shell 空 → pct=0
  kpiStore.days = '26';
  kpiStore.shell = '';
  const g3 = D.computeGauge();
  check('4. shell 空 → pct=0', g3.pct === 0 && g3.shell === 0, 'pct=' + g3.pct + ' shell=' + g3.shell);

  // 全空 → 无 NaN
  kpiStore.days = '';
  kpiStore.shell = '';
  const g4 = D.computeGauge();
  check('4. 全空 → pct=0 无 NaN', g4.pct === 0 && isFinite(g4.max) && !isNaN(g4.max), 'pct=' + g4.pct + ' max=' + g4.max);

  // renderGauge 生成 option，校验 axisLine 颜色 + detail
  kpiStore.days = '26';
  kpiStore.shell = '24.5';
  D.renderGauge();
  const opt = getEl('metaGauge').__echartOption;
  check('4. renderGauge 生成 option', !!opt);
  if (opt) {
    const s = opt.series && opt.series[0];
    const colors = s && s.axisLine && s.axisLine.lineStyle && s.axisLine.lineStyle.color;
    check('4. axisLine 三段绿→黄→红', !!colors && colors.length === 3 && colors[0][0] === 0.5 && colors[0][1] === '#43a047' && colors[1][0] === 0.8 && colors[1][1] === '#fbc02d' && colors[2][0] === 1 && colors[2][1] === '#e53935', JSON.stringify(colors));
    check('4. detail 显示百分比', !!s && !!s.detail && typeof s.detail.formatter === 'function' && s.detail.formatter(57.1095) === '57.1%', s && s.detail && s.detail.formatter ? s.detail.formatter(57.1095) : '');
    check('4. gauge min=0 max=100', !!s && s.min === 0 && s.max === 100);
    check('4. data value = pct', !!s && Array.isArray(s.data) && close(s.data[0].value, g.pct, 1e-9), JSON.stringify(s && s.data));
  }
})();

// =========================================================================
console.log('\n========== 改善5 机台图横坐标起点 ==========');
(function testMachineStart() {
  const st = D.getState();
  st.machineWeekWindow = 38;
  st.machine = {
    weeks: ['2026WK30', '2026WK31', '2026WK32', '2026WK33', '2026WK34'],
    groups: {
      '400T-550T': {
        real: [0, 0, 100, 200, 300],
        budget: [0, 0, 50, 0, 0],
        cap6: [1320, 1320, 1320, 1320, 1320],
        cap7: [1452, 1452, 1452, 1452, 1452]
      }
    }
  };
  const opt = D.buildMachineOption('400T-550T');
  check('5. buildMachineOption 返回非空', !!opt);
  if (opt) {
    check('5. weeks 截断为 [WK32,WK33,WK34]', JSON.stringify(opt.xAxis.data) === JSON.stringify(['2026WK32', '2026WK33', '2026WK34']), JSON.stringify(opt.xAxis.data));
    check('5. 实单截断 [100,200,300]', JSON.stringify(opt.series[0].data) === JSON.stringify([100, 200, 300]), JSON.stringify(opt.series[0].data));
    check('5. 预算截断 [50,0,0]', JSON.stringify(opt.series[1].data) === JSON.stringify([50, 0, 0]), JSON.stringify(opt.series[1].data));
    check('5. 6天产能同步截断长度=3', Array.isArray(opt.series[2].data) && opt.series[2].data.length === 3, JSON.stringify(opt.series[2].data));
    check('5. 7天产能同步截断长度=3', Array.isArray(opt.series[3].data) && opt.series[3].data.length === 3, JSON.stringify(opt.series[3].data));
  }

  // 边界：首周即非零 → 不截断
  st.machine = {
    weeks: ['2026WK30', '2026WK31'],
    groups: { '400T-550T': { real: [5, 0], budget: [0, 0], cap6: [1320, 1320], cap7: [1452, 1452] } }
  };
  const opt2 = D.buildMachineOption('400T-550T');
  check('5. 首周非零不截断', opt2 && JSON.stringify(opt2.xAxis.data) === JSON.stringify(['2026WK30', '2026WK31']), opt2 && JSON.stringify(opt2.xAxis.data));

  // 边界：全 0 → 不截断（保持原样）
  st.machine = {
    weeks: ['2026WK30', '2026WK31'],
    groups: { '400T-550T': { real: [0, 0], budget: [0, 0], cap6: [1320, 1320], cap7: [1452, 1452] } }
  };
  const opt3 = D.buildMachineOption('400T-550T');
  check('5. 全 0 不截断（长度不变）', opt3 && opt3.xAxis.data.length === 2, opt3 && JSON.stringify(opt3.xAxis.data));
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
    check('回归1. K（累计）300/300 一致', kBad === 0, kBad + ' 行不一致');
    check('回归1. L（扣库存待生产）300/300 一致', lBad === 0, lBad + ' 行不一致');
    check('回归1. J（工时）300/300 一致(±0.005)', jBad === 0, jBad + ' 行不一致');
    check('回归1. W（原料KG）300/300 一致(±1e-6)', wBad === 0, wBad + ' 行不一致');
  }
})();

// =========================================================================
console.log('\n========== 回归 2：parseBudget ==========');
(function testParseBudget() {
  const aoa = [];
  for (let r = 0; r < 6; r++) aoa.push(new Array(20).fill(null));
  // 表头（索引3 = 第4行）：col11(L) 起 "34.2026"，偶数列(c%2===0)为工时列
  aoa[3][11] = '34.2026'; aoa[3][12] = '34.2026'; aoa[3][13] = '35.2026'; aoa[3][14] = '35.2026';
  // 数据行1：H列(col7) = 400T-550T；col11=qty(忽略) col12=工时10 col13=qty(忽略) col14=工时20
  aoa[4][7] = '400T-550T';
  aoa[4][11] = 100; aoa[4][12] = 10; aoa[4][13] = 200; aoa[4][14] = 20;
  // 数据行2：同组，工时 col12=5 col14=7
  aoa[5][7] = '400T-550T';
  aoa[5][11] = 999; aoa[5][12] = 5; aoa[5][13] = 999; aoa[5][14] = 7;
  // 数据行3：其他机台组 → 应被跳过
  aoa[5 + 1] = new Array(20).fill(null);
  const res = D.parseBudget(aoaToWs(aoa));
  check('回归2. parseBudget 返回非空', !!res && !!res.budget);
  if (res) {
    const b = res.budget['400T-550T'];
    check('回归2. 34.2026 → 2026WK34', !!b && b['2026WK34'] !== undefined, JSON.stringify(Object.keys(b || {})));
    check('回归2. 偶数列工时累加 WK34 = 15（10+5）', !!b && b['2026WK34'] === 15, 'WK34=' + (b && b['2026WK34']));
    check('回归2. WK35 = 27（20+7）', !!b && b['2026WK35'] === 27, 'WK35=' + (b && b['2026WK35']));
    check('回归2. 奇数列(数量)不计入', !!b && b['2026WK34'] === 15 && b['2026WK35'] === 27);
  }
})();

// =========================================================================
console.log('\n========== 回归 3：buildMachine 周轴不含内置旧周 ==========');
(function testBuildMachine() {
  const dm = { weeks: ['2026WK30', '2026WK31'], groups: { '400T-550T': { real: [10, 20] } } };
  const budget = { '400T-550T': { '2026WK32': 5 } };
  const res = D.buildMachine(dm, budget);
  check('回归3. 周轴 = 上传周（3 周，不含内置 38 周）', !!res && res.weeks.length === 3 && res.weeks.join(',') === '2026WK30,2026WK31,2026WK32', res && res.weeks.join(','));
  if (res) {
    check('回归3. real 对齐 = [10,20,0]', JSON.stringify(res.groups['400T-550T'].real) === JSON.stringify([10, 20, 0]), JSON.stringify(res.groups['400T-550T'].real));
    check('回归3. budget 对齐 = [0,0,5]', JSON.stringify(res.groups['400T-550T'].budget) === JSON.stringify([0, 0, 5]), JSON.stringify(res.groups['400T-550T'].budget));
  }
})();

// =========================================================================
console.log('\n========== 回归 4：parseDetail 未排期行不进机台图 ==========');
(function testParseDetail() {
  const aoa = [['h0'], ['h1'], ['h2']];
  const mk = (p) => {
    const row = new Array(23).fill(null);
    row[1] = 'ORD'; row[2] = '2090000283'; row[3] = '塑胶外壳类'; row[4] = '602227342/DH010XS/外壳/ABS/黑色/';
    row[7] = 0; row[8] = 0; row[9] = 100; row[11] = 10;
    row[15] = p; row[16] = '400T-550T'; row[17] = '1*1'; row[18] = 65; row[19] = 186; row[22] = 0;
    return row;
  };
  aoa.push(mk('2026WK30'));  // 已排期
  aoa.push(mk('未排期'));     // 未排期
  const pd = D.parseDetail(aoaToWs(aoa));
  check('回归4. parseDetail 返回', !!pd);
  if (pd) {
    check('回归4. 机台周轴仅含已排期周 [2026WK30]', JSON.stringify(pd.machine.weeks) === JSON.stringify(['2026WK30']), JSON.stringify(pd.machine.weeks));
    const g = pd.machine.groups['400T-550T'];
    check('回归4. 未排期行工时未进入机台图（real=[100]）', !!g && JSON.stringify(g.real) === JSON.stringify([100]), g && JSON.stringify(g.real));
  }
})();

// =========================================================================
console.log('\n========== 回归 5：EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致 ==========');
(function testEmbedded() {
  if (EMB_ANALYSIS) {
    check('回归5. 深度一致', JSON.stringify(canonical(EMB_ANALYSIS)) === JSON.stringify(canonical(analysisRef)));
    check('回归5. machine.weeks 长度 = 38', EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.weeks.length === 38, String(EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.weeks.length));
    const gKeys = EMB_ANALYSIS.machine && Object.keys(EMB_ANALYSIS.machine.groups) || [];
    check('回归5. machine.groups 5 键', gKeys.length === 5, JSON.stringify(gKeys));
  }
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);
