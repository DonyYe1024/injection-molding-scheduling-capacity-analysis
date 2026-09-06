'use strict';
/* =========================================================================
 * QA 校验脚本 13：《改善08-30版-2》独立验证（QA 全新视角，不采信工程师自查）
 * 验证范围：
 *   1. 死代码删除（weekCompare / getCurrentWeek）无副作用
 *   2. 全量注释未破坏代码（vm.Script 语法 + 桩环境跑 init + 注释纯注释 + 4 常量合法 JSON）
 *   3. 金标准回归（computeDetailRows 300/300 等）
 *   4. CSS 微调（meta-gauge 居中 / 月历深色文字）
 *   5. 说明文档存在且合法
 * 运行：NODE_OPTIONS= node 13_verify_improvements_08_30.js
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'D:/WorkBuddy工作资料/injection_dashboard';
const HTML = path.join(ROOT, 'index.html');
const BACKUP = path.join(ROOT, 'index_backup_20260830.html');
const README = path.join(ROOT, 'README_项目说明.html');
const TESTDATA = path.join(ROOT, '_qa_check/testdata.json');
const ANALYSIS_JSON = path.join(ROOT, 'analysis_data.json');
const GAP_JSON = path.join(ROOT, 'gap_material_data.json');
const DATA_JSON = path.join(ROOT, 'data.json');
const MAPPINGS_JSON = path.join(ROOT, 'mappings.json');

const html = fs.readFileSync(HTML, 'utf8');
const backup = fs.readFileSync(BACKUP, 'utf8');

let total = 0, passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail != null ? '  — ' + detail : '')); }
  else { failed++; failures.push(name); console.log('[FAIL] ' + name + (detail != null ? '  — ' + detail : '')); }
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------- 抽取内联脚本（无 src 的 <script>） ----------
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
console.log('========== 验证点1：死代码删除无副作用 ==========');
(function testDeadCode() {
  check('1. 当前 index.html 无 weekCompare 残留', html.indexOf('weekCompare') < 0);
  check('1. 当前 index.html 无 getCurrentWeek 残留', html.indexOf('getCurrentWeek') < 0);
  check('1. 备份文件确实含 weekCompare（证明是被删除而非本不存在）', backup.indexOf('weekCompare') >= 0);
  check('1. 备份文件确实含 getCurrentWeek（证明是被删除而非本不存在）', backup.indexOf('getCurrentWeek') >= 0);
  // excelWeekNum 是 getCurrentWeek 的依赖，且仍被其它代码使用，必须保留
  check('1. excelWeekNum 仍保留（它被 weekFromLineDate/月历/导出引用）', html.indexOf('function excelWeekNum') >= 0 && /excelWeekNum:\s*excelWeekNum/.test(html));
})();

// =========================================================================
console.log('\n========== 验证点2：注释未破坏代码（语法 + 桩环境跑 init） ==========');

// ---------- 2a. vm.Script 编译两个内联脚本 ----------
(function testSyntax() {
  let ok1 = true, e1 = '';
  try { new vm.Script(dataScript, { filename: 'data.js' }); } catch (e) { ok1 = false; e1 = e.message; }
  check('2a. 数据 script 块 vm.Script 编译通过', ok1, e1);
  let ok2 = true, e2 = '';
  try { new vm.Script(logicScript, { filename: 'logic.js' }); } catch (e) { ok2 = false; e2 = e.message; }
  check('2a. 逻辑 IIFE vm.Script 编译通过', ok2, e2);
})();

// ---------- 2b. 注释纯注释（无夹带可执行语句） ----------
(function testCommentsPure() {
  // 抽取全部块注释与行注释，检查平衡与夹带
  const blocks = logicScript.match(/\/\*[\s\S]*?\*\//g) || [];
  // 注：注释正文里可能出现 glob 模式（如 _qa_check/*.js）导致 /* 出现在注释内，
  // 这是无害的（JS 块注释不嵌套，vm.Script 编译已在 2a 证明语法合法），此处不做嵌套误判。
  check('2b. 块注释已存在（全量注释）', blocks.length > 0, blocks.length + ' 个块注释');

  // 夹带检测：注释里若含分号赋值语句 + 关键字，视为夹带可疑（启发式，只要不误报即可）
  const suspicious = [];
  for (const b of blocks) {
    if (/\b(?:window|document|state|MAPPINGS)\s*\.\s*\w+\s*=/.test(b)) suspicious.push('块注释夹带赋值');
    if (/\b(?:function|var|const|let)\s+\w+\s*\(/.test(b)) suspicious.push('块注释夹带声明');
  }
  check('2b. 注释未夹带可执行赋值/声明', suspicious.length === 0, suspicious.join(';') || '无');

  // 校验注释确实新增了（对比备份），证明工程师做了全量注释
  const backupBlocks = (backup.match(/\/\*[\s\S]*?\*\//g) || []).length;
  check('2b. 注释量较备份显著增加（全量注释已落实）', blocks.length > backupBlocks, '当前块注释 ' + blocks.length + ' 个 vs 备份 ' + backupBlocks + ' 个');
})();

// ---------- 2c. 四个 EMBEDDED 常量合法 JSON 且数据完整 ----------
(function testEmbeddedJson() {
  // 用 vm 执行数据脚本 + 末尾把 4 常量挂到 globalThis（const 在 vm 中为脚本作用域，不会自动挂到 context）
  const dataCtx = {};
  vm.createContext(dataCtx);
  const expose = '\n;globalThis.__EMB = { DATA: EMBEDDED_DATA, MAPPINGS: EMBEDDED_MAPPINGS, ANALYSIS: EMBEDDED_ANALYSIS, GAP: EMBEDDED_GAP };';
  try { vm.runInContext(dataScript + expose, dataCtx, { filename: 'data.js' }); }
  catch (e) { check('2c. 数据 script 可执行（4 常量定义合法）', false, e.message); return; }

  const names = ['DATA', 'MAPPINGS', 'ANALYSIS', 'GAP'];
  for (const n of names) {
    const v = dataCtx.__EMB && dataCtx.__EMB[n];
    check('2c. EMBEDDED_' + n + ' 已定义且为对象', !!v && typeof v === 'object' && !Array.isArray(v));
    // 能 JSON.stringify 且 round-trip 不丢 = 无 undefined/NaN/循环引用
    let roundTripOk = false;
    try { roundTripOk = deepEq(JSON.parse(JSON.stringify(v)), v); } catch (e) { roundTripOk = false; }
    check('2c. EMBEDDED_' + n + ' 可 JSON 序列化 round-trip 无损', roundTripOk);
  }

  // 数据完整性：结构键 + 规模
  const D = dataCtx.__EMB.DATA;
  check('2c. EMBEDDED_DATA 含 meta/machine/mold', D && D.meta && D.machine && D.mold);
  check('2c. EMBEDDED_DATA.machine 5 组', D && D.machine && D.machine.groups && Object.keys(D.machine.groups).length === 5, D && Object.keys(D.machine.groups).join(','));
  const M = dataCtx.__EMB.MAPPINGS;
  check('2c. EMBEDDED_MAPPINGS 含 capacity/bom/lineDate', M && M.capacity && M.bom && M.lineDate);
  check('2c. EMBEDDED_MAPPINGS.capacity 非空', M && M.capacity && Object.keys(M.capacity).length > 0);
  const A = dataCtx.__EMB.ANALYSIS;
  check('2c. EMBEDDED_ANALYSIS.machine 38 周', A && A.machine && A.machine.weeks && A.machine.weeks.length === 38, A && A.machine.weeks.length);
  check('2c. EMBEDDED_ANALYSIS.machine 5 组', A && A.machine.groups && Object.keys(A.machine.groups).length === 5);
  const G = dataCtx.__EMB.GAP;
  check('2c. EMBEDDED_GAP 含 gap/material/stock', G && G.gap && G.material && G.stock);

  // 与外部 JSON 深度一致（金标准要求的两个）
  const analysisRef = JSON.parse(fs.readFileSync(ANALYSIS_JSON, 'utf8'));
  const gapRef = JSON.parse(fs.readFileSync(GAP_JSON, 'utf8'));
  check('2c. EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致', deepEq(A, analysisRef));
  check('2c. EMBEDDED_GAP 与 gap_material_data.json 深度一致', deepEq(G, gapRef));

  // 额外：MAPPINGS 与外部 JSON 深度对比；DATA 因 data.json 是超集（含 backlog/meta.totalOrders 未注入）只比对共享字段
  try {
    const mapRef = JSON.parse(fs.readFileSync(MAPPINGS_JSON, 'utf8'));
    check('2c. EMBEDDED_MAPPINGS 与 mappings.json 深度一致', deepEq(M, mapRef));
  } catch (e) { check('2c. EMBEDDED_MAPPINGS 与 mappings.json 深度一致', false, '读取失败 ' + e.message); }
  try {
    const dataRef = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
    const shared = ['machine', 'mold', 'material', 'productionValue'];
    let ok = true;
    for (const k of shared) if (!deepEq(D[k], dataRef[k])) ok = false;
    ok = ok && D.meta.generatedAt === dataRef.meta.generatedAt && D.meta.source === dataRef.meta.source && deepEq(D.meta.machineGroups, dataRef.meta.machineGroups);
    check('2c. EMBEDDED_DATA 与 data.json 共享字段一致（data.json 为超集，含未注入的 backlog/totalOrders）', ok);
  } catch (e) { check('2c. EMBEDDED_DATA 与 data.json 共享字段一致', false, '读取失败 ' + e.message); }
})();

// ---------- 2d. 桩环境加载逻辑 IIFE + init，state.machine = 5×38 ----------
let Dbg = null, state = null;
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
  const echartsStub = { getInstanceByDom: function (el) { return el.__echart || null; }, init: function (el) { const c = { setOption: function (o) { el.__echartOption = o; }, clear: function () {}, resize: function () {} }; el.__echart = c; return c; } };
  const els = {};
  function getEl(id) { if (els[id] === undefined) els[id] = makeEl(id); return els[id]; }
  const kpiStore = { month: '', days: '', shell: '', value: '' };
  function kpiInputEl(key) { const el = makeEl('kpiinput-' + key); Object.defineProperty(el, 'value', { get: function () { return kpiStore[key] == null ? '' : String(kpiStore[key]); }, set: function (v) { kpiStore[key] = v; }, enumerable: true, configurable: true }); return el; }
  const localStorageStore = {};
  const sandbox = {
    window: { echarts: echartsStub, XLSX: xlsxStub, addEventListener: function () {} },
    document: { readyState: 'complete', addEventListener: function (t, fn) { if (t === 'DOMContentLoaded') fn(); }, getElementById: function (id) { return getEl(id); }, querySelector: function (sel) { const m = String(sel).match(/^#kpiGrid\s+input\[data-key="([^"]+)"\]$/); if (m) return kpiInputEl(m[1]); return null; }, querySelectorAll: function () { return []; }, body: getEl('body') },
    FileReader: function () {},
    localStorage: { getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null; }, setItem: function (k, v) { localStorageStore[k] = String(v); }, removeItem: function (k) { delete localStorageStore[k]; } },
    setTimeout: setTimeout, clearTimeout: clearTimeout, console: console
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(dataScript + '\n;\n' + logicScript, sandbox, { filename: 'logic.js' });
    check('2d. 桩环境加载逻辑 IIFE + init 无异常', true);
  } catch (e) {
    check('2d. 桩环境加载逻辑 IIFE + init 无异常', false, e.message);
    return;
  }
  Dbg = sandbox.window && sandbox.window.__injectionDebug;
  check('2d. __injectionDebug 已暴露', !!Dbg);
  if (Dbg && typeof Dbg.getState === 'function') {
    state = Dbg.getState();
    const g = state && state.machine && state.machine.groups;
    const nGroups = g ? Object.keys(g).length : 0;
    const nWeeks = (state && state.machine && state.machine.weeks) ? state.machine.weeks.length : 0;
    check('2d. state.machine = 5 组 × 38 周', nGroups === 5 && nWeeks === 38, '组=' + nGroups + ' 周=' + nWeeks);
    if (g) {
      for (const k of Object.keys(g)) {
        const grp = g[k];
        const lens = ['real', 'cap6', 'cap7', 'budget'].map(f => (grp[f] || []).length);
        check('2d. 组 ' + k + ' real/cap6/cap7/budget 各 38', lens.every(l => l === 38), lens.join('/'));
      }
    }
  }
})();

// =========================================================================
console.log('\n========== 验证点3：金标准回归（computeDetailRows 300 等，独立重验） ==========');
(function testGoldRegression() {
  if (!Dbg) { check('3. 前置：__injectionDebug 可用', false); return; }

  // computeDetailRows 300/300
  const testdata = JSON.parse(fs.readFileSync(TESTDATA, 'utf8')).rows;
  function buildAoa(rows) {
    // computeDetailRows 固定跳过前 3 行表头，故补 3 个表头条目（与真实 Excel 3 行表头一致）
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
  check('3. computeDetailRows 返回 300 行', !!result && result.rows.length === 300);
  if (result && result.rows) {
    let bad = 0, badJ = 0, badK = 0, badL = 0, badW = 0;
    for (let i = 0; i < result.rows.length; i++) {
      const o = result.rows[i], td = testdata[i];
      if (o.K !== td.K) badK++;
      if (o.L !== td.L) badL++;
      if (Math.abs((o.W || 0) - (td.W || 0)) > 1e-6) badW++;
      if (Math.round((o.J || 0) * 100) !== Math.round((td.J || 0) * 100)) badJ++;
    }
    bad = badJ + badK + badL + badW;
    check('3. J/K/L/W 300/300 一致', bad === 0, 'J=' + badJ + ' K=' + badK + ' L=' + badL + ' W=' + badW);
  }

  // mapMachineGroup
  check('3. mapMachineGroup(150T-280T) 正常', Dbg.mapMachineGroup('150T-280T') === '150T-280T');
  check('3. mapMachineGroup(400T/550T) 正常', Dbg.mapMachineGroup('400T/550T') === '400T-550T');
  check('3. mapMachineGroup(230T/280T) 正常', Dbg.mapMachineGroup('230T/280T') === '230T-280T');

  // parseAnalysis2/3 可调用且固定列
  check('3. parseAnalysis2/parseAnalysis3 可调用', typeof Dbg.parseAnalysis2 === 'function' && typeof Dbg.parseAnalysis3 === 'function');

  // parseDetail 未排期行不进机台图
  function colIdxToLetter(c) { let s = ''; c = c + 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
  function aoaToWs(aoa) { const nrows = aoa.length; let ncols = 0; for (const r of aoa) ncols = Math.max(ncols, r.length); const ws = { '!ref': 'A1:' + colIdxToLetter(ncols - 1) + nrows }; for (let r = 0; r < nrows; r++) { const row = aoa[r]; for (let c = 0; c < row.length; c++) { const v = row[c]; if (v === null || v === undefined) continue; ws[colIdxToLetter(c) + (r + 1)] = { v: v }; } } return ws; }
  const detAoa = [];
  for (let i = 0; i < 3; i++) detAoa.push(new Array(23).fill(null));
  const d1 = new Array(23).fill(null); d1[1] = 'B1'; d1[2] = 'C1'; d1[3] = 'D1'; d1[4] = 'E1'; d1[7] = 10; d1[8] = 0; d1[9] = 5; d1[11] = 100; d1[15] = '2026WK34'; d1[16] = '400T-550T'; detAoa.push(d1);
  const d2 = new Array(23).fill(null); d2[1] = 'B2'; d2[2] = 'C2'; d2[3] = 'D2'; d2[4] = 'E2'; d2[7] = 20; d2[8] = 0; d2[9] = 7; d2[11] = 200; d2[15] = '未排期'; d2[16] = '400T-550T'; detAoa.push(d2);
  const pd = Dbg.parseDetail(aoaToWs(detAoa));
  check('3. parseDetail 未排期行不进机台图（weeks 仅 WK34）', pd && pd.machine.weeks.length === 1 && pd.machine.weeks[0] === '2026WK34', pd && JSON.stringify(pd.machine.weeks));
  check('3. parseDetail 未排期行不进机台图（real 仅 1 值=5）', pd && pd.machine.groups['400T-550T'].real.length === 1 && pd.machine.groups['400T-550T'].real[0] === 5, pd && JSON.stringify(pd.machine.groups['400T-550T'].real));
})();

// =========================================================================
console.log('\n========== 验证点4：CSS 微调 ==========');
(function testCss() {
  // .meta-gauge 居中（flex column + align-items center）
  const metaGauge = (html.match(/\.meta-gauge\s*\{[^}]*\}/) || [''])[0];
  check('4. .meta-gauge display:flex', /display:\s*flex/.test(metaGauge));
  check('4. .meta-gauge flex-direction:column', /flex-direction:\s*column/.test(metaGauge));
  check('4. .meta-gauge align-items:center', /align-items:\s*center/.test(metaGauge));
  const capNote = (html.match(/\.gauge-caption-note\s*\{[^}]*\}/) || [''])[0];
  check('4. .gauge-caption-note text-align:center', /text-align:\s*center/.test(capNote));

  // 月历深色文字（浅色渐变背景）
  const calCell = (html.match(/\.cal-cell\s*\{[^}]*\}/) || [''])[0];
  const calTitle = (html.match(/\.cal-title\s*\{[^}]*\}/) || [''])[0];
  const calNav = (html.match(/\.cal-nav\s*\{[^}]*\}/) || [''])[0];
  check('4. .cal-cell color 为深色 #1a1a1a', /color:\s*#1a1a1a/.test(calCell));
  check('4. .cal-title color 为深色 #1a1a1a', /color:\s*#1a1a1a/.test(calTitle));
  check('4. .cal-nav color 为深色 #1a1a1a', /color:\s*#1a1a1a/.test(calNav));

  // 周日红色 / 法定节假日红底白字
  const calSun = (html.match(/\.cal-sun\s*\{[^}]*\}/) || [''])[0];
  const calHoliday = (html.match(/\.cal-holiday\s*\{[^}]*\}/) || [''])[0];
  check('4. .cal-sun color 红色 #d32f2f', /color:\s*#d32f2f/.test(calSun));
  check('4. .cal-holiday 红底 #e5533c', /background:\s*#e5533c/.test(calHoliday));
  check('4. .cal-holiday 白字 #fff', /color:\s*#fff/.test(calHoliday));

  // 月历浅色渐变背景（改善08-30版-1）
  const metaCal = (html.match(/\.meta-calendar\s*\{[^}]*\}/) || [''])[0];
  check('4. .meta-calendar 浅蓝浅绿渐变背景', /linear-gradient\(135deg/.test(metaCal) && /rgba\(120,\s*190,\s*255/.test(metaCal) && /rgba\(120,\s*220,\s*190/.test(metaCal));
  // 改善08-30版-1 改善2：cal-spacer 已删除
  check('4. cal-spacer 已删除（改善08-30版-1）', html.indexOf('cal-spacer') < 0);
})();

// =========================================================================
console.log('\n========== 验证点5：说明文档 ==========');
(function testReadme() {
  const exists = fs.existsSync(README);
  check('5. README_项目说明.html 存在', exists);
  if (!exists) return;
  const rd = fs.readFileSync(README, 'utf8');
  const hasDoctype = /^<!DOCTYPE html>/i.test(rd.trim());
  const hasHtmlClose = /<\/html>\s*$/i.test(rd.trim());
  const hasZh = /[\u4e00-\u9fa5]/.test(rd);
  check('5. 合法 HTML（DOCTYPE 开头 + </html> 结尾）', hasDoctype && hasHtmlClose);
  check('5. 含中文', hasZh);
  const chapters = ['项目概览', '文件结构', '内置数据', '模块清单', '业务规则', '函数索引', '增删', '维护', '回滚'];
  let missing = [];
  for (const c of chapters) if (rd.indexOf(c) < 0) missing.push(c);
  check('5. 章节齐全（概览/结构/数据/模块/规则/索引/增删/维护/回滚）', missing.length === 0, missing.length ? '缺：' + missing.join(',') : '齐全');
  check('5. 提及备份文件 index_backup_20260830.html', rd.indexOf('index_backup_20260830.html') >= 0);
  // 平衡标签抽查（section 闭合）
  const openSec = (rd.match(/<section/g) || []).length;
  const closeSec = (rd.match(/<\/section>/g) || []).length;
  check('5. <section> 标签配对', openSec === closeSec && openSec > 0, openSec + '/' + closeSec);
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);
