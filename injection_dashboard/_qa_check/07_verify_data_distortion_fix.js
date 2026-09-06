'use strict';
/* =========================================================================
 * QA 校验脚本 07：数据失真修复 +《改善08-27版-1》独立复验（真实执行，全新视角）
 *
 *  一、数据失真修复（重点）
 *    A. parseBudget 重写：周号解析(34.2026/34.2026需求)、机台读 H 列非 A 列、
 *       机台分组映射、只累加偶数列(工时)不混入数量列
 *    B. buildMachine 周轴：上传周不混入内置旧周；cap6/cap7 内置固定；空数据兜底
 *  二、改善清单
 *    改善1 KPI 右对齐  改善2 删热力图  改善3 模具产能图  改善4 机台图  改善6 metaLine日期
 *  三、回归
 *    computeDetailRows 300 行 J/K/L/W；EMBEDDED_ANALYSIS 深度一致；
 *    parseAnalysis2/3 固定列；mapMachineGroup('150T-280T')
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
const failures = [];   // {name, severity}
const p0 = [], p1 = [];
function check(name, cond, detail, severity) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? '  — ' + detail : '')); }
  else {
    failed++; failures.push(name);
    const sev = severity || 'P1';
    if (sev === 'P0') p0.push(name); else p1.push(name);
    console.log('[FAIL] ' + name + (detail ? '  — ' + detail : ''));
  }
}
function num(v) { if (v === null || v === undefined || v === '') return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function close(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }
function colIdxToLetter(c) { let s = ''; c = c + 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
function letterToColIdx(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

// ---------- 2D 稠密数组 → SheetJS 风格 worksheet 桩 ----------
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
let EMB_ANALYSIS = null;
try { EMB_ANALYSIS = extractConst(dataScript, 'EMBEDDED_ANALYSIS'); } catch (e) { check('抽取 EMBEDDED_ANALYSIS', false, e.message, 'P0'); }
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

// ---------- 注入测试钩子（仅暴露内部函数供复验，不改逻辑） ----------
const logicScriptInjected = logicScript.replace(/\}\)\(\);\s*$/, function () {
  return '\n  window.__injectionDebug.renderMachineTabs = renderMachineTabs;\n' +
         '  window.__injectionDebug.renderAll = renderAll;\n' +
         '  window.__injectionDebug.handleFile = handleFile;\n' +
         '  window.__injectionDebug.MACHINE_GROUP_DESC = MACHINE_GROUP_DESC;\n})();';
});
check('测试钩子注入成功（renderMachineTabs/renderAll/handleFile）', logicScriptInjected !== logicScript && /handleFile = handleFile/.test(logicScriptInjected));

// ---------- vm 桩环境 ----------
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
// handleFile 测试用：read 返回空工作簿（无任何已识别表 → 无 detailDate）
const xlsxStub = { utils: xlsxUtils, read: function () { return { SheetNames: [], Sheets: {} }; } };

function FileReaderStub() {}
FileReaderStub.prototype.readAsArrayBuffer = function (file) {
  const self = this;
  if (self.onload) self.onload({ target: { result: new Uint8Array([1, 2, 3]).buffer } });
};

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
    setAttribute: function () {}, getAttribute: function () { return null; }, disabled: false
  };
}
const echartsStub = {
  getInstanceByDom: function () { return null; },
  init: function (el) { return { setOption: function () {}, clear: function () {}, resize: function () {} }; }
};
const els = {};
function getEl(id) { if (els[id] === undefined) els[id] = makeEl(id); return els[id]; }
const localStorageStore = {};
const sandbox = {
  window: { echarts: echartsStub, XLSX: xlsxStub, addEventListener: function () {} },
  document: {
    readyState: 'loading', addEventListener: function () {},
    getElementById: function (id) { return getEl(id); },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    body: getEl('body')
  },
  FileReader: FileReaderStub,
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null; },
    setItem: function (k, v) { localStorageStore[k] = String(v); }
  },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  console: console
};
vm.createContext(sandbox);
try {
  vm.runInContext(dataScript + '\n;\n' + logicScriptInjected, sandbox, { filename: 'logic.js' });
  console.log('[INFO] 逻辑脚本执行成功');
} catch (e) {
  console.error('[FATAL] 逻辑脚本执行失败：', e.message, '\n', e.stack);
  process.exit(2);
}
const D = sandbox.window && sandbox.window.__injectionDebug;
if (!D) { console.error('[FATAL] 未捕获 __injectionDebug'); process.exit(2); }
check('执行环境. __injectionDebug 已暴露', !!D);
['parseBudget', 'buildMachine', 'buildMachineOption', 'buildVarietyOption', 'renderMeta', 'getState',
 'computeDetailRows', 'parseAnalysis2', 'parseAnalysis3', 'mapMachineGroup', 'renderMachineTabs', 'handleFile'].forEach(f => {
  check('暴露函数 ' + f, typeof D[f] === 'function');
});
const STATE = D.getState();

// =========================================================================
console.log('\n========== 一、A. parseBudget 重写（数据失真修复·重点） ==========');
(function testParseBudget() {
  // 构造真实预算表（原始数据3）格式：
  //   表头第4行(aoa 3)；A列(0)=料号；H列(1-based 8, 0-based 7)=机台；
  //   L列(1-based 12, 0-based 11)起两列一组：34.2026(数量)/34.2026需求(工时)/35.2026/35.2026需求
  const aoa = [];
  for (let r = 0; r < 9; r++) aoa.push(new Array(15).fill(null));
  // 表头行（aoa index 3）
  aoa[3][0] = '料号'; aoa[3][7] = '机台';
  aoa[3][11] = '34.2026'; aoa[3][12] = '34.2026需求';
  aoa[3][13] = '35.2026'; aoa[3][14] = '35.2026需求';
  // 数据行：A列故意放会误导分组的文本，机台只应读 H 列
  aoa[4][0] = '5010000003'; aoa[4][7] = '400T-550T';
  aoa[4][11] = 100; aoa[4][12] = 5.5; aoa[4][13] = 200; aoa[4][14] = 7.5;
  aoa[5][0] = '5010000004'; aoa[5][7] = '90T';
  aoa[5][11] = 300; aoa[5][12] = 10.5; aoa[5][13] = 400; aoa[5][14] = 12.5;
  // A列放"150T"文字，H列真实=230T-260T → 应归入 230T-280T，而非 150T（验证读 H 不读 A）
  aoa[6][0] = '150T'; aoa[6][7] = '230T-260T';
  aoa[6][11] = 50; aoa[6][12] = 3.5; aoa[6][13] = 60; aoa[6][14] = 4.5;
  aoa[7][0] = '5010000005'; aoa[7][7] = '150T';
  aoa[7][11] = 70; aoa[7][12] = 6.5; aoa[7][13] = 80; aoa[7][14] = 8.5;
  aoa[8][0] = '5010000006'; aoa[8][7] = '260T';
  aoa[8][11] = 90; aoa[8][12] = 1.5; aoa[8][13] = 100; aoa[8][14] = 2.5;

  const res = D.parseBudget(aoaToWs(aoa));
  check('A1. parseBudget 返回非空', !!res && !!res.budget);
  const budget = (res && res.budget) || {};

  // 周号解析
  check('A2. 解析出 2026WK34 与 2026WK35 两周',
    !!budget['400T-550T'] && !!budget['400T-550T']['2026WK34'] && !!budget['400T-550T']['2026WK35'],
    JSON.stringify(Object.keys(budget['400T-550T'] || {})));

  // 机台分组读 H 列：400T-550T 精确
  check('A3. 400T-550T.WK34=5.5（工时，非数量）', close(budget['400T-550T'] && budget['400T-550T']['2026WK34'], 5.5),
    String(budget['400T-550T'] && budget['400T-550T']['2026WK34']));
  check('A4. 400T-550T.WK35=7.5', close(budget['400T-550T'] && budget['400T-550T']['2026WK35'], 7.5),
    String(budget['400T-550T'] && budget['400T-550T']['2026WK35']));

  // 90T
  check('A5. 90T.WK34=10.5 / WK35=12.5', close(budget['90T'] && budget['90T']['2026WK34'], 10.5) && close(budget['90T'] && budget['90T']['2026WK35'], 12.5),
    JSON.stringify(budget['90T']));

  // 230T-260T 与 260T 都应归入 230T-280T，且累加（3.5+1.5=5.0, 4.5+2.5=7.0）
  check('A6. 230T-260T/260T → 230T-280T 且累加 WK34=5.0', close(budget['230T-280T'] && budget['230T-280T']['2026WK34'], 5.0),
    JSON.stringify(budget['230T-280T']));
  check('A7. 230T-280T.WK35=7.0', close(budget['230T-280T'] && budget['230T-280T']['2026WK35'], 7.0),
    String(budget['230T-280T'] && budget['230T-280T']['2026WK35']));

  // 150T 单独成组，未被 A 列的"150T"文字污染
  check('A8. 150T.WK34=6.5 / WK35=8.5', close(budget['150T'] && budget['150T']['2026WK34'], 6.5) && close(budget['150T'] && budget['150T']['2026WK35'], 8.5),
    JSON.stringify(budget['150T']));
  check('A9. 无“其他”组', !budget['其他'], JSON.stringify(Object.keys(budget)));

  // 数量列不得混入工时（100/200/300/400/50/60/70/80/90/100 都不应出现为工时值）
  let noQtyMix = true;
  const qtyVals = [100, 200, 300, 400, 50, 60, 70, 80, 90];
  Object.keys(budget).forEach(g => {
    Object.keys(budget[g]).forEach(w => {
      if (qtyVals.indexOf(budget[g][w]) >= 0) noQtyMix = false;
    });
  });
  check('A10. 数量列值未混入工时', noQtyMix, JSON.stringify(budget));

  // mapMachineGroup 覆盖（作为 parseBudget 分组的底层依据）
  check('A11. mapMachineGroup("230T-260T")=230T-280T', D.mapMachineGroup('230T-260T') === '230T-280T');
  check('A12. mapMachineGroup("260T")=230T-280T', D.mapMachineGroup('260T') === '230T-280T');
  check('A13. mapMachineGroup("400T-550T")=400T-550T', D.mapMachineGroup('400T-550T') === '400T-550T');
  check('A14. mapMachineGroup("150T")=150T', D.mapMachineGroup('150T') === '150T');
  check('A15. mapMachineGroup("90T")=90T', D.mapMachineGroup('90T') === '90T');
})();

// =========================================================================
console.log('\n========== 一、B. buildMachine 周轴（数据失真修复） ==========');
(function testBuildMachine() {
  const detailMachine = {
    weeks: ['2026WK34', '2026WK35'],
    groups: {
      '400T-550T': { real: [10, 20] },
      '230T-280T': { real: [30, 40] },
      '150T': { real: [50, 60] },
      '90T': { real: [70, 80] },
      '150T-280T': { real: [90, 100] }
    }
  };
  const budget = { '400T-550T': { '2026WK34': 5, '2026WK35': 6 } };
  const out = D.buildMachine(detailMachine, budget);
  check('B1. buildMachine 返回非空', !!out && !!out.weeks && !!out.groups);
  if (out) {
    check('B2. weeks 仅上传两周 [2026WK34,2026WK35]', JSON.stringify(out.weeks) === JSON.stringify(['2026WK34', '2026WK35']),
      JSON.stringify(out.weeks));
    check('B3. weeks 不含内置旧周 2026WK32', out.weeks.indexOf('2026WK32') < 0);
    check('B4. weeks 不含内置旧周 2027WK16', out.weeks.indexOf('2027WK16') < 0);
    const g = out.groups['400T-550T'];
    check('B5. 400T-550T.real=[10,20] 对齐', g && JSON.stringify(g.real) === JSON.stringify([10, 20]), JSON.stringify(g && g.real));
    check('B6. 400T-550T.cap6=[1320,1320]（内置固定）', g && JSON.stringify(g.cap6) === JSON.stringify([1320, 1320]), JSON.stringify(g && g.cap6));
    check('B7. 400T-550T.cap7=[1452,1452]（内置固定）', g && JSON.stringify(g.cap7) === JSON.stringify([1452, 1452]), JSON.stringify(g && g.cap7));
    check('B8. 400T-550T.budget=[5,6] 对齐', g && JSON.stringify(g.budget) === JSON.stringify([5, 6]), JSON.stringify(g && g.budget));
    check('B9. 90T.real=[70,80] 对齐', out.groups['90T'] && JSON.stringify(out.groups['90T'].real) === JSON.stringify([70, 80]),
      JSON.stringify(out.groups['90T'] && out.groups['90T'].real));
  }

  // 空上传数据 → 回退内置 weeks（38 周），不崩溃
  let out2 = null, err2 = null;
  try { out2 = D.buildMachine(null, {}); } catch (e) { err2 = e.message; }
  check('B10. 空上传不崩溃', !err2, err2);
  check('B11. 空上传回退内置 38 周', out2 && out2.weeks && out2.weeks.length === 38, String(out2 && out2.weeks && out2.weeks.length));
  check('B12. 空上传起点=2026WK32 / 终点=2027WK16',
    out2 && out2.weeks && out2.weeks[0] === '2026WK32' && out2.weeks[37] === '2027WK16',
    JSON.stringify(out2 && out2.weeks && [out2.weeks[0], out2.weeks[37]]));
  check('B13. 空上传 400T-550T.cap6[0]=1320（内置）', out2 && out2.groups['400T-550T'] && out2.groups['400T-550T'].cap6[0] === 1320);
})();

// =========================================================================
console.log('\n========== 二、改善1：KPI 右对齐 ==========');
(function testImprove1() {
  function ruleHas(selector, prop) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc + '\\s*\\{([^}]*)\\}');
    const m = html.match(re);
    return m ? new RegExp(prop).test(m[1]) : false;
  }
  check('改善1a. .kpi-card .label 含 text-align:right', ruleHas('.kpi-card .label', 'text-align\\s*:\\s*right'));
  check('改善1b. .kpi-input 含 text-align:right', ruleHas('.kpi-input', 'text-align\\s*:\\s*right'));
})();

// =========================================================================
console.log('\n========== 二、改善2：删热力图 ==========');
(function testImprove2() {
  const terms = ['moldHeat', 'moldHeatChart', 'buildMoldHeatOption', 'topMolds', 'renderMoldHeat', '热力图'];
  let allGone = true;
  terms.forEach(t => { if (html.indexOf(t) >= 0) allGone = false; });
  check('改善2a. 全文无热力图相关标识残留', allGone, terms.filter(t => html.indexOf(t) >= 0).join(',') || '无残留');
  check('改善2b. 逻辑段无 renderMoldHeat 调用', logicScript.indexOf('renderMoldHeat') < 0);
  const ra = logicScript.slice(logicScript.indexOf('function renderAll'), logicScript.indexOf('function renderAll') + 400);
  check('改善2c. renderAll 体内无 renderMoldHeat 调用', ra.indexOf('renderMoldHeat') < 0, ra.trim().split('\n')[0]);
})();

// =========================================================================
console.log('\n========== 二、改善3：模具产能图 ==========');
(function testImprove3() {
  // section 下移 margin-top
  const mvIdx = html.indexOf('data-module="moldVariety"');
  check('改善3a. moldVariety section 存在', mvIdx >= 0);
  const seg = mvIdx >= 0 ? html.slice(mvIdx, mvIdx + 200) : '';
  check('改善3b. section 含 margin-top: 26px 下移', /margin-top\s*:\s*26px/.test(seg), seg.match(/margin-top[^;\"]*/) && seg.match(/margin-top[^;\"]*/)[0]);

  // 横坐标左起点=第一个非零周
  STATE.varietyData = {
    varieties: ['外壳A'],
    weeks: ['2026WK32', '2026WK33', '2026WK34', '2026WK35'],
    data: { '外壳A': { '2026WK32': 0, '2026WK33': 0, '2026WK34': 10, '2026WK35': 20 } }
  };
  STATE.activeVariety = '外壳A';
  const opt = D.buildVarietyOption('外壳A', 1, 132);
  check('改善3c. buildVarietyOption 返回非空', !!opt && !!opt.xAxis);
  if (opt && opt.xAxis) {
    check('改善3d. 横坐标起点=第一个非零周 [2026WK34,2026WK35]', JSON.stringify(opt.xAxis.data) === JSON.stringify(['2026WK34', '2026WK35']),
      JSON.stringify(opt.xAxis.data));
    check('改善3e. xAxis 字体 11+bold', opt.xAxis.axisLabel && opt.xAxis.axisLabel.fontSize === 11 && opt.xAxis.axisLabel.fontWeight === 'bold',
      JSON.stringify(opt.xAxis.axisLabel));
  }

  // 全零开头的兜底：第一个就是非零 → 起点=首周
  STATE.varietyData = {
    varieties: ['外壳A'],
    weeks: ['2026WK34', '2026WK35'],
    data: { '外壳A': { '2026WK34': 5, '2026WK35': 0 } }
  };
  const opt2 = D.buildVarietyOption('外壳A', 1, 132);
  check('改善3f. 首周即非零时起点=首周', opt2 && JSON.stringify(opt2.xAxis.data) === JSON.stringify(['2026WK34', '2026WK35']),
    JSON.stringify(opt2 && opt2.xAxis && opt2.xAxis.data));
})();

