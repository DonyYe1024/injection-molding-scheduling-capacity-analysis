'use strict';
/* =========================================================================
 * QA 校验脚本 04：《改善08-25版》重构独立复验
 * 真实执行（vm + 桩环境）逐项验证改善1~5 + 金标准回归 + 数据内嵌一致性
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
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? '  — ' + detail : '')); }
  else { failed++; console.log('[FAIL] ' + name + (detail ? '  — ' + detail : '')); }
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }
function num(v) { if (v === null || v === undefined || v === '') return 0; const n = Number(v); return isNaN(n) ? 0 : n; }

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
let logicScript = scripts.find(s => /__injectionDebug/.test(s)) || '';
check('内联脚本段识别：数据段 + 逻辑段', !!dataScript && !!logicScript,
  '数据段 ' + (dataScript ? dataScript.length : 0) + ' 字符，逻辑段 ' + (logicScript ? logicScript.length : 0) + ' 字符');

// 从数据段抽取三个常量
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
let EMB = null, EMB_MAP = null, EMB_ANALYSIS = null;
try { EMB = extractConst(dataScript, 'EMBEDDED_DATA'); } catch (e) { check('抽取 EMBEDDED_DATA', false, e.message); }
try { EMB_MAP = extractConst(dataScript, 'EMBEDDED_MAPPINGS'); } catch (e) { check('抽取 EMBEDDED_MAPPINGS', false, e.message); }
try { EMB_ANALYSIS = extractConst(dataScript, 'EMBEDDED_ANALYSIS'); } catch (e) { check('抽取 EMBEDDED_ANALYSIS', false, e.message); }
check('三个内嵌常量均可抽取', !!EMB && !!EMB_MAP && !!EMB_ANALYSIS);

function canonical(obj) {
  if (Array.isArray(obj)) return obj.map(canonical);
  if (obj && typeof obj === 'object') {
    const out = {};
    Object.keys(obj).sort().forEach(k => { out[k] = canonical(obj[k]); });
    return out;
  }
  return obj;
}

// =========================================================================
console.log('\n========== 数据内嵌一致性（EMBEDDED_ANALYSIS vs analysis_data.json） ==========');
if (EMB_ANALYSIS) {
  check('EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致', JSON.stringify(canonical(EMB_ANALYSIS)) === JSON.stringify(canonical(analysisRef)));
  check('machine.weeks 长度 = 38', EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.weeks.length === 38, String(EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.weeks.length));
  const gKeys = EMB_ANALYSIS.machine && Object.keys(EMB_ANALYSIS.machine.groups) || [];
  check('machine.groups 5 键', gKeys.length === 5, JSON.stringify(gKeys));
  const expGroups = ['400T-550T', '230T-280T', '150T', '90T', '150T-280T'];
  check('machine.groups 键集合正确', expGroups.every(k => gKeys.includes(k)));
  check('top10.shell/acc 存在', !!(EMB_ANALYSIS.top10 && Array.isArray(EMB_ANALYSIS.top10.shell) && Array.isArray(EMB_ANALYSIS.top10.acc)));
  check('detailDate = 2026-08-10', EMB_ANALYSIS.detailDate === '2026-08-10', String(EMB_ANALYSIS.detailDate));
  // 每个组含 real/cap6/cap7/budget 四指标
  const g400 = EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.groups['400T-550T'];
  check('组含 real/cap6/cap7/budget', g400 && ['real','cap6','cap7','budget'].every(k => Array.isArray(g400[k])), JSON.stringify(g400 && Object.keys(g400)));
}
if (EMB_MAP) {
  check('EMBEDDED_MAPPINGS 含 capacity/bom/lineDate', ['capacity','bom','lineDate'].every(k => EMB_MAP[k] && typeof EMB_MAP[k] === 'object'),
    'capacity=' + Object.keys(EMB_MAP.capacity || {}).length + ', bom=' + Object.keys(EMB_MAP.bom || {}).length + ', lineDate=' + Object.keys(EMB_MAP.lineDate || {}).length);
}
if (EMB) {
  check('EMBEDDED_DATA 含 mold（热力图依赖）', !!(EMB.mold && EMB.mold.items && Array.isArray(EMB.mold.items)), 'mold.items=' + (EMB.mold && EMB.mold.items ? EMB.mold.items.length : '?'));
}

// =========================================================================
console.log('\n========== 运行逻辑 IIFE（vm + 桩环境） ==========');
// ---- SheetJS 工具桩（实现 decode_range / encode_cell） ----
function colIdxToLetter(c) { let s = ''; c = c + 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
function letterToColIdx(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
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

// ---- classList 桩（记录状态） ----
function makeClassList() {
  const set = new Set();
  return {
    add: function () { for (const a of arguments) set.add(a); },
    remove: function () { for (const a of arguments) set.delete(a); },
    toggle: function (name, force) {
      const on = (force === undefined) ? !set.has(name) : !!force;
      if (on) set.add(name); else set.delete(name);
      return on;
    },
    contains: function (name) { return set.has(name); },
    _set: set
  };
}
function makeEl(id) {
  const el = {
    id: id, innerHTML: '', style: {}, className: '', textContent: '', value: '',
    classList: makeClassList(),
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    setAttribute: function () {},
    getAttribute: function () { return null; },
    disabled: false
  };
  return el;
}

const capturedOptions = {};   // chartId -> option
const echartsStub = {
  getInstanceByDom: function () { return null; },
  init: function (el) {
    return { setOption: function (opt) { capturedOptions[el && el.id || 'anon'] = opt; } };
  }
};

const els = {};
function getEl(id) {
  if (els[id] === undefined) els[id] = makeEl(id);
  return els[id];
}
const localStorageStore = {};
const sandbox = {
  window: { echarts: echartsStub, XLSX: xlsxStub, addEventListener: function () {} },
  document: {
    readyState: 'loading',
    addEventListener: function () {},
    getElementById: function (id) { return getEl(id); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    body: getEl('body')
  },
  FileReader: function () {},
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null; },
    setItem: function (k, v) { localStorageStore[k] = String(v); }
  },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  console: console
};
vm.createContext(sandbox);
// 注入未在 __injectionDebug 中暴露但需测试的内部函数
{
  const idx = logicScript.lastIndexOf('})();');
  if (idx >= 0) {
    logicScript = logicScript.slice(0, idx) +
      '\n  window.__injectionDebug.renderPreview = renderPreview;\n' +
      '  window.__injectionDebug.renderTop10One = renderTop10One;\n' +
      logicScript.slice(idx);
  }
}
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
const expectedFn = ['computeDetailRows','excelWeekNum','weekFromLineDate','cavityCount','solarToLunar','wsToDense','collectFormulas','parseWorkbook','buildVarieties','buildMachine','buildMachineOption','buildTop10Data','buildVarietyOption','buildMoldHeatOption','renderKPI','renderMeta','renderToday','applySettings','getState','getMappings'];
check('执行环境. 暴露函数齐全', expectedFn.every(f => typeof D[f] === 'function'), expectedFn.filter(f => typeof D[f] !== 'function').join(',') || '全部存在');

// =========================================================================
console.log('\n========== 改善1：公式解析引擎 ==========');
(function testFormula() {
  const ws = {
    '!ref': 'A1:B3',
    'A1': { v: '品名' }, 'B1': { v: '工时' },
    'A2': { v: '外壳A' }, 'B2': { v: 6, f: '=A2*2' },
    'A3': { v: 3 }, 'B3': { v: 30, f: '=A3*10' }
  };
  const fmap = D.collectFormulas(ws);
  check('1. collectFormulas 建立坐标→公式映射', !!fmap && typeof fmap === 'object');
  check('1. formulaMap["B2"] === "=A2*2"', fmap && fmap['B2'] === '=A2*2', JSON.stringify(fmap && fmap['B2']));
  check('1. formulaMap["B3"] === "=A3*10"', fmap && fmap['B3'] === '=A3*10', JSON.stringify(fmap && fmap['B3']));
  check('1. 非公式单元格不进 formulaMap', !fmap['A2'] && !fmap['A1'], JSON.stringify(Object.keys(fmap || {})));

  const dense = D.wsToDense(ws);
  check('1. wsToDense 返回 aoa', !!dense && Array.isArray(dense.aoa) && dense.aoa.length === 3);
  check('1. 聚合用 cell.v（B2 值=6 而非公式文本）', dense && dense.aoa[1][1] === 6, JSON.stringify(dense && dense.aoa[1] && dense.aoa[1][1]));
  check('1. wsToDense 亦收集公式到 formulas', dense && dense.formulas && dense.formulas['B2'] === '=A2*2');
  check('1. sR/sC 正确（0,0）', dense && dense.sR === 0 && dense.sC === 0, JSON.stringify([dense && dense.sR, dense && dense.sC]));

  // 预览打标：喂入带公式的 state.preview，检查 HTML 输出含 f(x) 徽章 + title 公式
  const st = D.getState();
  st.preview = { sheets: [{ title: '工单备料明细', rows: [['品名', '工时'], ['外壳A', 6]], formulas: { 'B2': '=A2*2' }, formulaCount: 1, cols: 2, sR: 0, sC: 0 }], activeSheet: 0, page: 0 };
  D.renderPreview();
  const htmlOut = getEl('previewContainer').innerHTML;
  check('1. 预览对公式单元格打 f(x) 徽章', /cell-fx/.test(htmlOut) && /f\(x\)/.test(htmlOut));
  check('1. 预览公式 title 显示原始公式', /title="=A2\*2"/.test(htmlOut));
  check('1. 预览 meta 含公式单元格计数', /公式单元格 1 个/.test(htmlOut));
})();

// =========================================================================
console.log('\n========== 改善2：农历算法 + renderToday + 设置面板 ==========');
(function testLunar() {
  const cny = D.solarToLunar(2026, 2, 17);
  check('2. 2026-02-17 = 正月初一', cny.lMonth === 1 && cny.lDay === 1 && !cny.isLeap,
    'lMonth=' + cny.lMonth + ' lDay=' + cny.lDay + ' isLeap=' + cny.isLeap);
  const aug = D.solarToLunar(2026, 8, 25);
  check('2. 2026-08-25 = 七月十三', aug.lMonth === 7 && aug.lDay === 13 && !aug.isLeap,
    'lMonth=' + aug.lMonth + ' lDay=' + aug.lDay + ' isLeap=' + aug.isLeap);
  // 星期校验：2026-08-25 应为星期二（getDay()==2）
  const wd = new Date(2026, 7, 25).getDay();
  check('2. 2026-08-25 是星期二（getDay=2）', wd === 2, 'getDay=' + wd);
  // 额外锚点：2025 春节 2025-01-29 = 正月初一
  const cny25 = D.solarToLunar(2025, 1, 29);
  check('2. 2025-01-29 = 正月初一（跨年锚点）', cny25.lMonth === 1 && cny25.lDay === 1, 'lMonth=' + cny25.lMonth + ' lDay=' + cny25.lDay);
  // renderToday 不含异常（用桩 document）
  try {
    D.renderToday();
    const todayTxt = getEl('todayLine').textContent;
    check('2. renderToday 输出"年月日·农历·星期"', /\d+年\d+月\d+日 · .+ · 星期[日一二三四五六]/.test(todayTxt), todayTxt);
  } catch (e) { check('2. renderToday 不抛异常', false, e.message); }
})();
(function testSettings() {
  // 主题切换：注入 dark → applySettings → body.classList 含 dark
  localStorageStore['injectionTheme'] = 'dark';
  D.applySettings();
  check('2. 主题切换 body 加 dark class', getEl('body').classList.contains('dark'));
  localStorageStore['injectionTheme'] = 'light';
  D.applySettings();
  check('2. 主题切回 light 移除 dark class', !getEl('body').classList.contains('dark'));
  // 字体大小 class
  localStorageStore['injectionFontSize'] = 'lg';
  D.applySettings();
  check('2. 字体大小 body 加 font-lg', getEl('body').classList.contains('font-lg'));
  // 字体颜色 class
  localStorageStore['injectionFontColor'] = 'green';
  D.applySettings();
  check('2. 字体颜色 body 加 font-green', getEl('body').classList.contains('font-green'));
  localStorageStore['injectionFontColor'] = 'default';
  D.applySettings();
  check('2. 字体颜色 default 不残留颜色 class', !getEl('body').classList.contains('font-green') && !getEl('body').classList.contains('font-blue'));
})();

// =========================================================================
console.log('\n========== 改善3：模块删除 / 机台组合图 / top10 / KPI ==========');
(function testDeleted() {
  const deletedFn = ['machineStackedChart', 'moldTopChart', 'materialTopChart', 'materialTrendChart', 'valueMonthlyChart', 'backlogCategoryChart', 'backlogCategoryMachine', 'backlogCategoryWeek', 'renderBacklog', 'backlogByMachine'];
  const deletedLabel = ['总订单', '机台分布', '周分布', '月度产值', '原料TOP', '模具TOP', '备料汇总', '原料趋势', '品类产值占比'];
  let fnOk = true, fnHit = [];
  deletedFn.forEach(f => { if (html.indexOf(f) >= 0) { fnOk = false; fnHit.push(f); } });
  check('3. 已删除旧模块函数（machineStacked/moldTop/materialTop/…）', fnOk, fnHit.join(',') || '全部未残留');
  let lbOk = true, lbHit = [];
  deletedLabel.forEach(l => { if (html.indexOf(l) >= 0) { lbOk = false; lbHit.push(l); } });
  check('3. 已删除旧模块文案（总订单/机台分布/周分布/…）', lbOk, lbHit.join(',') || '全部未残留');
  // 旧 chart 容器 id
  const deletedIds = ['machineStackedChart', 'moldTopChart', 'materialTopChart', 'materialTrendChart', 'valueMonthlyChart', 'backlogCategoryChart', 'backlogMachineChart', 'backlogWeekChart'];
  let idOk = true, idHit = [];
  deletedIds.forEach(id => { if (html.indexOf('id="' + id + '"') >= 0) { idOk = false; idHit.push(id); } });
  check('3. 已删除旧图表容器 DOM', idOk, idHit.join(',') || '全部未残留');
  // moldHeat 移到最下方（在 top10 之后、preview 之前，是最后一个 chart）
  const moldHeatIdx = html.indexOf('id="moldHeatChart"');
  const top10Idx = html.indexOf('id="top10AccChart"');
  const previewIdx = html.indexOf('id="previewContainer"');
  check('3. moldHeatChart 位于 top10 之后', moldHeatIdx > top10Idx && top10Idx >= 0 && moldHeatIdx >= 0);
  check('3. moldHeatChart 是最后一个图表（在 preview 表之前）', moldHeatIdx < previewIdx && previewIdx >= 0);
})();
(function testMachineCombo() {
  const opt = D.buildMachineOption('400T-550T');
  check('3. buildMachineOption 产出 option', !!opt && Array.isArray(opt.series));
  if (opt && opt.series) {
    check('3. series 数量 = 4', opt.series.length === 4, '实际 ' + opt.series.length);
    const s0 = opt.series[0], s1 = opt.series[1], s2 = opt.series[2], s3 = opt.series[3];
    check('3. series[0] 实单工时 = bar + stack', s0 && s0.type === 'bar' && s0.stack === 'total' && s0.name === '实单工时', JSON.stringify(s0 && { t: s0.type, st: s0.stack, n: s0.name }));
    check('3. series[1] 预算工时 = bar + stack', s1 && s1.type === 'bar' && s1.stack === 'total' && s1.name === '预算工时', JSON.stringify(s1 && { t: s1.type, st: s1.stack, n: s1.name }));
    check('3. series[2] 6天产能 = line', s2 && s2.type === 'line' && s2.name === '6天产能', JSON.stringify(s2 && { t: s2.type, n: s2.name }));
    check('3. series[3] 7天产能 = line', s3 && s3.type === 'line' && s3.name === '7天产能', JSON.stringify(s3 && { t: s3.type, n: s3.name }));
    check('3. 同时含 bar(堆叠) 与 line', opt.series.some(s => s.type === 'bar' && s.stack) && opt.series.some(s => s.type === 'line'));
    check('3. 预算/实单无 null（映射为 0）', (s0.data || []).every(v => v !== null) && (s1.data || []).every(v => v !== null));
    check('3. xAxis 周标签数量 = weeks', opt.xAxis && opt.xAxis.data.length === D.getState().machine.weeks.length, String(opt.xAxis && opt.xAxis.data.length));
  }
  // 90T 组在新分析数据中预算非空，验证正确加载
  const o90 = D.buildMachineOption('90T');
  if (o90 && o90.series) {
    const b90 = o90.series[1] && o90.series[1].data || [];
    check('3. 90T 预算无 null/NaN（数据非空组）', b90.every(v => v !== null && !Number.isNaN(v)));
    check('3. 90T 预算首值与金标准一致', close(b90[0], analysisRef.machine.groups['90T'].budget[0]), String(b90[0]));
  }
  // 合成含 null 的 budget，验证 null→0 映射路径
  {
    const st = D.getState();
    const backup = { weeks: st.machine.weeks, groups: st.machine.groups };
    st.machine = { weeks: ['2026WK32', '2026WK33', '2026WK34', '2026WK35'], groups: { 'X': { real: [1, 2, 3, 4], cap6: [132, 132, 132, 132], cap7: [264, 264, 264, 264], budget: [null, 10, null, 20] } } };
    const oX = D.buildMachineOption('X');
    const bX = oX && oX.series[1] && oX.series[1].data;
    check('3. 合成 null 预算 → 映射为 0', bX && bX[0] === 0 && bX[2] === 0 && bX[1] === 10 && bX[3] === 20, JSON.stringify(bX));
    st.machine = backup;
  }
})();
(function testTop10() {
  const d = D.buildTop10Data();
  check('3. buildTop10Data 返回 shell/acc', !!d && Array.isArray(d.shell) && Array.isArray(d.acc));
  const shell = d.shell, acc = d.acc;
  check('3. 外壳取前 10（≤10）', shell.length === 10, '实际 ' + shell.length);
  check('3. 配件取前 10（≤10）', acc.length === 10, '实际 ' + acc.length);
  const desc = arr => arr.every((v, i) => i === 0 || num(v.pcs) <= num(arr[i - 1].pcs));
  check('3. 外壳按 PCS 降序', desc(shell));
  check('3. 配件按 PCS 降序', desc(acc));
  // 与原始 top10 比对：取最大 10 个
  const refShell = analysisRef.top10.shell.slice().sort((a, b) => b.pcs - a.pcs).slice(0, 10).map(x => x.name);
  const gotShell = shell.map(x => x.name);
  check('3. 外壳前10名称与金标准一致', JSON.stringify(refShell) === JSON.stringify(gotShell), 'got=' + gotShell.join(','));
  // renderTop10One 捕获 option，校验 label.show
  capturedOptions['top10ShellChart'] = null;
  D.renderTop10One('top10ShellChart', shell);
  const cap = capturedOptions['top10ShellChart'];
  check('3. renderTop10One 产出 option', !!cap && Array.isArray(cap.series));
  if (cap && cap.series) {
    const s = cap.series[0];
    check('3. top10 series 为 bar 且数据量=10', s && s.type === 'bar' && s.data.length === 10, String(s && s.data.length));
    check('3. top10 数据标签 label.show=true', !!(s && s.label && s.label.show === true));
  }
})();
(function testKPI() {
  D.renderKPI();
  const htmlOut = getEl('kpiGrid').innerHTML;
  check('3. KPI 渲染 3 个手输格', (htmlOut.match(/class="kpi-input"/g) || []).length === 3, String((htmlOut.match(/class="kpi-input"/g) || []).length));
  check('3. KPI 含 开机天数(天)', /data-key="days"/.test(htmlOut) && /天/.test(htmlOut));
  check('3. KPI 含 外壳数量(万PCS)', /data-key="shell"/.test(htmlOut) && /万PCS/.test(htmlOut));
  check('3. KPI 含 产值KPI(万RMB)', /data-key="value"/.test(htmlOut) && /万RMB/.test(htmlOut));
  check('3. KPI 格为可编辑 input', (htmlOut.match(/<input/g) || []).length === 3);
})();

// =========================================================================
console.log('\n========== 改善4：模具产能分析（品种去重 + 切换重聚合） ==========');
(function testVariety() {
  const rows = [
    { N: '外壳A', P: '2026WK32', J: 5 },
    { N: '外壳A', P: '2026WK32', J: 3 },
    { N: '外壳B', P: '2026WK32', J: 10 },
    { N: '外壳A', P: '2026WK33', J: 7 },
    { N: '外壳B', P: '2026WK32', J: 2 }
  ];
  const vd = D.buildVarieties(rows);
  check('4. buildVarieties 品种去重（2 个唯一品种）', vd && vd.varieties.length === 2, JSON.stringify(vd && vd.varieties));
  check('4. 品种列表排序正确', vd && vd.varieties[0] === '外壳A' && vd.varieties[1] === '外壳B');
  check('4. 周集合正确', vd && vd.weeks.length === 2 && vd.weeks[0] === '2026WK32' && vd.weeks[1] === '2026WK33', JSON.stringify(vd && vd.weeks));
  check('4. J 列按周求和（外壳A WK32=8）', vd && vd.data['外壳A']['2026WK32'] === 8, String(vd && vd.data['外壳A'] && vd.data['外壳A']['2026WK32']));
  check('4. J 列按周求和（外壳B WK32=12）', vd && vd.data['外壳B']['2026WK32'] === 12, String(vd && vd.data['外壳B'] && vd.data['外壳B']['2026WK32']));

  // 切换品种：把构建结果注入 state，验证 buildVarietyOption 重新聚合
  const st = D.getState();
  st.varietyData = vd;
  const optA = D.buildVarietyOption('外壳A', 1, 132);
  const optB = D.buildVarietyOption('外壳B', 1, 132);
  check('4. 切换品种后 real 数据不同（外壳A）', optA && optA.series && optA.series[0].data[0] === 8 && optA.series[0].data[1] === 7,
    JSON.stringify(optA && optA.series[0].data));
  check('4. 切换品种后 real 数据不同（外壳B）', optB && optB.series[0].data[0] === 12 && optB.series[0].data[1] === 0,
    JSON.stringify(optB && optB.series[0].data));
  check('4. 品种图 = 柱 + 产能折线', optA && optA.series[0].type === 'bar' && optA.series[1].type === 'line',
    JSON.stringify(optA && optA.series.map(s => s.type)));
})();

// =========================================================================
console.log('\n========== 改善5：字典扩容 ==========');
(function testDict() {
  const M = D.getMappings();
  check('5. MAPPINGS 含 capacity/bom/lineDate/report', ['capacity','bom','lineDate','report'].every(k => M && Object.prototype.hasOwnProperty.call(M, k)),
    JSON.stringify(M && Object.keys(M)));
  check('5. report 为占位对象', M && M.report && typeof M.report === 'object' && !Array.isArray(M.report));
  check('5. capacity/bom/lineDate 数据非空', M && Object.keys(M.capacity).length > 0 && Object.keys(M.bom).length > 0 && Object.keys(M.lineDate).length > 0,
    'capacity=' + Object.keys(M.capacity).length + ' bom=' + Object.keys(M.bom).length + ' lineDate=' + Object.keys(M.lineDate).length);
})();

// =========================================================================
console.log('\n========== 回归：金标准 300 行 computeDetailRows ==========');
(function testRegression() {
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
  try { result = D.computeDetailRows(aoa); } catch (e) { check('回归. computeDetailRows 正常返回', false, e.message); }
  check('回归. computeDetailRows 正常返回', !!result && Array.isArray(result.rows));

  const M = D.getMappings();
  if (result && result.rows) {
    check('回归. 输出行数 = 300', result.rows.length === 300, '实际 ' + result.rows.length);
    const out = result.rows;
    let kBad = 0, lBad = 0, jBad = 0, wBad = 0, qBad = 0, rBad = 0, sBad = 0, tBad = 0, mBad = 0;
    const samples = [];
    for (let i = 0; i < out.length; i++) {
      const o = out[i], td = testdata[i];
      if (o.K !== td.K) kBad++;
      if (o.L !== td.L) lBad++;
      const jGot = Math.round((o.J || 0) * 100), jExp = Math.round((td.J || 0) * 100);
      if (jGot !== jExp) jBad++;
      const wDiff = Math.abs((o.W || 0) - (td.W || 0));
      if (wDiff > 1e-6) wBad++;
      const qGot = o.Q == null ? '' : String(o.Q).trim(), qExp = td.Q == null ? '' : String(td.Q).trim();
      const rGot = o.R == null ? '' : String(o.R).trim(), rExp = td.R == null ? '' : String(td.R).trim();
      if (qGot !== qExp) qBad++;
      if (rGot !== rExp) rBad++;
      if (!close(o.S, td.S)) sBad++;
      if (!close(o.T, td.T)) tBad++;
      const mVal = (M.lineDate && M.lineDate[String(td.B)]) || '';
      if (mVal !== td.M) mBad++;
      if (samples.length < 6 && (o.K !== td.K || o.L !== td.L || jGot !== jExp || wDiff > 1e-6)) {
        samples.push({ line: i + 1, C: td.C, expK: td.K, gotK: o.K, expL: td.L, gotL: o.L, expJ: td.J, gotJ: o.J });
      }
    }
    check('回归. K（累计）300/300 一致', kBad === 0, kBad + ' 行不一致');
    check('回归. L（扣库存待生产）300/300 一致', lBad === 0, lBad + ' 行不一致');
    check('回归. J（工时）300/300 一致(±0.005)', jBad === 0, jBad + ' 行不一致');
    check('回归. W（原料KG）300/300 一致(±1e-6)', wBad === 0, wBad + ' 行不一致');
    check('回归. Q（机台）300/300 一致', qBad === 0, qBad + ' 行不一致');
    check('回归. R（穴数）300/300 一致', rBad === 0, rBad + ' 行不一致');
    check('回归. S（周期）300/300 一致', sBad === 0, sBad + ' 行不一致');
    check('回归. T（毛重）300/300 一致', tBad === 0, tBad + ' 行不一致');
    check('回归. M（上线日）300/300 一致', mBad === 0, mBad + ' 行不一致');
    if (samples.length) console.log('  [回归样本]', JSON.stringify(samples));
    // 交叉复算 J/W
    let jCross = 0, wCross = 0;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      const cav = D.cavityCount(o.R);
      const jE = (o.S > 0 && cav > 0) ? Math.ceil((o.S * o.L / 3600 / cav) * 100) / 100 : 0;
      if (Math.round(jE * 100) !== Math.round((o.J || 0) * 100)) jCross++;
      const wE = o.L * o.T / 1000;
      if (Math.abs(wE - (o.W || 0)) > 1e-6) wCross++;
    }
    check('回归. 交叉复算 J=ROUNDUP(S×L/3600/穴数,2) 一致', jCross === 0, jCross + ' 行不符');
    check('回归. 交叉复算 W=L×T/1000 一致', wCross === 0, wCross + ' 行不符');
  }
})();

// =========================================================================
console.log('\n========== 补充：metaLine 两行 + 热力图未来12周 ==========');
(function testMetaHeat() {
  D.renderMeta();
  const metaHtml = getEl('metaLine').innerHTML;
  check('meta. 输出两行 meta-row', (metaHtml.match(/meta-row/g) || []).length === 2, String((metaHtml.match(/meta-row/g) || []).length));
  check('meta. 第一行含"最新主排程注塑待生产导出"', /最新主排程注塑待生产导出/.test(metaHtml));
  check('meta. 含内置 detailDate=2026-08-10', /2026-08-10/.test(metaHtml));
  check('meta. 第二行含"最新DKL预算"', /最新DKL预算/.test(metaHtml));
  check('meta. 预算更新日期为可手输 input（budgetDateInput）', /id="budgetDateInput"/.test(metaHtml) && /<input/.test(metaHtml));

  const st = D.getState();
  const heat = D.buildMoldHeatOption();
  check('heat. 热力图横坐标 = 未来12周', heat && heat.xAxis && heat.xAxis.data.length === 12, '实际 ' + (heat && heat.xAxis && heat.xAxis.data.length));
  check('heat. 纵轴模具 ≤ 12 个', heat && heat.yAxis && heat.yAxis.data.length <= 12, '实际 ' + (heat && heat.yAxis && heat.yAxis.data.length));
  check('heat. 热力图 series 为 heatmap', heat && heat.series && heat.series[0] && heat.series[0].type === 'heatmap', JSON.stringify(heat && heat.series && heat.series[0] && heat.series[0].type));
  console.log('  [INFO] mold.weeks=' + (st.mold.weeks || []).length + '，热力图窗口=' + JSON.stringify(heat && heat.xAxis && heat.xAxis.data));
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) {
  console.log('存在失败项，请见上方 [FAIL]。');
  process.exit(1);
} else {
  console.log('全部通过。');
}
