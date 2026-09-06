'use strict';
/* =========================================================================
 * QA 校验脚本 06：《改善08-26版-1》5 项调整 独立复验（真实执行，全新视角）
 *  改善1  buildTop10Option  → 饼图 + label（品种+占比%+数字PCS）+ 占比1位小数
 *  改善2  buildVarietyOption → 模具产能折线按套数(1/2/3/>3)分层着色与数值
 *  改善3  buildMachineOption → 6天产能=黄 / 7天产能=红
 *  改善4  renderMeta         → 仅一行「注塑备料明细 + 更新:日期」，无预算行/无 budgetDateInput
 *  改善5  renderKPI          → 4 格 + 标签/单位正确 + 字体加粗统一
 *  回归   computeDetailRows 300 行金标准 J/K/L/W；EMBEDDED_ANALYSIS 深度一致；mapMachineGroup
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

// ---------- vm 桩环境 ----------
const xlsxUtils = {
  decode_range() { return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }; },
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
['buildTop10Option', 'buildVarietyOption', 'buildMachineOption', 'renderMeta', 'renderKPI', 'getState'].forEach(f => {
  check('暴露函数 ' + f, typeof D[f] === 'function');
});
const STATE = D.getState();

// =========================================================================
console.log('\n========== 改善1：前十占比 → 饼图 ==========');
(function testTop10() {
  // 构造 12 条（验证排序 + 截断到前10），pcs 1..12
  function mk(arrPcs, prefix) {
    return arrPcs.map((p, i) => ({ name: prefix + (i + 1), pcs: p, amount: p * 10 }));
  }
  const shell = mk([1, 12, 3, 10, 5, 8, 7, 6, 9, 4, 11, 2], '外壳');
  const acc = mk([50, 45, 40, 35, 30, 25, 20, 15, 10, 5], '配件'); // 恰好10条

  function verify(arr, label) {
    const opt = D.buildTop10Option(arr);
    check(label + ' 返回非空', !!opt && !!opt.series && opt.series.length === 1);
    if (!opt || !opt.series) return;
    const s = opt.series[0];
    check(label + ' series.type = pie', s.type === 'pie', s.type);
    check(label + ' 数据截断为前10条', s.data.length === 10, '实际 ' + s.data.length);
    // 按 pcs 降序排列
    let sorted = true;
    for (let i = 1; i < s.data.length; i++) if (num(s.data[i].value) > num(s.data[i - 1].value)) sorted = false;
    check(label + ' 按 PCS 降序', sorted);
    // 占比计算：总=前10 PCS 合计，pct = item/total*100 toFixed(1)
    const totalPcs = s.data.reduce((a, b) => a + num(b.value), 0);
    let pctOk = true, detail = '';
    for (const d of s.data) {
      const exp = (num(d.value) / totalPcs * 100).toFixed(1);
      if (d.pct !== exp) { pctOk = false; detail = d.name + ' pct=' + d.pct + ' exp=' + exp; break; }
    }
    check(label + ' 占比=单项/前10合计×100% 保留1位小数', pctOk, detail || 'total=' + totalPcs);
    check(label + ' label.formatter 为函数', typeof s.label === 'object' && typeof s.label.formatter === 'function');
    // 逐个验证 label 输出含「品种 + 百分号 + PCS 数字」
    let lblOk = true, lblBad = '';
    for (const d of s.data) {
      const out = s.label.formatter({ data: d });
      const hasName = out.indexOf(d.name) >= 0;
      const hasPct = out.indexOf(d.pct + '%') >= 0;
      const hasPcs = /PCS/.test(out) && out.indexOf(String(num(d.value))) >= 0;
      if (!hasName || !hasPct || !hasPcs) { lblOk = false; lblBad = JSON.stringify({ name: d.name, out }); break; }
    }
    check(label + ' label 输出含品种+占比%+数字PCS', lblOk, lblBad || s.data[0] && s.label.formatter({ data: s.data[0] }));
    return opt;
  }
  verify(shell, '外壳');
  verify(acc, '配件');

  // 边界：空数组 → 不抛错，data 为空，无 NaN
  const optEmpty = D.buildTop10Option([]);
  check('空数组返回非空且无 NaN', !!optEmpty && optEmpty.series[0].data.length === 0);
})();

// =========================================================================
console.log('\n========== 改善2：模具产能折线按套数着色 ==========');
(function testVariety() {
  // 准备 state.varietyData（2 周）
  STATE.varietyData = {
    varieties: ['外壳A'],
    weeks: ['2026WK32', '2026WK33'],
    data: { '外壳A': { '2026WK32': 10, '2026WK33': 20 } }
  };
  STATE.activeVariety = '外壳A';
  const C = 132; // 每套产能参考 132h

  function capLines(opt) {
    // series = [实单工时(bar)] + 产能参考 line...
    return opt.series.slice(1);
  }
  function expectLine(ln, name, color, val) {
    check('   线[' + name + '] type=line', ln.type === 'line', ln.type);
    check('   线[' + name + '] color=' + color, ln.lineStyle && ln.lineStyle.color === color && ln.itemStyle && ln.itemStyle.color === color,
      JSON.stringify(ln.lineStyle) + ' / ' + JSON.stringify(ln.itemStyle));
    check('   线[' + name + '] 虚线', ln.lineStyle && ln.lineStyle.type === 'dashed');
    check('   线[' + name + '] 数值=' + val, ln.data.every(v => v === val), JSON.stringify(ln.data));
  }

  // 套数 1
  let opt = D.buildVarietyOption('外壳A', 1, C);
  check('套数1 返回非空', !!opt && !!opt.series);
  let lines = capLines(opt);
  check('套数1 → 1 条折线', lines.length === 1, '实际 ' + lines.length);
  if (lines.length === 1) expectLine(lines[0], '套1', '#e53935', 132);

  // 套数 2
  opt = D.buildVarietyOption('外壳A', 2, C);
  lines = capLines(opt);
  check('套数2 → 2 条折线', lines.length === 2, '实际 ' + lines.length);
  if (lines.length === 2) {
    expectLine(lines[0], '下', '#fbc02d', 132); // 黄 132h
    expectLine(lines[1], '上', '#e53935', 264); // 红 264h
  }

  // 套数 3
  opt = D.buildVarietyOption('外壳A', 3, C);
  lines = capLines(opt);
  check('套数3 → 3 条折线', lines.length === 3, '实际 ' + lines.length);
  if (lines.length === 3) {
    expectLine(lines[0], '下', '#43a047', 132); // 绿 132h
    expectLine(lines[1], '中', '#fbc02d', 264); // 黄 264h
    expectLine(lines[2], '上', '#e53935', 396); // 红 396h
  }

  // 套数 4（>3）
  opt = D.buildVarietyOption('外壳A', 4, C);
  lines = capLines(opt);
  check('套数4(>3) → 1 条折线', lines.length === 1, '实际 ' + lines.length);
  if (lines.length === 1) {
    expectLine(lines[0], '>3', '#81d4fa', 4 * C); // 浅蓝 528h
  }
})();

// =========================================================================
console.log('\n========== 改善3：机台产能折线颜色 ==========');
(function testMachine() {
  // 用内置真实组（150T-280T 存在）
  const opt = D.buildMachineOption('150T-280T');
  check('buildMachineOption(150T-280T) 返回非空', !!opt && !!opt.series);
  if (opt && opt.series) {
    check('series 含 4 项（实单bar/预算bar/6天线/7天线）', opt.series.length === 4, '实际 ' + opt.series.length);
    const c6 = opt.series[2], c7 = opt.series[3];
    check('6天产能 type=line', c6 && c6.type === 'line');
    check('6天产能 黄色 #fbc02d', c6 && c6.lineStyle && c6.lineStyle.color === '#fbc02d' && c6.itemStyle && c6.itemStyle.color === '#fbc02d',
      c6 && JSON.stringify(c6.lineStyle));
    check('7天产能 type=line', c7 && c7.type === 'line');
    check('7天产能 红色 #e53935', c7 && c7.lineStyle && c7.lineStyle.color === '#e53935' && c7.itemStyle && c7.itemStyle.color === '#e53935',
      c7 && JSON.stringify(c7.lineStyle));
  }
})();

// =========================================================================
console.log('\n========== 改善4：metaLine 精简 ==========');
(function testMeta() {
  STATE.detailDate = '2026-08-26';
  D.renderMeta();
  const metaHtml = els['metaLine'].innerHTML;
  check('metaLine 非空', metaHtml.length > 0);
  check('metaLine 含「注塑备料明细」', metaHtml.indexOf('注塑备料明细') >= 0, metaHtml);
  check('metaLine 含「更新：」+ 日期', metaHtml.indexOf('更新：2026-08-26') >= 0, metaHtml);
  check('metaLine 仅 1 行 meta-row', (metaHtml.match(/meta-row/g) || []).length === 1, metaHtml);
  check('metaLine 无「预算」字样', metaHtml.indexOf('预算') < 0, metaHtml);
  check('metaLine 无「最新DKL预算」', metaHtml.indexOf('最新DKL预算') < 0);
  // 全文级
  check('HTML 全文无「最新DKL预算」残留', html.indexOf('最新DKL预算') < 0);
  check('HTML 全文无 budgetDateInput 元素', html.indexOf('budgetDateInput') < 0);
})();

// =========================================================================
console.log('\n========== 改善5：KPI 4 格 + 字体 ==========');
(function testKPI() {
  D.renderKPI();
  const kpiHtml = els['kpiGrid'].innerHTML;
  const cards = (kpiHtml.match(/kpi-card/g) || []).length;
  check('KPI 输出 4 格', cards === 4, '实际 ' + cards);

  const expLabels = ['分析月份', '计划开机天数', '实单+预算待生产外壳数量', '计划入库产值KPI'];
  const expUnits = ['月', '天', '万PCS', '万RMB'];
  let lblOk = true, unitOk = true;
  for (let i = 0; i < 4; i++) {
    if (kpiHtml.indexOf(expLabels[i]) < 0) { lblOk = false; check('标签[' + i + '] = ' + expLabels[i], false); }
    if (kpiHtml.indexOf(expUnits[i]) < 0) { unitOk = false; check('单位[' + i + '] = ' + expUnits[i], false); }
  }
  check('4 个 label 全部正确', lblOk, expLabels.join(' / '));
  check('4 个 unit 全部正确', unitOk, expUnits.join(' / '));
  // 标签顺序
  let orderOk = true;
  for (let i = 0; i < 4; i++) {
    if (i > 0 && kpiHtml.indexOf(expLabels[i]) < kpiHtml.indexOf(expLabels[i - 1])) orderOk = false;
  }
  check('标签顺序正确', orderOk);

  // CSS 字体加粗统一（label / input / unit 均 font-weight:700）
  function ruleHasBold(selector) {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
    const m = html.match(re);
    return m ? /font-weight\s*:\s*700/.test(m[1]) : false;
  }
  check('CSS .kpi-card .label 加粗(700)', ruleHasBold('.kpi-card .label'), 'font-weight:700');
  check('CSS .kpi-input 加粗(700)', ruleHasBold('.kpi-input'), 'font-weight:700');
  check('CSS .kpi-input-row .unit 加粗(700)', ruleHasBold('.kpi-input-row .unit'), 'font-weight:700');
  // 输入框字体更大（数值主体字号 > label 字号）
  const inputSize = (html.match(/\.kpi-input\s*\{[^}]*font-size\s*:\s*(\d+)px/) || [])[1];
  const labelSize = (html.match(/\.kpi-card \.label\s*\{[^}]*font-size\s*:\s*(\d+)px/) || [])[1];
  check('输入框字号(25px) > 标签字号(14px)', Number(inputSize) > Number(labelSize), 'input=' + inputSize + ' label=' + labelSize);
})();

// =========================================================================
console.log('\n========== 回归（不能破坏） ==========');
(function testRegression() {
  // 1) EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致
  check('R1. EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致', JSON.stringify(canonical(EMB_ANALYSIS)) === JSON.stringify(canonical(analysisRef)));

  // 2) mapMachineGroup('150T-280T') 仍正常
  check('R2. mapMachineGroup("150T-280T") = 150T-280T', D.mapMachineGroup('150T-280T') === '150T-280T', D.mapMachineGroup('150T-280T'));

  // 3) computeDetailRows 300 行金标准 J/K/L/W
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
  try { result = D.computeDetailRows(aoa); } catch (e) { check('R3. computeDetailRows 正常返回', false, e.message); }
  check('R3. computeDetailRows 正常返回', !!result && Array.isArray(result.rows));
  if (result && result.rows) {
    check('R3. 输出行数 = 300', result.rows.length === 300, '实际 ' + result.rows.length);
    const out = result.rows;
    let kBad = 0, lBad = 0, jBad = 0, wBad = 0;
    for (let i = 0; i < out.length; i++) {
      const o = out[i], td = testdata[i];
      if (o.K !== td.K) kBad++;
      if (o.L !== td.L) lBad++;
      if (Math.round((o.J || 0) * 100) !== Math.round((td.J || 0) * 100)) jBad++;
      if (Math.abs((o.W || 0) - (td.W || 0)) > 1e-6) wBad++;
    }
    check('R3. K 300/300 一致', kBad === 0, kBad + ' 行不一致');
    check('R3. L 300/300 一致', lBad === 0, lBad + ' 行不一致');
    check('R3. J 300/300 一致(±0.005)', jBad === 0, jBad + ' 行不一致');
    check('R3. W 300/300 一致(±1e-6)', wBad === 0, wBad + ' 行不一致');
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