// =========================================================================
console.log('\n========== 二、改善4：机台图 ==========');
(function testImprove4() {
  const opt = D.buildMachineOption('400T-550T');
  check('改善4a. buildMachineOption 返回非空', !!opt && !!opt.xAxis && !!opt.series);
  if (opt && opt.xAxis) {
    check('改善4b. xAxis 字体 11+bold', opt.xAxis.axisLabel && opt.xAxis.axisLabel.fontSize === 11 && opt.xAxis.axisLabel.fontWeight === 'bold',
      JSON.stringify(opt.xAxis.axisLabel));
  }
  if (opt && opt.series) {
    check('改善4c. 4 个 series', opt.series.length === 4, '实际 ' + opt.series.length);
    const names = opt.series.map(s => s.name);
    check('改善4d. series 顺序=实单/预算/6天/7天',
      JSON.stringify(names) === JSON.stringify(['实单工时', '预算工时', '6天产能', '7天产能']), JSON.stringify(names));
    let allLabel = opt.series.every(s => s.label && s.label.show === true);
    check('改善4e. 4 个 series 都有 label(show=true)', allLabel, opt.series.map(s => s.name + ':' + !!(s.label && s.label.show)).join(','));
    check('改善4f. 6天线 label=top', opt.series[2].label && opt.series[2].label.position === 'top');
    check('改善4g. 7天线 label=top', opt.series[3].label && opt.series[3].label.position === 'top');
    check('改善4h. 实单/预算 bar label=inside', opt.series[0].label.position === 'inside' && opt.series[1].label.position === 'inside');
  }

  // MACHINE_GROUP_DESC 常量 + renderMachineTabs 更新 #machineDesc
  check('改善4i. MACHINE_GROUP_DESC 常量存在且 5 键', !!D.MACHINE_GROUP_DESC && Object.keys(D.MACHINE_GROUP_DESC).length === 5,
    JSON.stringify(D.MACHINE_GROUP_DESC && Object.keys(D.MACHINE_GROUP_DESC)));
  const expectedSub = {
    '400T-550T': ['DH010', 'K-27'],
    '230T-280T': ['帽沿', '调整器底座'],
    '150T': ['穿带扣'],
    '90T': ['滑行器', '塑胶铆钉垫片'],
    '150T-280T': ['堆叠柱', '折线']
  };
  if (D.MACHINE_GROUP_DESC) {
    let descOk = true, bad = '';
    Object.keys(expectedSub).forEach(g => {
      const txt = D.MACHINE_GROUP_DESC[g] || '';
      expectedSub[g].forEach(sub => { if (txt.indexOf(sub) < 0) { descOk = false; bad = g + ' 缺「' + sub + '」'; } });
    });
    check('改善4j. 5 组描述文案正确（含关键型号/品类）', descOk, bad || '全部命中');
  }

  // renderMachineTabs 按 activeGroup 更新 #machineDesc（真实执行 DOM 更新）
  let tabsOk = true, tabsBad = '';
  Object.keys(D.MACHINE_GROUP_DESC || {}).forEach(g => {
    STATE.activeGroup = g;
    D.renderMachineTabs();
    const txt = els['machineDesc'] ? els['machineDesc'].textContent : '';
    if (txt !== D.MACHINE_GROUP_DESC[g]) { tabsOk = false; tabsBad = g + ' 期望' + JSON.stringify(D.MACHINE_GROUP_DESC[g]) + ' 实得' + JSON.stringify(txt); }
  });
  check('改善4k. renderMachineTabs 按 activeGroup 正确更新 #machineDesc', tabsOk, tabsBad || '5 组全部一致');
})();

