'use strict';
/* =========================================================================
 * QA 校验脚本 05：《校准 + P2 优化》独立复验（真实执行）
 *  1. parseAnalysis2  固定列精确解析（5 组 × 38 周，1-based 固定列，行 5~42，202 前缀过滤）
 *  2. parseAnalysis3  固定列解析（第 17 行起取前 10 行，外壳 A-E / 配件 F-H）
 *  3. mapMachineGroup 识别 150T-280T；parseDetail CANONICAL 追加 150T-280T
 *  4. HTML 顺序：数据预览在热力图之前，moldHeat 为最后一个 section
 *  5. EMBEDDED_DATA 无 meta.totalOrders / 无 backlog 字段，逻辑段无残留引用
 *  6. 回归：computeDetailRows 金标准 300 行 J/K/L/W；EMBEDDED_ANALYSIS 深度一致
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
function num(v) { if (v === null || v === undefined || v === '') return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function colIdxToLetter(c) { let s = ''; c = c + 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
function letterToColIdx(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

// 将 2D 稠密数组（0-based）转成 SheetJS 风格的 worksheet 桩
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
function genWeeks(n, y, w) {
  const out = [];
  for (let i = 0; i < n; i++) { out.push(y + 'WK' + w); w++; if (w > 53) { w = 1; y++; } }
  return out;
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
let EMB = null, EMB_ANALYSIS = null;
try { EMB = extractConst(dataScript, 'EMBEDDED_DATA'); } catch (e) { check('抽取 EMBEDDED_DATA', false, e.message); }
try { EMB_ANALYSIS = extractConst(dataScript, 'EMBEDDED_ANALYSIS'); } catch (e) { check('抽取 EMBEDDED_ANALYSIS', false, e.message); }
check('内嵌常量可抽取（DATA + ANALYSIS）', !!EMB && !!EMB_ANALYSIS);

function canonical(obj) {
  if (Array.isArray(obj)) return obj.map(canonical);
  if (obj && typeof obj === 'object') {
    const out = {};
    Object.keys(obj).sort().forEach(k => { out[k] = canonical(obj[k]); });
    return out;
  }
  return obj;
}

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
  return {
    id: id, innerHTML: '', style: {}, className: '', textContent: '', value: '',
    classList: makeClassList(), addEventListener: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }, disabled: false
  };
}
const echartsStub = {
  getInstanceByDom: function () { return null; },
  init: function (el) { return { setOption: function () {} }; }
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
  FileReader: function () {},
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null; },
    setItem: function (k, v) { localStorageStore[k] = String(v); }
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
['computeDetailRows', 'wsToDense', 'mapMachineGroup', 'canonicalGroup', 'parseDetail', 'parseAnalysis2', 'parseAnalysis3', 'parseWorkbook'].forEach(f => {
  check('暴露函数 ' + f, typeof D[f] === 'function');
});

// =========================================================================
console.log('\n========== 1. parseAnalysis2 固定列精确解析 ==========');
(function testAnalysis2() {
  const blocks = [
    { group: '400T-550T', week: 2,  real: 3,  cap6: 4,  cap7: 5,  budget: 6 },
    { group: '230T-280T', week: 13, real: 14, cap6: 15, cap7: 16, budget: 17 },
    { group: '150T',       week: 23, real: 24, cap6: 25, cap7: 26, budget: 27 },
    { group: '90T',        week: 32, real: 33, cap6: 34, cap7: 35, budget: 36 },
    { group: '150T-280T',  week: 46, real: 47, cap6: 48, cap7: 49, budget: 50 }
  ];
  const metricIdx = { real: 1, cap6: 2, cap7: 3, budget: 4 };
  const weeks38 = genWeeks(38, 2026, 32);

  const nRows = 43, nCols = 50;
  const aoa = [];
  for (let r = 0; r < nRows; r++) aoa.push(new Array(nCols).fill(null));

  // 第 4 行（标题，应被跳过）与第 43 行（超界，应被跳过）各放一个合法周号作干扰
  aoa[3][1] = '2026WK31';    // 绝对行 4，col B
  aoa[42][1] = '2027WK17';   // 绝对行 43，col B

  // 数据行：绝对行 5~42（0-based 索引 4~41）
  for (let rowIdx = 0; rowIdx < 38; rowIdx++) {
    const r = 4 + rowIdx; // 绝对行 5 起
    for (let b = 0; b < blocks.length; b++) {
      const blk = blocks[b];
      aoa[r][blk.week - 1] = weeks38[rowIdx];
      aoa[r][blk.real - 1] = (b + 1) * 100000 + metricIdx.real * 10000 + rowIdx;
      aoa[r][blk.cap6 - 1] = (b + 1) * 100000 + metricIdx.cap6 * 10000 + rowIdx;
      aoa[r][blk.cap7 - 1] = (b + 1) * 100000 + metricIdx.cap7 * 10000 + rowIdx;
      aoa[r][blk.budget - 1] = (b + 1) * 100000 + metricIdx.budget * 10000 + rowIdx;
    }
  }

  const res = D.parseAnalysis2(aoaToWs(aoa));
  check('1. parseAnalysis2 返回非空', !!res && !!res.weeks && !!res.groups);
  if (res) {
    check('1. 解析出 38 周', res.weeks.length === 38, '实际 ' + res.weeks.length);
    check('1. 周号起点 = 2026WK32', res.weeks[0] === '2026WK32', res.weeks[0]);
    check('1. 周号终点 = 2027WK16', res.weeks[37] === '2027WK16', res.weeks[37]);
    check('1. 周号序列连续正确', res.weeks.join(',') === weeks38.join(','));

    const gKeys = Object.keys(res.groups).sort();
    const expKeys = ['150T', '150T-280T', '230T-280T', '400T-550T', '90T'];
    check('1. 解析出 5 组', gKeys.length === 5, JSON.stringify(gKeys));
    check('1. 组键集合正确', JSON.stringify(gKeys) === JSON.stringify(expKeys));

    let dimOk = true, dimHit = [];
    expKeys.forEach(g => {
      const grp = res.groups[g];
      ['real', 'cap6', 'cap7', 'budget'].forEach(k => {
        if (!Array.isArray(grp[k]) || grp[k].length !== 38) { dimOk = false; dimHit.push(g + '.' + k); }
      });
    });
    check('1. 5 组 × 4 指标均含 38 周数据', dimOk, dimHit.join(',') || '全部 38 列');

    // 精确列值校验（150T-280T 组，block 4，real 基值 510000）
    let valOk = true;
    for (let i = 0; i < 38; i++) {
      if (res.groups['150T-280T'].real[i] !== 510000 + i) valOk = false;
      if (res.groups['150T-280T'].cap6[i] !== 520000 + i) valOk = false;
      if (res.groups['150T-280T'].cap7[i] !== 530000 + i) valOk = false;
      if (res.groups['150T-280T'].budget[i] !== 540000 + i) valOk = false;
      if (res.groups['400T-550T'].real[i] !== 110000 + i) valOk = false;
      if (res.groups['90T'].budget[i] !== 440000 + i) valOk = false;
    }
    check('1. 固定列值一一对应正确（400T/90T/150T-280T 抽验）', valOk);
    check('1. 第 4 行标题未混入数据', res.weeks.indexOf('2026WK31') < 0);
    check('1. 第 43 行超界数据未混入', res.weeks.indexOf('2027WK17') < 0);
  }

  // —— 202 前缀过滤 + 空白/数值周号跳过 ——
  const aoaF = [];
  for (let r = 0; r < 9; r++) aoaF.push(new Array(50).fill(null));
  aoaF[4][1] = '2026WK32'; aoaF[4][2] = 111;      // 行5：合法
  aoaF[5][1] = '1999WK50'; aoaF[5][2] = 222;      // 行6：非 202 前缀 → 过滤
  aoaF[6][1] = '2027WK01'; aoaF[6][2] = 333;      // 行7：合法
  aoaF[7][1] = '';         aoaF[7][2] = 444;      // 行8：空白 → 过滤
  aoaF[8][1] = 202632;     aoaF[8][2] = 555;      // 行9：数值周号 → 过滤
  const resF = D.parseAnalysis2(aoaToWs(aoaF));
  check('1. 前缀过滤样例返回非空', !!resF);
  if (resF) {
    check('1. 过滤后仅 2 周', resF.weeks.length === 2, JSON.stringify(resF.weeks));
    // 注意：normWeekLabel 会去掉周号前导零（2027WK01 → 2027WK1），与真实数据格式一致
    check('1. 过滤后周序正确（含前导零归一化）', resF.weeks[0] === '2026WK32' && resF.weeks[1] === '2027WK1', JSON.stringify(resF.weeks));
    check('1. 400T-550T.real 值对齐被过滤行', resF.groups['400T-550T'].real[0] === 111 && resF.groups['400T-550T'].real[1] === 333, JSON.stringify(resF.groups['400T-550T'].real));
  }
})();

// =========================================================================
console.log('\n========== 2. parseAnalysis3 固定列解析（前 10 行） ==========');
(function testAnalysis3() {
  const aoa = [];
  for (let r = 0; r < 28; r++) aoa.push(new Array(8).fill(null));
  aoa[15][0] = '品名'; aoa[15][1] = 'PCS'; // 第 16 行表头，应被跳过
  for (let k = 0; k < 10; k++) {
    const r = 16 + k; // 绝对行 17~26
    aoa[r][0] = '外壳P' + (k + 1);
    aoa[r][1] = 100 + k;
    aoa[r][2] = 1000 + k;
    aoa[r][3] = 2000 + k;
    aoa[r][4] = 3000 + k;
    aoa[r][5] = '配件A' + (k + 1);
    aoa[r][6] = 500 + k;
    aoa[r][7] = 6000 + k;
  }
  // 第 27/28 行（超界，应被截断）
  aoa[26][0] = '外壳OVERFLOW'; aoa[26][1] = 9999;
  aoa[27][5] = '配件OVERFLOW'; aoa[27][6] = 8888;

  const res = D.parseAnalysis3(aoaToWs(aoa));
  check('2. parseAnalysis3 返回非空', !!res && !!res.shell && !!res.acc);
  if (res) {
    check('2. 外壳取前 10（=10）', res.shell.length === 10, '实际 ' + res.shell.length);
    check('2. 配件取前 10（=10）', res.acc.length === 10, '实际 ' + res.acc.length);
    check('2. 外壳第 1 行字段正确', res.shell[0].name === '外壳P1' && res.shell[0].pcs === 100 && res.shell[0].amount === 1000 && res.shell[0].realQty === 2000 && res.shell[0].budgetQty === 3000, JSON.stringify(res.shell[0]));
    check('2. 外壳第 10 行字段正确', res.shell[9].name === '外壳P10' && res.shell[9].pcs === 109 && res.shell[9].budgetQty === 3009, JSON.stringify(res.shell[9]));
    check('2. 配件第 1 行字段正确（F-H）', res.acc[0].name === '配件A1' && res.acc[0].pcs === 500 && res.acc[0].amount === 6000, JSON.stringify(res.acc[0]));
    check('2. 第 27 行溢出外壳未读入', res.shell.every(x => x.name !== '外壳OVERFLOW'));
    check('2. 第 28 行溢出配件未读入', res.acc.every(x => x.name !== '配件OVERFLOW'));
  }

  // —— 空白品名跳过 ——
  const aoaB = [];
  for (let r = 0; r < 19; r++) aoaB.push(new Array(8).fill(null));
  aoaB[16][0] = '';   aoaB[16][5] = '配件X'; aoaB[16][6] = 1; aoaB[16][7] = 2; // 行17 外壳空
  aoaB[17][0] = '外壳Y'; aoaB[17][1] = 3; aoaB[17][5] = '';                     // 行18 配件空
  const resB = D.parseAnalysis3(aoaToWs(aoaB));
  check('2. 空白品名样例返回非空', !!resB);
  if (resB) {
    check('2. 空白外壳品名被跳过（仅 1 条）', resB.shell.length === 1 && resB.shell[0].name === '外壳Y' && resB.shell[0].pcs === 3, JSON.stringify(resB.shell));
    check('2. 空白配件品名被跳过（仅 1 条）', resB.acc.length === 1 && resB.acc[0].name === '配件X' && resB.acc[0].pcs === 1, JSON.stringify(resB.acc));
  }
})();

// =========================================================================
console.log('\n========== 3. mapMachineGroup / canonicalGroup / parseDetail 150T-280T ==========');
(function testMapping() {
  check('3. mapMachineGroup("150T-280T") = 150T-280T', D.mapMachineGroup('150T-280T') === '150T-280T', D.mapMachineGroup('150T-280T'));
  check('3. mapMachineGroup("230T-260T") = 230T-280T', D.mapMachineGroup('230T-260T') === '230T-280T', D.mapMachineGroup('230T-260T'));
  check('3. mapMachineGroup("260T") = 230T-280T', D.mapMachineGroup('260T') === '230T-280T', D.mapMachineGroup('260T'));
  check('3. mapMachineGroup("230T-280T") = 230T-280T', D.mapMachineGroup('230T-280T') === '230T-280T');
  check('3. mapMachineGroup("150T") = 150T（不与 150T-280T 混淆）', D.mapMachineGroup('150T') === '150T');
  check('3. mapMachineGroup("90T") = 90T', D.mapMachineGroup('90T') === '90T');
  check('3. mapMachineGroup("400T-550T") = 400T-550T', D.mapMachineGroup('400T-550T') === '400T-550T');
  check('3. mapMachineGroup("未知") = 其他', D.mapMachineGroup('未知机台') === '其他');
  check('3. canonicalGroup("150T-280T") = 150T-280T', D.canonicalGroup('150T-280T') === '150T-280T');
  check('3. canonicalGroup("150T") = 150T', D.canonicalGroup('150T') === '150T');

  // —— parseDetail 上传路径：150T-280T 实单工时流入对应组 ——
  function detailRow(d, e, j, l, p, q) {
    const row = new Array(23).fill(null);
    row[3] = d; row[4] = e; row[9] = j; row[11] = l; row[15] = p; row[16] = q;
    return row;
  }
  const aoa = [
    ['h', 'h', 'h'], ['h', 'h', 'h'], ['h', 'h', 'h'],
    detailRow('外壳类', 'DH001', 12, 100, '2026WK32', '150T-280T'),
    detailRow('外壳类', 'DH001', 8, 90, '2026WK33', '150T-280T'),
    detailRow('外壳类', 'DH002', 5, 50, '2026WK32', '150T'),
    detailRow('外壳类', 'DH003', 3, 30, '2026WK32', '400T-550T')
  ];
  const pd = D.parseDetail(aoaToWs(aoa));
  check('3. parseDetail 返回 machine.groups', !!pd && !!pd.machine && !!pd.machine.groups);
  if (pd && pd.machine && pd.machine.groups) {
    const g = pd.machine.groups;
    check('3. 组键含 150T-280T', !!g['150T-280T'], JSON.stringify(Object.keys(g)));
    check('3. weeks = [2026WK32, 2026WK33]', JSON.stringify(pd.machine.weeks) === JSON.stringify(['2026WK32', '2026WK33']), JSON.stringify(pd.machine.weeks));
    check('3. 150T-280T.real = [12, 8]（实单工时流入）', JSON.stringify(g['150T-280T'].real) === JSON.stringify([12, 8]), JSON.stringify(g['150T-280T'].real));
    check('3. 150T.real = [5, 0]（150T 单独成组，未被 150T-280T 污染）', JSON.stringify(g['150T'].real) === JSON.stringify([5, 0]), JSON.stringify(g['150T'].real));
    check('3. 400T-550T.real = [3, 0]', JSON.stringify(g['400T-550T'].real) === JSON.stringify([3, 0]), JSON.stringify(g['400T-550T'].real));
    // 无“其他”组泄漏
    check('3. 无“其他”组', !g['其他']);
  }
})();

// =========================================================================
console.log('\n========== 4. HTML 顺序（预览在热力图前，moldHeat 最后） ==========');
(function testOrder() {
  const previewIdx = html.indexOf('id="previewContainer"');
  const moldHeatIdx = html.indexOf('id="moldHeatChart"');
  check('4. previewContainer 存在', previewIdx >= 0);
  check('4. moldHeatChart 存在', moldHeatIdx >= 0);
  check('4. 预览在热力图之前', previewIdx >= 0 && moldHeatIdx >= 0 && previewIdx < moldHeatIdx);
  const allModules = [];
  // 仅匹配 DOM 属性（模块 key 为字母数字），排除 JS 中 querySelector 的字符串拼接片段
  const re = /data-module="([a-zA-Z0-9]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) allModules.push(m[1]);
  check('4. data-module 顺序为 kpi/machine/moldVariety/top10/preview/moldHeat',
    JSON.stringify(allModules) === JSON.stringify(['kpi', 'machine', 'moldVariety', 'top10', 'preview', 'moldHeat']),
    JSON.stringify(allModules));
  check('4. moldHeat 是最后一个 section', allModules.length > 0 && allModules[allModules.length - 1] === 'moldHeat');
})();

// =========================================================================
console.log('\n========== 5. EMBEDDED_DATA 无 totalOrders/backlog ==========');
(function testEmbeddedMeta() {
  if (EMB) {
    check('5. EMBEDDED_DATA.meta 无 totalOrders 字段', !!EMB.meta && !Object.prototype.hasOwnProperty.call(EMB.meta, 'totalOrders'), JSON.stringify(Object.keys(EMB.meta || {})));
    check('5. EMBEDDED_DATA 顶层无 backlog 字段', !Object.prototype.hasOwnProperty.call(EMB, 'backlog'), JSON.stringify(Object.keys(EMB)));
    check('5. meta.machineGroups 含 150T-280T', Array.isArray(EMB.meta && EMB.meta.machineGroups) && EMB.meta.machineGroups.indexOf('150T-280T') >= 0, JSON.stringify(EMB.meta && EMB.meta.machineGroups));
  }
  check('5. HTML 全文无 totalOrders 残留', html.indexOf('totalOrders') < 0);
  check('5. HTML 全文无 backlog 残留', html.indexOf('backlog') < 0);
  check('5. 逻辑段无 totalOrders 引用', logicScript.indexOf('totalOrders') < 0);
  check('5. 逻辑段无 backlog 引用', logicScript.indexOf('backlog') < 0);
})();

// =========================================================================
console.log('\n========== 6. EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致 ==========');
(function testConsistency() {
  if (EMB_ANALYSIS) {
    check('6. EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致', JSON.stringify(canonical(EMB_ANALYSIS)) === JSON.stringify(canonical(analysisRef)));
    check('6. machine.weeks 长度 = 38', EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.weeks.length === 38, String(EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.weeks.length));
    const gKeys = EMB_ANALYSIS.machine && Object.keys(EMB_ANALYSIS.machine.groups) || [];
    check('6. machine.groups 5 键', gKeys.length === 5, JSON.stringify(gKeys));
    const expGroups = ['400T-550T', '230T-280T', '150T', '90T', '150T-280T'];
    check('6. machine.groups 键集合正确（含 150T-280T）', expGroups.every(k => gKeys.indexOf(k) >= 0), JSON.stringify(gKeys));
    const g150280 = EMB_ANALYSIS.machine && EMB_ANALYSIS.machine.groups['150T-280T'];
    check('6. 150T-280T 组含 real/cap6/cap7/budget', g150280 && ['real', 'cap6', 'cap7', 'budget'].every(k => Array.isArray(g150280[k])), JSON.stringify(g150280 && Object.keys(g150280)));
    const sumReal = g150280 && g150280.real ? g150280.real.reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    check('6. 150T-280T 组实单工时非全零（校准后真正有数据）', sumReal > 0, 'sum(real)=' + sumReal);
  }
})();

// =========================================================================
console.log('\n========== 7. 回归：金标准 300 行 computeDetailRows ==========');
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
  try { result = D.computeDetailRows(aoa); } catch (e) { check('7. computeDetailRows 正常返回', false, e.message); }
  check('7. computeDetailRows 正常返回', !!result && Array.isArray(result.rows));
  if (result && result.rows) {
    check('7. 输出行数 = 300', result.rows.length === 300, '实际 ' + result.rows.length);
    const out = result.rows;
    let kBad = 0, lBad = 0, jBad = 0, wBad = 0, qBad = 0, rBad = 0, sBad = 0, tBad = 0;
    for (let i = 0; i < out.length; i++) {
      const o = out[i], td = testdata[i];
      if (o.K !== td.K) kBad++;
      if (o.L !== td.L) lBad++;
      const jGot = Math.round((o.J || 0) * 100), jExp = Math.round((td.J || 0) * 100);
      if (jGot !== jExp) jBad++;
      if (Math.abs((o.W || 0) - (td.W || 0)) > 1e-6) wBad++;
      const qGot = o.Q == null ? '' : String(o.Q).trim(), qExp = td.Q == null ? '' : String(td.Q).trim();
      const rGot = o.R == null ? '' : String(o.R).trim(), rExp = td.R == null ? '' : String(td.R).trim();
      if (qGot !== qExp) qBad++;
      if (rGot !== rExp) rBad++;
      if (!close(o.S, td.S)) sBad++;
      if (!close(o.T, td.T)) tBad++;
    }
    check('7. K（累计）300/300 一致', kBad === 0, kBad + ' 行不一致');
    check('7. L（扣库存待生产）300/300 一致', lBad === 0, lBad + ' 行不一致');
    check('7. J（工时）300/300 一致(±0.005)', jBad === 0, jBad + ' 行不一致');
    check('7. W（原料KG）300/300 一致(±1e-6)', wBad === 0, wBad + ' 行不一致');
    check('7. Q（机台）300/300 一致', qBad === 0, qBad + ' 行不一致');
    check('7. R（穴数）300/300 一致', rBad === 0, rBad + ' 行不一致');
    check('7. S（周期）300/300 一致', sBad === 0, sBad + ' 行不一致');
    check('7. T（毛重）300/300 一致', tBad === 0, tBad + ' 行不一致');
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
    check('7. 交叉复算 J=ROUNDUP(S×L/3600/穴数,2) 一致', jCross === 0, jCross + ' 行不符');
    check('7. 交叉复算 W=L×T/1000 一致', wCross === 0, wCross + ' 行不符');
  }
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
} else {
  console.log('全部通过。');
}
