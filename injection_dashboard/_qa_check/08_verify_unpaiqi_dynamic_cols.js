'use strict';
/* =========================================================================
 * QA 校验脚本 08：独立复验「未排期过滤 + 主排程动态列位」两处修复（全新视角，真实执行）
 *
 *  一、parseDetail 未排期过滤（约 line 902）
 *    - 机台图 machine.weeks 不含 "未排期"/空串，只含真实 WK 周
 *    - 未排期行 J 工时 / L 扣库存不进入 machineAgg 机台实单聚合
 *    - detailRows 保留全部行（含未排期行 J/L/P=''）
 *    - buildVarieties 的 weeks/varieties 均不含 "未排期"
 *  二、parseSchedule 动态列位（约 line 966）
 *    - 格式A（批号A列 / 上线日期B列）正确解析
 *    - 格式B（批号B列 / 日期C列）动态定位列位并正确解析
 *    - 空批号/空日期行跳过不崩溃
 *  三、回归
 *    - computeDetailRows 300 行 J/K/L/W 基线
 *    - parseBudget H列分组 / 偶数列工时 / 34.2026→2026WK34
 *    - buildMachine 周轴不含内置旧周
 *    - EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致
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
const p0 = [], p1 = [];
function check(name, cond, detail, severity) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? '  — ' + detail : '')); }
  else {
    failed++;
    const sev = severity || 'P1';
    if (sev === 'P0') p0.push(name); else p1.push(name);
    console.log('[FAIL] ' + name + (detail ? '  — ' + detail : ''));
  }
}
function num(v) { if (v === null || v === undefined || v === '') return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function sum(arr) { return (arr || []).reduce(function (a, b) { return a + (Number(b) || 0); }, 0); }
function close(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }
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

/* ---------- vm 桩环境 ---------- */
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
const xlsxStub = { utils: xlsxUtils, read: function () { return { SheetNames: [], Sheets: {} }; } };

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
  FileReader: function FileReaderStub() {},
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null; },
    setItem: function (k, v) { localStorageStore[k] = String(v); }
  },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  console: console
};
sandbox.FileReader.prototype.readAsArrayBuffer = function (file) {
  const self = this;
  if (self.onload) self.onload({ target: { result: new Uint8Array([1, 2, 3]).buffer } });
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
['parseDetail', 'parseSchedule', 'parseBudget', 'buildMachine', 'buildVarieties', 'computeDetailRows', 'getState', 'getMappings', 'weekFromLineDate', 'mapMachineGroup'].forEach(f => {
  check('暴露函数 ' + f, typeof D[f] === 'function');
});

/* =========================================================================
 * 一、parseDetail 未排期过滤
 * ========================================================================= */
console.log('\n========== 一、parseDetail 未排期过滤 ==========');
(function testParseDetail() {
  // 注入主排程映射：BATCH001/BATCH002 有排期，NOSCHED001 查不到
  const M = D.getMappings();
  M.lineDate['BATCH001'] = '2026-08-27';
  M.lineDate['BATCH002'] = '2026-08-27';
  // 确保未排期批号不在映射里
  delete M.lineDate['NOSCHED001'];

  const expWeek = D.weekFromLineDate('2026-08-27');
  check('前置. 排期日期能补算出真实周', typeof expWeek === 'string' && /^\d{4}WK\d{1,2}$/.test(expWeek), expWeek);
  check('前置. 未排期批号补算为空', D.weekFromLineDate(D.getMappings().lineDate['NOSCHED001'] || '') === '', '');

  // 构造工单备料明细桩数据（23 列，0-based）
  function mkRow(B, Dv, Ev, H, I, J, L, N, Q) {
    const row = new Array(23).fill(null);
    row[1] = B;        // B 批号
    row[2] = '料号X';  // C 料号（不在 capacity 映射里，强制走直接列值）
    row[3] = Dv;       // D
    row[4] = Ev;       // E
    row[7] = H;        // H
    row[8] = I;        // I
    row[9] = J;        // J 工时（直接给值，便于精确断言）
    row[11] = L;       // L 扣库存
    row[13] = N;       // N 品种
    row[15] = null;    // P 留空 → 由 lineDate 补算
    row[16] = Q;       // Q 机台
    return row;
  }
  const aoa = [
    ['表头行1'],
    ['表头行2'],
    ['表头行3'],
    mkRow('BATCH001', '塑胶外壳类', 'DH888外壳A/ABS', 100, 100, 10, 100, '外壳A', '400T-550T'), // 排期
    mkRow('BATCH002', '塑胶外壳类', 'DH888外壳A/ABS', 200, 200, 5, 200, '外壳A', '400T-550T'),  // 排期
    mkRow('NOSCHED001', '塑胶外壳类', 'DH888外壳B/ABS', 300, 300, 999, 500, '外壳B', '400T-550T') // 未排期
  ];
  const detail = D.parseDetail(aoaToWs(aoa));
  check('1.1. parseDetail 返回非空', !!detail && !!detail.machine && !!detail.detailRows);

  if (detail && detail.machine) {
    const weeks = detail.machine.weeks;
    check('1.2. machine.weeks 不含 "未排期"', weeks.indexOf('未排期') < 0, JSON.stringify(weeks));
    check('1.3. machine.weeks 不含空串', weeks.indexOf('') < 0, JSON.stringify(weeks));
    check('1.4. machine.weeks 只含真实周且=1周', weeks.length === 1 && /^\d{4}WK\d{1,2}$/.test(weeks[0]), JSON.stringify(weeks));
    check('1.5. machine.weeks[0]=补算真实周', weeks[0] === expWeek, weeks[0] + ' vs ' + expWeek);

    const g = detail.machine.groups['400T-550T'];
    check('1.6. 400T-550T.real=[15]（10+5，未排期999不进入）', g && JSON.stringify(g.real) === JSON.stringify([15]),
      JSON.stringify(g && g.real));
    check('1.7. 其他组 real 全为 0', detail.machine.groups['230T-280T'] && sum(detail.machine.groups['230T-280T'].real) === 0);
  }

  if (detail && detail.detailRows) {
    const rows = detail.detailRows;
    check('1.8. detailRows 保留全部 3 行（数据源不丢失）', rows.length === 3, '实际 ' + rows.length);
    const unsched = rows[2];
    check('1.9. 未排期行 J 保留=999', unsched && unsched.J === 999, String(unsched && unsched.J));
    check('1.10. 未排期行 L 保留=500', unsched && unsched.L === 500, String(unsched && unsched.L));
    check('1.11. 未排期行 P 为空串', unsched && unsched.P === '', JSON.stringify(unsched && unsched.P));
    check('1.12. 排期行 P 补算为真实周', rows[0] && rows[0].P === expWeek && rows[1] && rows[1].P === expWeek,
      JSON.stringify([rows[0] && rows[0].P, rows[1] && rows[1].P]));
  }

  // buildVarieties 结果不含未排期
  if (detail && detail.detailRows) {
    const v = D.buildVarieties(detail.detailRows);
    check('1.13. buildVarieties.weeks 不含 "未排期"', v && v.weeks.indexOf('未排期') < 0, JSON.stringify(v && v.weeks));
    check('1.14. buildVarieties.weeks=[真实周]', v && JSON.stringify(v.weeks) === JSON.stringify([expWeek]), JSON.stringify(v && v.weeks));
    check('1.15. buildVarieties.varieties 不含未排期品种 "外壳B"', v && v.varieties.indexOf('外壳B') < 0, JSON.stringify(v && v.varieties));
    check('1.16. buildVarieties 只累加真实周工时 外壳A=15', v && v.data['外壳A'] && v.data['外壳A'][expWeek] === 15,
      JSON.stringify(v && v.data && v.data['外壳A']));
  }

  // 全链路：buildMachine(parseDetail.machine, 空预算) → state.machine.weeks
  if (detail && detail.machine) {
    const bm = D.buildMachine(detail.machine, {});
    check('1.17. buildMachine.weeks 不含 "未排期"/空串', bm && bm.weeks.indexOf('未排期') < 0 && bm.weeks.indexOf('') < 0, JSON.stringify(bm && bm.weeks));
    check('1.18. buildMachine.weeks=[真实周]', bm && JSON.stringify(bm.weeks) === JSON.stringify([expWeek]), JSON.stringify(bm && bm.weeks));
    check('1.19. buildMachine 400T-550T.real=[15]', bm && bm.groups['400T-550T'] && JSON.stringify(bm.groups['400T-550T'].real) === JSON.stringify([15]),
      JSON.stringify(bm && bm.groups['400T-550T'] && bm.groups['400T-550T'].real));
  }

  // 全链路：parseWorkbook 端到端
  const wb = { SheetNames: ['工单备料明细'], Sheets: { '工单备料明细': aoaToWs(aoa) } };
  let pw = null, pwerr = null;
  try { pw = D.parseWorkbook(wb); } catch (e) { pwerr = e.message; }
  check('1.20. parseWorkbook 正常返回', !pwerr && !!pw, pwerr);
  check('1.21. parseWorkbook.machine.weeks 不含 "未排期"', pw && pw.machine && pw.machine.weeks.indexOf('未排期') < 0, JSON.stringify(pw && pw.machine && pw.machine.weeks));
  check('1.22. parseWorkbook.varietyData.varieties 不含 "外壳B"', pw && pw.varietyData && pw.varietyData.varieties.indexOf('外壳B') < 0,
    JSON.stringify(pw && pw.varietyData && pw.varietyData.varieties));
})();

/* =========================================================================
 * 二、parseSchedule 动态列位
 * ========================================================================= */
console.log('\n========== 二、parseSchedule 动态列位 ==========');
(function testParseSchedule() {
  // 格式A：批号 A 列 / 上线日期 B 列
  const aoaA = [
    ['批号', '上线日期'],
    ['BATCH001', '2026-08-27'],
    ['BATCH002', '2026-08-28'],
    ['', '2026-08-29'],           // 空批号 → 跳过
    ['BATCH004', ''],             // 空日期 → 跳过
    ['', '']
  ];
  const mapA = D.parseSchedule(aoaToWs(aoaA));
  check('2.1. 格式A 解析出 2 条', mapA && Object.keys(mapA).length === 2, JSON.stringify(mapA));
  check('2.2. 格式A BATCH001=2026-08-27', mapA && mapA['BATCH001'] === '2026-08-27', mapA && mapA['BATCH001']);
  check('2.3. 格式A BATCH002=2026-08-28', mapA && mapA['BATCH002'] === '2026-08-28', mapA && mapA['BATCH002']);
  check('2.4. 格式A 空批号/空日期行未混入', mapA && mapA['BATCH004'] === undefined && Object.keys(mapA).indexOf('') < 0);

  // 格式B：批号 B 列 / 上线日期 C 列（前面还有"序号"干扰列）
  const aoaB = [
    ['主排程表'],                // 标题行（含"排程"但无订单关键词 → 应跳过）
    ['序号', '批号', '上线日期'],
    ['1', 'BATCH010', '2026-09-01'],
    ['2', 'BATCH011', '2026-09-02'],
    ['3', '', '2026-09-03']      // 空批号 → 跳过
  ];
  const mapB = D.parseSchedule(aoaToWs(aoaB));
  check('2.5. 格式B 动态定位列位解析出 2 条', mapB && Object.keys(mapB).length === 2, JSON.stringify(mapB));
  check('2.6. 格式B BATCH010=2026-09-01', mapB && mapB['BATCH010'] === '2026-09-01', mapB && mapB['BATCH010']);
  check('2.7. 格式B BATCH011=2026-09-02', mapB && mapB['BATCH011'] === '2026-09-02', mapB && mapB['BATCH011']);
  check('2.8. 格式B 空批号行未混入', mapB && Object.keys(mapB).indexOf('') < 0);

  // 空表 / 无表头：兜底不崩溃
  let mapC = null, errC = null;
  try { mapC = D.parseSchedule(aoaToWs([[], []])); } catch (e) { errC = e.message; }
  check('2.9. 空表 parseSchedule 不崩溃', !errC, errC);
  check('2.10. 空表返回空映射', mapC && Object.keys(mapC).length === 0, JSON.stringify(mapC));
})();

/* =========================================================================
 * 三、回归
 * ========================================================================= */
console.log('\n========== 三、回归 ==========');
(function testRegression() {
  // R1. EMBEDDED_ANALYSIS 深度一致
  check('R1. EMBEDDED_ANALYSIS 深度一致', JSON.stringify(canonical(EMB_ANALYSIS)) === JSON.stringify(canonical(analysisRef)), '', 'P0');

  // R2. parseBudget：H列分组 / 偶数列工时 / 34.2026→2026WK34
  (function () {
    const aoa = [];
    for (let r = 0; r < 9; r++) aoa.push(new Array(15).fill(null));
    aoa[3][0] = '料号'; aoa[3][7] = '机台';
    aoa[3][11] = '34.2026'; aoa[3][12] = '34.2026需求';
    aoa[3][13] = '35.2026'; aoa[3][14] = '35.2026需求';
    aoa[4][0] = '5010000003'; aoa[4][7] = '400T-550T';
    aoa[4][11] = 100; aoa[4][12] = 5.5; aoa[4][13] = 200; aoa[4][14] = 7.5;
    aoa[5][0] = '5010000004'; aoa[5][7] = '90T';
    aoa[5][11] = 300; aoa[5][12] = 10.5; aoa[5][13] = 400; aoa[5][14] = 12.5;
    aoa[6][0] = '150T'; aoa[6][7] = '230T-260T'; // A列放"150T"文字，机台读 H 列
    aoa[6][11] = 50; aoa[6][12] = 3.5; aoa[6][13] = 60; aoa[6][14] = 4.5;
    aoa[7][0] = '5010000005'; aoa[7][7] = '150T';
    aoa[7][11] = 70; aoa[7][12] = 6.5; aoa[7][13] = 80; aoa[7][14] = 8.5;
    aoa[8][0] = '5010000006'; aoa[8][7] = '260T';
    aoa[8][11] = 90; aoa[8][12] = 1.5; aoa[8][13] = 100; aoa[8][14] = 2.5;
    const res = D.parseBudget(aoaToWs(aoa));
    const budget = (res && res.budget) || {};
    check('R2. parseBudget 返回非空', !!res && !!res.budget);
    check('R2. 周号 34.2026→2026WK34', !!budget['400T-550T'] && !!budget['400T-550T']['2026WK34'] && !!budget['400T-550T']['2026WK35'],
      JSON.stringify(Object.keys(budget['400T-550T'] || {})));
    check('R2. 400T-550T.WK34=5.5（工时非数量）', close(budget['400T-550T'] && budget['400T-550T']['2026WK34'], 5.5));
    check('R2. 230T-260T/260T→230T-280T 累加 WK34=5.0', close(budget['230T-280T'] && budget['230T-280T']['2026WK34'], 5.0));
    check('R2. 150T.WK34=6.5', close(budget['150T'] && budget['150T']['2026WK34'], 6.5));
    check('R2. 90T.WK34=10.5', close(budget['90T'] && budget['90T']['2026WK34'], 10.5));
    check('R2. 无"其他"组', !budget['其他'], JSON.stringify(Object.keys(budget)));
  })();

  // R3. buildMachine 周轴不含内置旧周
  (function () {
    const detailMachine = { weeks: ['2026WK34', '2026WK35'], groups: { '400T-550T': { real: [10, 20] } } };
    const out = D.buildMachine(detailMachine, { '400T-550T': { '2026WK34': 5 } });
    check('R3. buildMachine.weeks 仅上传两周', out && JSON.stringify(out.weeks) === JSON.stringify(['2026WK34', '2026WK35']), JSON.stringify(out && out.weeks));
    check('R3. weeks 不含内置旧周 2026WK32/2027WK16', out && out.weeks.indexOf('2026WK32') < 0 && out.weeks.indexOf('2027WK16') < 0);
    check('R3. 400T-550T.cap6 内置固定 [1320,1320]', out && JSON.stringify(out.groups['400T-550T'].cap6) === JSON.stringify([1320, 1320]));
    let out2 = null, err2 = null;
    try { out2 = D.buildMachine(null, {}); } catch (e) { err2 = e.message; }
    check('R3. 空上传不崩溃且回退内置 38 周', !err2 && out2 && out2.weeks && out2.weeks.length === 38, err2);
  })();

  // R4. computeDetailRows 300 行基线 J/K/L/W
  (function () {
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
    let result = null;
    try { result = D.computeDetailRows(buildAoa(testdata)); } catch (e) { check('R4. computeDetailRows 正常返回', false, e.message, 'P0'); }
    check('R4. computeDetailRows 正常返回', !!result && Array.isArray(result.rows), '', 'P0');
    if (result && result.rows) {
      check('R4. 输出行数=300', result.rows.length === 300, '实际 ' + result.rows.length, 'P0');
      const out = result.rows;
      let jBad = 0, kBad = 0, lBad = 0, wBad = 0;
      for (let i = 0; i < out.length; i++) {
        const o = out[i], td = testdata[i];
        if (o.K !== td.K) kBad++;
        if (o.L !== td.L) lBad++;
        if (Math.round((o.J || 0) * 100) !== Math.round((td.J || 0) * 100)) jBad++;
        if (Math.abs((o.W || 0) - (td.W || 0)) > 1e-6) wBad++;
      }
      check('R4. K 300/300 一致', kBad === 0, kBad + ' 行不一致', 'P0');
      check('R4. L 300/300 一致', lBad === 0, lBad + ' 行不一致', 'P0');
      check('R4. J 300/300 一致(±0.005)', jBad === 0, jBad + ' 行不一致', 'P0');
      check('R4. W 300/300 一致(±1e-6)', wBad === 0, wBad + ' 行不一致', 'P0');
    }
  })();
})();

/* ========================================================================= */
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) {
  console.log('P0 失败：' + (p0.length ? '\n  - ' + p0.join('\n  - ') : '无'));
  console.log('P1 失败：' + (p1.length ? '\n  - ' + p1.join('\n  - ') : '无'));
  process.exit(1);
} else {
  console.log('全部通过。');
}