// =========================================================================
console.log('\n========== 二、改善6：metaLine 日期回退 ==========');
(function testImprove6() {
  // renderMeta 读取最新 state.detailDate
  STATE.detailDate = '2026-08-26';
  D.renderMeta();
  check('改善6a. renderMeta 输出含更新日期', els['metaLine'].innerHTML.indexOf('更新：2026-08-26') >= 0, els['metaLine'].innerHTML);
  STATE.detailDate = '2026-09-01';
  D.renderMeta();
  check('改善6b. renderMeta 读取最新 detailDate（重渲染后变化）', els['metaLine'].innerHTML.indexOf('更新：2026-09-01') >= 0, els['metaLine'].innerHTML);

  // handleFile 回退：detailDate 为空 → lastModified → 今天（真实执行）
  function toDateStrLocal(d) {
    const pad = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  const ts = new Date(2026, 7, 26).getTime(); // 2026-08-26
  STATE.detailDate = ''; // 清空
  D.handleFile({ name: 'x.xlsx', lastModified: ts });
  check('改善6c. handleFile 空 detailDate 回退 lastModified=2026-08-26', STATE.detailDate === '2026-08-26', String(STATE.detailDate));

  STATE.detailDate = '';
  D.handleFile({ name: 'x.xlsx', lastModified: 0 }); // 无 lastModified → 回退今天
  const today = toDateStrLocal(new Date());
  check('改善6d. handleFile 无 lastModified 回退今天=' + today, STATE.detailDate === today, String(STATE.detailDate));

  // 源码级确认回退顺序（lastModified 优先于今天）
  const hf = logicScript.slice(logicScript.indexOf('function handleFile'), logicScript.indexOf('function restoreEmbedded'));
  const lmIdx = hf.indexOf('file.lastModified'), todayIdx = hf.indexOf('toDateStr(new Date())');
  check('改善6e. 源码回退顺序 lastModified 先于今天', lmIdx >= 0 && todayIdx >= 0 && lmIdx < todayIdx, 'lastModified@' + lmIdx + ' today@' + todayIdx);
})();

// =========================================================================
console.log('\n========== 三、回归（不能破坏） ==========');
(function testRegression() {
  // R1. EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致
  check('R1. EMBEDDED_ANALYSIS 深度一致', JSON.stringify(canonical(EMB_ANALYSIS)) === JSON.stringify(canonical(analysisRef)), '', 'P0');

  // R2. mapMachineGroup('150T-280T') 仍正常
  check('R2. mapMachineGroup("150T-280T")=150T-280T', D.mapMachineGroup('150T-280T') === '150T-280T', D.mapMachineGroup('150T-280T'));

  // R3. parseAnalysis2 固定列解析（精简复验）
  (function () {
    const aoa = [];
    for (let r = 0; r < 6; r++) aoa.push(new Array(50).fill(null));
    aoa[3][1] = '2026WK31'; // 第4行标题干扰，应被跳过
    aoa[4][1] = '2026WK32'; aoa[4][2] = 111; aoa[4][3] = 112; aoa[4][4] = 113; aoa[4][5] = 114;
    aoa[5][1] = '2026WK33'; aoa[5][2] = 211; aoa[5][3] = 212; aoa[5][4] = 213; aoa[5][5] = 214;
    const r2 = D.parseAnalysis2(aoaToWs(aoa));
    check('R3. parseAnalysis2 返回非空', !!r2 && !!r2.weeks);
    if (r2) {
      check('R3. parseAnalysis2 过滤标题行仅 2 周', r2.weeks.length === 2 && r2.weeks[0] === '2026WK32' && r2.weeks[1] === '2026WK33', JSON.stringify(r2.weeks));
      check('R3. parseAnalysis2 固定列值(400T-550T.real)', JSON.stringify(r2.groups['400T-550T'].real) === JSON.stringify([111, 211]),
        JSON.stringify(r2.groups['400T-550T'].real));
      check('R3. parseAnalysis2 组键集合(5组)', JSON.stringify(Object.keys(r2.groups).sort()) === JSON.stringify(['150T', '150T-280T', '230T-280T', '400T-550T', '90T']),
        JSON.stringify(Object.keys(r2.groups).sort()));
    }
  })();

  // R4. parseAnalysis3 固定列解析（精简复验）
  (function () {
    const aoa = [];
    for (let r = 0; r < 19; r++) aoa.push(new Array(8).fill(null));
    aoa[15][0] = '品名'; aoa[15][1] = 'PCS'; // 第16行表头
    aoa[16][0] = '外壳P1'; aoa[16][1] = 100; aoa[16][5] = '配件A1'; aoa[16][6] = 500;
    aoa[17][0] = '外壳P2'; aoa[17][1] = 200; aoa[17][5] = '配件A2'; aoa[17][6] = 600;
    const r3 = D.parseAnalysis3(aoaToWs(aoa));
    check('R4. parseAnalysis3 返回非空', !!r3 && !!r3.shell && !!r3.acc);
    if (r3) {
      check('R4. parseAnalysis3 外壳/配件各 2 条', r3.shell.length === 2 && r3.acc.length === 2, JSON.stringify([r3.shell.length, r3.acc.length]));
      check('R4. parseAnalysis3 外壳首行字段', r3.shell[0].name === '外壳P1' && r3.shell[0].pcs === 100, JSON.stringify(r3.shell[0]));
      check('R4. parseAnalysis3 配件首行字段(F-H)', r3.acc[0].name === '配件A1' && r3.acc[0].pcs === 500, JSON.stringify(r3.acc[0]));
    }
  })();

  // R5. computeDetailRows 300 行金标准 J/K/L/W
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
  try { result = D.computeDetailRows(aoa); } catch (e) { check('R5. computeDetailRows 正常返回', false, e.message, 'P0'); }
  check('R5. computeDetailRows 正常返回', !!result && Array.isArray(result.rows), '', 'P0');
  if (result && result.rows) {
    check('R5. 输出行数=300', result.rows.length === 300, '实际 ' + result.rows.length, 'P0');
    const out = result.rows;
    let jBad = 0, kBad = 0, lBad = 0, wBad = 0, qBad = 0, rBad = 0, sBad = 0, tBad = 0;
    for (let i = 0; i < out.length; i++) {
      const o = out[i], td = testdata[i];
      if (o.K !== td.K) kBad++;
      if (o.L !== td.L) lBad++;
      if (Math.round((o.J || 0) * 100) !== Math.round((td.J || 0) * 100)) jBad++;
      if (Math.abs((o.W || 0) - (td.W || 0)) > 1e-6) wBad++;
      const qGot = o.Q == null ? '' : String(o.Q).trim(), qExp = td.Q == null ? '' : String(td.Q).trim();
      const rGot = o.R == null ? '' : String(o.R).trim(), rExp = td.R == null ? '' : String(td.R).trim();
      if (qGot !== qExp) qBad++;
      if (rGot !== rExp) rBad++;
      if (!close(o.S, td.S)) sBad++;
      if (!close(o.T, td.T)) tBad++;
    }
    check('R5. K 300/300 一致', kBad === 0, kBad + ' 行不一致', 'P0');
    check('R5. L 300/300 一致', lBad === 0, lBad + ' 行不一致', 'P0');
    check('R5. J 300/300 一致(±0.005)', jBad === 0, jBad + ' 行不一致', 'P0');
    check('R5. W 300/300 一致(±1e-6)', wBad === 0, wBad + ' 行不一致', 'P0');
    check('R5.(附加) Q 300/300 一致', qBad === 0, qBad + ' 行不一致');
    check('R5.(附加) R 300/300 一致', rBad === 0, rBad + ' 行不一致');
    check('R5.(附加) S 300/300 一致', sBad === 0, sBad + ' 行不一致');
    check('R5.(附加) T 300/300 一致', tBad === 0, tBad + ' 行不一致');
  }
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) {
  console.log('P0 失败：' + (p0.length ? '\n  - ' + p0.join('\n  - ') : '无'));
  console.log('P1 失败：' + (p1.length ? '\n  - ' + p1.join('\n  - ') : '无'));
  process.exit(1);
} else {
  console.log('全部通过。');
}
