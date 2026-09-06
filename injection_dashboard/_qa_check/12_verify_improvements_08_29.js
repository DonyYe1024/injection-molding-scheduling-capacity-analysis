'use strict';
/* =========================================================================
 * QA 校验脚本 12：《改善08-29版-1》10 项改善 + 1 项月历悬浮修复（真实执行）
 * 独立构造桩数据，node vm + 桩环境加载 index.html 内联逻辑实际运行。
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
const testdata = JSON.parse(fs.readFileSync(TESTDATA, 'utf8')).rows;
const analysisRef = JSON.parse(fs.readFileSync(ANALYSIS_JSON, 'utf8'));
const gapRef = JSON.parse(fs.readFileSync(GAP_JSON, 'utf8'));

let total = 0, passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail != null ? '  — ' + detail : '')); }
  else { failed++; failures.push(name); console.log('[FAIL] ' + name + (detail != null ? '  — ' + detail : '')); }
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }
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

// ---------- 从源码抽取 const JSON（花括号配对，不依赖分号） ----------
function extractConstJson(src, name) {
  const key = 'const ' + name + ' = ';
  const i = src.indexOf(key);
  if (i < 0) return null;
  let j = i + key.length;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = j; k < src.length; k++) {
    const ch = src[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(j, k + 1); }
  }
  return null;
}
const EMB_ANALYSIS = JSON.parse(extractConstJson(dataScript, 'EMBEDDED_ANALYSIS'));
const EMB_GAP = JSON.parse(extractConstJson(dataScript, 'EMBEDDED_GAP'));

// ---------- 桩环境 ----------
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
const state = D.getState();

// =========================================================================
console.log('\n========== 改善1/2/3：机台 Tab 与折线名 ==========');
(function testMachineTabs() {
  // 1) 源码中 MACHINE_CAP_LINES 配置表（从 logicScript 源码文本校验文案）
  const src = logicScript;
  const capBlock = (src.match(/MACHINE_CAP_LINES\s*=\s*\{[\s\S]*?\n  \};/) || [''])[0];
  check('1. MACHINE_CAP_LINES 配置表存在', /MACHINE_CAP_LINES\s*=\s*\{/.test(src));

  const expFull = {
    '400T-550T': ['10台6天工时1320h(10台*22小时*6天)', '11台6天工时1452h(11台*22小时*6天)'],
    '230T-280T': ['3台6天工时396h(3台*22小时*6天)', '4台6天工时528h(4台*22小时*6天)'],
    '150T': ['1台6天工时132h(1台*22小时*6天)'],
    '90T': ['1台6天工时132h(1台*22小时*6天)', '2台6天工时264h(2台*22小时*6天)'],
    '150T-280T': ['4台6天工时528h(4台*22小时*6天)', '5台6天工时660h(5台*22小时*6天)']
  };
  Object.keys(expFull).forEach(function (g) {
    expFull[g].forEach(function (t) {
      check('1. 配置文案存在 [' + g + '] ' + t, src.indexOf(t) >= 0);
    });
  });

  // 2) renderMachineTabs：tab-sub 多行 full 文本（<br> 分隔）
  // 注：renderMachineTabs 未导出，但脚本加载时 init()->renderAll() 已渲染进 machineTabs
  const tabsHtml = getEl('machineTabs').innerHTML;
  check('2. tab-sub 以 <br> 分隔多行 full', tabsHtml.indexOf('10台6天工时1320h(10台*22小时*6天)<br>11台6天工时1452h(11台*22小时*6天)') >= 0);
  function tabSub(g) {
    const m = tabsHtml.match(new RegExp('data-group="' + g + '">[\\s\\S]*?<span class="tab-sub">([\\s\\S]*?)</span>'));
    return m ? m[1] : '';
  }
  const sub150 = tabSub('150T');
  check('2. 150T tab-sub 单行（无 <br>）', sub150.indexOf('1台6天工时132h(1台*22小时*6天)') >= 0 && sub150.indexOf('<br>') < 0, JSON.stringify(sub150));
  const sub90 = tabSub('90T');
  check('2. 90T tab-sub 双行', sub90.indexOf('1台6天工时132h(1台*22小时*6天)') >= 0 && sub90.indexOf('2台6天工时264h(2台*22小时*6天)') >= 0 && sub90.indexOf('<br>') >= 0, JSON.stringify(sub90));
  const sub150280 = tabSub('150T-280T');
  check('2. 150T-280T tab-sub 双行', sub150280.indexOf('4台6天工时528h(4台*22小时*6天)') >= 0 && sub150280.indexOf('5台6天工时660h(5台*22小时*6天)') >= 0, JSON.stringify(sub150280));

  // 3) buildMachineOption：折线名与数量
  function seriesNames(opt) { return opt.series.map(function (s) { return s.name; }); }
  function legendNames(opt) { return opt.legend.data; }

  const o400 = D.buildMachineOption('400T-550T');
  check('3. 400T-550T cap6 名 = 第一行', seriesNames(o400).indexOf('10台6天工时1320h') >= 0);
  check('3. 400T-550T cap7 名 = 第二行', seriesNames(o400).indexOf('11台6天工时1452h') >= 0);
  check('3. 400T-550T 共 4 条 series', o400.series.length === 4, '实际 ' + o400.series.length);

  const o150 = D.buildMachineOption('150T');
  check('3. 150T cap6 名 = 1台6天工时132h', seriesNames(o150).indexOf('1台6天工时132h') >= 0);
  check('3. 150T 无 cap7 折线（series 无第二行）', seriesNames(o150).indexOf('2台6天工时264h') < 0 && o150.series.length === 3, 'series=' + seriesNames(o150).join(','));
  check('3. 150T legend 无第二行', legendNames(o150).length === 3 && legendNames(o150).indexOf('1台6天工时132h') >= 0);

  const o90 = D.buildMachineOption('90T');
  check('3. 90T 两条折线都在', seriesNames(o90).indexOf('1台6天工时132h') >= 0 && seriesNames(o90).indexOf('2台6天工时264h') >= 0);
  check('3. 90T 共 4 条 series', o90.series.length === 4, '实际 ' + o90.series.length);
  check('3. 90T legend 含两行', legendNames(o90).indexOf('2台6天工时264h') >= 0);

  const o150280 = D.buildMachineOption('150T-280T');
  check('3. 150T-280T cap6/cap7 名', seriesNames(o150280).indexOf('4台6天工时528h') >= 0 && seriesNames(o150280).indexOf('5台6天工时660h') >= 0);
})();

// =========================================================================
console.log('\n========== 改善4：模具产能·品种预算堆叠 ==========');
(function testBudgetVariety() {
  // 构造预算表 ws：headerRow=3（第4行）；G列=1-based7=0-based6；H列=0-based7；
  // L列(0-based11)起两列一组：11=数量(奇)、12=工时(偶)、13=数量、14=工时
  const aoa = [];
  aoa.push(new Array(16).fill(null)); // row0
  aoa.push(new Array(16).fill(null)); // row1
  aoa.push(new Array(16).fill(null)); // row2
  const hdr = new Array(16).fill(null);
  hdr[11] = '34.2026'; hdr[12] = '34.2026需求'; hdr[13] = '35.2026'; hdr[14] = '35.2026需求';
  aoa.push(hdr); // row3 = headerRow

  // 数据行：DH010-DKT-3滑行器，机台400T-550T，工时 100/200，数量 1000/2000
  const r1 = new Array(16).fill(null);
  r1[6] = 'DH010-DKT-3滑行器'; r1[7] = '400T-550T'; r1[11] = 1000; r1[12] = 100; r1[13] = 2000; r1[14] = 200;
  aoa.push(r1);
  // 同名累加行：工时 50/70
  const r2 = new Array(16).fill(null);
  r2[6] = 'DH010-DKT-3滑行器'; r2[7] = '400T-550T'; r2[11] = 300; r2[12] = 50; r2[13] = 400; r2[14] = 70;
  aoa.push(r2);
  // 塑料铆钉（150T）
  const r3 = new Array(16).fill(null);
  r3[6] = '塑料铆钉'; r3[7] = '150T'; r3[11] = 5; r3[12] = 8; r3[13] = 6; r3[14] = 9;
  aoa.push(r3);
  // #N/A 品名行（应被排除，但机台级仍聚合到 budget）
  const r4 = new Array(16).fill(null);
  r4[6] = '#N/A'; r4[7] = '400T-550T'; r4[11] = 999; r4[12] = 999; r4[13] = 999; r4[14] = 999;
  aoa.push(r4);
  // 空品名行（无机台）应跳过
  const r5 = new Array(16).fill(null);
  r5[11] = 777; r5[12] = 777; r5[13] = 777; r5[14] = 777;
  aoa.push(r5);

  const b = D.parseBudget(aoaToWs(aoa));
  check('4. parseBudget 返回 5 个键', !!b && ['budget', 'budgetByVariety', 'budgetQtyByVariety', 'budgetVarietyMachine', 'date'].every(function (k) { return k in b; }));
  check('4. budgetByVariety DH010 工时 2026WK34=150', b.budgetByVariety['DH010-DKT-3滑行器'] && b.budgetByVariety['DH010-DKT-3滑行器']['2026WK34'] === 150, JSON.stringify(b.budgetByVariety['DH010-DKT-3滑行器']));
  check('4. budgetByVariety DH010 工时 2026WK35=270', b.budgetByVariety['DH010-DKT-3滑行器'] && b.budgetByVariety['DH010-DKT-3滑行器']['2026WK35'] === 270);
  check('4. budgetQtyByVariety DH010 数量 2026WK34=1300', b.budgetQtyByVariety['DH010-DKT-3滑行器'] && b.budgetQtyByVariety['DH010-DKT-3滑行器']['2026WK34'] === 1300, JSON.stringify(b.budgetQtyByVariety['DH010-DKT-3滑行器']));
  check('4. #N/A 被排除（不进 budgetByVariety）', !b.budgetByVariety['#N/A'] && !b.budgetByVariety['']);
  check('4. 塑料铆钉 工时 2026WK34=8', b.budgetByVariety['塑料铆钉'] && b.budgetByVariety['塑料铆钉']['2026WK34'] === 8);
  check('4. 机台级 budget 仍聚合（400T 工时 WK34 = 100+50+999）', b.budget['400T-550T'] && b.budget['400T-550T']['2026WK34'] === 100 + 50 + 999, JSON.stringify(b.budget['400T-550T']));
  check('4. budgetVarietyMachine 记录 DH010→400T-550T', b.budgetVarietyMachine['DH010-DKT-3滑行器'] === '400T-550T');

  // buildVarietyOption：选中品种后 实单+预算 两个 bar 均 stack:'total'
  state.varietyData = { varieties: ['DH010-DKT-3滑行器', '塑料铆钉'], weeks: ['2026WK34', '2026WK35'], data: { 'DH010-DKT-3滑行器': { '2026WK34': 60, '2026WK35': 80 } } };
  state.activeVariety = 'DH010-DKT-3滑行器';
  state.budgetByVariety = b.budgetByVariety;
  const vopt = D.buildVarietyOption('DH010-DKT-3滑行器', 1, 132);
  const bars = vopt.series.filter(function (s) { return s.type === 'bar'; });
  check('4. 两个 bar 系列', bars.length === 2, '实际 ' + bars.length);
  check('4. 实单 bar stack=total', bars[0].name === '实单工时' && bars[0].stack === 'total');
  check('4. 预算 bar stack=total', bars[1].name === '预算工时' && bars[1].stack === 'total');
  check('4. 预算数据精确匹配 DH010', bars[1].data && bars[1].data[0] === 150 && bars[1].data[1] === 270, JSON.stringify(bars[1].data));

  // 包含匹配：品种名「DH010」能匹配到「DH010-DKT-3滑行器」
  state.activeVariety = 'DH010';
  const vopt2 = D.buildVarietyOption('DH010', 1, 132);
  const bars2 = vopt2.series.filter(function (s) { return s.type === 'bar'; });
  check('4. 包含匹配累加预算', bars2[1].data && bars2[1].data[0] === 150, JSON.stringify(bars2[1].data));

  // 未上传（budgetByVariety=null）→ 预算全 0 不报错
  state.budgetByVariety = null;
  const vopt3 = D.buildVarietyOption('DH010-DKT-3滑行器', 1, 132);
  const bars3 = vopt3.series.filter(function (s) { return s.type === 'bar'; });
  check('4. 未上传预算全 0 不报错', bars3.length === 2 && bars3[1].data && bars3[1].data.every(function (x) { return x === 0; }), JSON.stringify(bars3[1].data));
})();

// =========================================================================
console.log('\n========== 改善5：GAP 取整 ==========');
(function testGapRound() {
  // 用内嵌 GAP 渲染，检查非弹性行无小数、弹性行保留1位
  state.gapReal = null; // 内置模式
  D.renderGap();
  const gapHtml = getEl('gapContainer').innerHTML;
  // 抓取所有 <td> 内容，分类检查（跳过 row-label 标签列，其内容如 "DH010L （1.4mm）" 含非数据小数点）
  const tds = gapHtml.match(/<td[^>]*>[^<]*<\/td>/g) || [];
  let badDecimal = 0, flexOneDecimal = 0, sawFlex = false, dataCells = 0;
  for (const td of tds) {
    if (/class="[^"]*row-label/.test(td)) continue; // 跳过标签列
    const text = td.replace(/<\/?td[^>]*>/g, '');
    if (text === '—' || text === '') continue;
    dataCells++;
    if (/%$/.test(text)) {
      sawFlex = true;
      const m = text.match(/^(-?\d+)\.(\d)%$/);
      if (!m || m[2].length !== 1) flexOneDecimal++;
    } else if (/\.\d/.test(text)) {
      badDecimal++;
    }
  }
  check('5. 数据格存在', dataCells > 0, String(dataCells));
  check('5. 非弹性行无小数（含每周可供产能 cap 行）', badDecimal === 0, badDecimal + ' 处含小数');
  check('5. 弹性行存在且保留 1 位小数', sawFlex && flexOneDecimal === 0, sawFlex ? (flexOneDecimal + ' 处异常') : '未见弹性行');
})();

// =========================================================================
console.log('\n========== 改善6/7：原料表 ==========');
(function testMaterialTable() {
  // h2 文字
  const h2 = (html.match(/<h2>注塑原料1\+7需求推算 预算\+实单<\/h2>/) || [''])[0];
  check('6. h2 = 注塑原料1+7需求推算 预算+实单', h2.length > 0, h2);

  // renderMaterialA 表头顺序 + 合计
  state.materialDemand = null;
  D.renderMaterialA();
  const mHtml = getEl('materialAContainer').innerHTML;
  const thead = (mHtml.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
  const ths = (thead.match(/<th[^>]*>([^<]*)<\/th>/g) || []).map(function (t) { return t.replace(/<th[^>]*>/, '').replace(/<\/th>/, ''); });
  check('7. 表头前 4 列顺序 = 说明|物料代码|物料名称|合计', ths[0] === '说明' && ths[1] === '物料代码' && ths[2] === '物料名称' && ths[3] === '合计', ths.slice(0, 4).join('|'));

  // 合计 = 该行周列非零值求和（取整）。取第一行验证：items[0].weekly 非零求和取整
  const it0 = EMB_GAP.material.items[0];
  const weeks = EMB_GAP.material.weeks;
  let expTotal = 0;
  for (let i = 0; i < weeks.length; i++) { const v = it0.weekly[i] || 0; if (v !== 0) expTotal += v; }
  expTotal = Math.round(expTotal).toLocaleString('zh-CN');
  const firstTr = (mHtml.match(/<tbody>[\s\S]*?<tr>[\s\S]*?<\/tr>/) || [''])[0];
  const tds = firstTr.match(/<td[^>]*>([^<]*)<\/td>/g) || [];
  const totalCell = tds.length >= 4 ? tds[3].replace(/<\/?td[^>]*>/g, '') : '';
  check('7. 首行合计 = 周列非零求和取整', totalCell === expTotal, '实际 ' + totalCell + ' 期望 ' + expTotal);
  // 说明列在最左（首 td 为 desc）
  const descCell = tds.length >= 1 ? tds[0].replace(/<\/?td[^>]*>/g, '') : '';
  check('7. 说明列在最左', descCell === String(it0.desc), descCell);
})();

// =========================================================================
console.log('\n========== 改善8：top10 上移 + 周筛选 ==========');
(function testTop10() {
  // HTML 顺序：top10 在 模具产能GAP 之后、原料库存水位 之前
  const top10Idx = html.indexOf('data-module="top10"');
  const gapIdx = html.indexOf('data-module="gap"');
  const materialIdx = html.indexOf('data-module="material"');
  check('8. top10 位于 GAP 之后', top10Idx > gapIdx && gapIdx > 0, 'top10=' + top10Idx + ' gap=' + gapIdx);
  check('8. top10 位于 原料 之前', top10Idx < materialIdx, 'top10=' + top10Idx + ' material=' + materialIdx);

  // top10WeekSelect 存在
  check('8. top10WeekSelect 存在', html.indexOf('id="top10WeekSelect"') >= 0);

  // 未上传时选项仅「全部」（脚本加载时 renderAll 已渲染，此时 state.detailRows 默认 null）
  const selHtml = getEl('top10WeekSelect').innerHTML;
  const opts = (selHtml.match(/<option[^>]*>/g) || []).length;
  check('8. 未上传选项仅「全部」', opts === 1 && selHtml.indexOf('全部') >= 0, '选项数=' + opts + ' html=' + selHtml);

  // 选具体周 → computeTop10Week 分类与取前10
  const detailRows = [
    { N: 'DH010外壳', P: '2026WK34', L: 100, Q: '400T-550T' },
    { N: 'DH001外壳', P: '2026WK34', L: 200, Q: '400T-550T' },
    { N: '帽沿',     P: '2026WK34', L: 50,  Q: '230T-280T' },
    { N: '通风片',   P: '2026WK34', L: 60,  Q: '150T-280T' },
    { N: 'DH010外壳', P: '2026WK35', L: 999, Q: '400T-550T' } // 别的周，不应计入 WK34
  ];
  state.detailRows = detailRows;
  state.budgetQtyByVariety = {
    'DH010外壳': { '2026WK34': 30 },
    '帽沿': { '2026WK34': 40 }
  };
  state.budgetVarietyMachine = { 'DH010外壳': '400T-550T', '帽沿': '230T-280T' };
  state.top10Week = '2026WK34';
  D.renderTop10();
  const shellOpt = getEl('top10ShellChart').__echartOption;
  const accOpt = getEl('top10AccChart').__echartOption;
  const shellData = (shellOpt && shellOpt.series[0].data) || [];
  const accData = (accOpt && accOpt.series[0].data) || [];
  // 外壳：DH010(100+30=130), DH001(200) → 2 项
  check('8. WK34 外壳 top10 含 DH010(130)/DH001(200)', shellData.length === 2 && shellData.some(function (d) { return d.name === 'DH010外壳' && d.value === 130; }) && shellData.some(function (d) { return d.name === 'DH001外壳' && d.value === 200; }), JSON.stringify(shellData));
  // 配件：帽沿(50+40=90), 通风片(60) → 2 项
  check('8. WK34 配件 top10 含 帽沿(90)/通风片(60)', accData.length === 2 && accData.some(function (d) { return d.name === '帽沿' && d.value === 90; }) && accData.some(function (d) { return d.name === '通风片' && d.value === 60; }), JSON.stringify(accData));

  // 取前10：构造 15 个外壳品种，验证只取前 10
  const many = [];
  for (let i = 1; i <= 15; i++) many.push({ N: '外壳' + i, P: '2026WK35', L: i * 10, Q: '400T-550T' });
  state.detailRows = many;
  state.budgetQtyByVariety = null;
  state.top10Week = '2026WK35';
  D.renderTop10();
  const shellOpt2 = getEl('top10ShellChart').__echartOption;
  check('8. 取前 10（15 品种 → 10）', (shellOpt2.series[0].data || []).length === 10, '实际 ' + (shellOpt2.series[0].data || []).length);

  // amount=null 时 buildTop10Option 不报错
  let noErr = true;
  try { const o = D.buildTop10Option([{ name: 'a', pcs: 1, amount: null }, { name: 'b', pcs: 2, amount: null }]); check('8. amount=null buildTop10Option 不报错', !!o && o.series[0].data.length === 2); }
  catch (e) { noErr = false; check('8. amount=null buildTop10Option 不报错', false, e.message); }
})();

// =========================================================================
console.log('\n========== 改善9：月历 ==========');
(function testCalendar() {
  // CSS：.meta-calendar position:fixed top:16 right:16 z-index:200 + rgba 半透明
  const css = (html.match(/\.meta-calendar\s*\{[\s\S]*?\}/) || [''])[0];
  check('9. .meta-calendar position:fixed', /position:\s*fixed/.test(css));
  check('9. top:16px right:16px', /top:\s*16px/.test(css) && /right:\s*16px/.test(css));
  check('9. z-index:200', /z-index:\s*200/.test(css));
  check('9. 保留 rgba 半透明背景', /background:\s*rgba\(255,\s*255,\s*255,\s*0\.12\)/.test(css));
  check('9. 边框 + 圆角', /border:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.3\)/.test(css) && /border-radius:\s*10px/.test(css));

  // grid 8 列（.cal-grid 在 .meta-calendar 之外，单独从全局 CSS 校验）
  check('9. 月历 grid 8 列', /\.cal-grid\s*\{[^}]*grid-template-columns:\s*repeat\(8,\s*22px\)/.test(html));
  // .cal-spacer 占位元素存在
  check('9. .cal-spacer 元素存在', html.indexOf('class="cal-spacer"') >= 0);

  // 2026-08 月历周数列
  kpiStore.month = '2026-08';
  D.renderCalendar();
  const calHtml = getEl('metaCalendar').innerHTML;
  const wkVals = (calHtml.match(/<div class="cal-cell cal-wk">WK(\d+)<\/div>/g) || []).map(function (t) { return t.replace(/\D/g, ''); });
  // 预期：WK31,32,33,34,35,36（6 行；8月1日为周六）
  const expWk = ['31', '32', '33', '34', '35', '36'];
  check('9. 2026-08 周数列 = 31,32,33,34,35,36', JSON.stringify(wkVals) === JSON.stringify(expWk), '实际 ' + wkVals.join(','));
  check('9. 8月1日所在周 = WK31', wkVals[0] === '31', wkVals[0]);
  check('9. 8月各周日所在周数正确', wkVals[1] === '32' && wkVals[2] === '33' && wkVals[3] === '34' && wkVals[4] === '35' && wkVals[5] === '36');

  // excelWeekNum 参考值（8/1=31, 8/2=32, 8/30=36）
  check('9. excelWeekNum(2026-08-01)=31', D.excelWeekNum(new Date(2026, 7, 1)) === 31, String(D.excelWeekNum(new Date(2026, 7, 1))));
  check('9. excelWeekNum(2026-08-30)=36', D.excelWeekNum(new Date(2026, 7, 30)) === 36, String(D.excelWeekNum(new Date(2026, 7, 30))));
})();

// =========================================================================
console.log('\n========== 改善10：仪表盘说明 ==========');
(function testGauge() {
  const note = '符合最大值 = 单台产能1500PCS X 11台 X 22小时 X 开机天数（动态）';
  check('10. gauge-caption-note 文案存在', html.indexOf(note) >= 0);
  check('10. note 位于 gauge-caption 之下', html.indexOf('<div class="gauge-caption">外壳机台产能负荷</div>') < html.indexOf(note));
  // computeGauge 公式未被改动
  kpiStore.days = '10';
  kpiStore.shell = '20';
  const g = D.computeGauge();
  check('10. computeGauge max = days×11×1500/10000', close(g.max, 10 * 11 * 1500 / 10000), String(g.max));
  check('10. computeGauge pct = shell/max×100', close(g.pct, 20 / (10 * 11 * 1500 / 10000) * 100), String(g.pct));
})();

// =========================================================================
console.log('\n========== 回归：computeDetailRows 300 ==========');
(function testRegressionDetail() {
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
})();

// =========================================================================
console.log('\n========== 回归：parseBudget 机台级 / buildMachine / parseDetail / parseAnalysis2-3 / mapMachineGroup / parseBudget6 ==========');
(function testRegressionRest() {
  // parseBudget 机台级聚合（H列分组 + 偶数列工时 + 34.2026→2026WK34）已在改善4验证，此处补 mapMachineGroup('150T-280T')
  check('回归. mapMachineGroup(150T-280T) = 150T-280T', D.mapMachineGroup('150T-280T') === '150T-280T');
  check('回归. mapMachineGroup(400T-550T) = 400T-550T', D.mapMachineGroup('400T/550T') === '400T-550T');
  check('回归. mapMachineGroup(230T/280T) = 230T-280T', D.mapMachineGroup('230T-280T') === '230T-280T');

  // buildMachine 周轴不含内置旧周
  const dm = { weeks: ['2026WK40'], groups: { '400T-550T': { real: [10] } } };
  const budget = { '400T-550T': { '2026WK41': 5 } };
  const bm = D.buildMachine(dm, budget);
  check('回归. buildMachine 周轴不含内置旧周（仅上传周）', bm.weeks.length === 2 && bm.weeks[0] === '2026WK40' && bm.weeks[1] === '2026WK41', JSON.stringify(bm.weeks));

  // parseDetail 未排期行不进机台图
  const detAoa = [];
  detAoa.push(new Array(23).fill(null));
  detAoa.push(new Array(23).fill(null));
  detAoa.push(new Array(23).fill(null));
  const d1 = new Array(23).fill(null);
  d1[1] = 'B1'; d1[2] = 'C1'; d1[3] = 'D1'; d1[4] = 'E1'; d1[7] = 10; d1[8] = 0; d1[9] = 5; d1[11] = 100; d1[15] = '2026WK34'; d1[16] = '400T-550T';
  detAoa.push(d1);
  const d2 = new Array(23).fill(null);
  d2[1] = 'B2'; d2[2] = 'C2'; d2[3] = 'D2'; d2[4] = 'E2'; d2[7] = 20; d2[8] = 0; d2[9] = 7; d2[11] = 200; d2[15] = '未排期'; d2[16] = '400T-550T';
  detAoa.push(d2);
  const pd = D.parseDetail(aoaToWs(detAoa));
  check('回归. parseDetail 未排期行不进机台图 weeks', pd.machine.weeks.length === 1 && pd.machine.weeks[0] === '2026WK34', JSON.stringify(pd.machine.weeks));
  check('回归. parseDetail 未排期行不进机台 real', pd.machine.groups['400T-550T'].real.length === 1 && pd.machine.groups['400T-550T'].real[0] === 5, JSON.stringify(pd.machine.groups['400T-550T'].real));
  check('回归. parseDetail detailRows 仍含未排期行（不丢失）', pd.detailRows.length === 2);

  // parseAnalysis2/3 固定列：验证 parseAnalysis2 对 5 组固定列读取
  // 结构：每行一周，5 组机台数据都在同一行；周号统一读第 1 组周列（1-based col2）
  const a2 = [];
  for (let i = 0; i < 42; i++) a2.push(new Array(51).fill(null));
  a2[4][1] = '2026WK34';  // 周（block0 week=col2 → idx1）
  a2[4][2] = 100; a2[4][3] = 1320; a2[4][4] = 1452; a2[4][5] = 50;    // 400T-550T real/cap6/cap7/budget (col3..6)
  a2[4][13] = 200; a2[4][14] = 396; a2[4][15] = 528; a2[4][16] = 60;   // 230T-280T (col14..17)
  a2[4][23] = 300; a2[4][24] = 132; a2[4][25] = 154; a2[4][26] = 70;   // 150T (col24..27)
  a2[4][32] = 400; a2[4][33] = 132; a2[4][34] = 264; a2[4][35] = 80;   // 90T (col33..36)
  a2[4][46] = 500; a2[4][47] = 528; a2[4][48] = 660; a2[4][49] = 90;   // 150T-280T (col47..50)
  const p2 = D.parseAnalysis2(aoaToWs(a2));
  check('回归. parseAnalysis2 返回 5 组', !!p2 && p2.weeks.length === 1 && Object.keys(p2.groups).length === 5, p2 && JSON.stringify(p2.weeks));
  check('回归. parseAnalysis2 400T-550T 实单=100', p2 && p2.groups && p2.groups['400T-550T'] && p2.groups['400T-550T'].real[0] === 100, p2 && p2.groups && JSON.stringify(p2.groups['400T-550T']));
  check('回归. parseAnalysis2 230T-280T 实单=200', p2 && p2.groups && p2.groups['230T-280T'] && p2.groups['230T-280T'].real[0] === 200, p2 && p2.groups && JSON.stringify(p2.groups['230T-280T']));
  check('回归. parseAnalysis2 150T cap7=154', p2 && p2.groups && p2.groups['150T'] && p2.groups['150T'].cap7[0] === 154);
  check('回归. parseAnalysis2 90T cap7=264', p2 && p2.groups && p2.groups['90T'] && p2.groups['90T'].cap7[0] === 264);
  check('回归. parseAnalysis2 150T-280T 实单=500', p2 && p2.groups && p2.groups['150T-280T'] && p2.groups['150T-280T'].real[0] === 500);

  // parseAnalysis3 固定列（若存在）
  check('回归. parseAnalysis3 可调用', typeof D.parseAnalysis3 === 'function');

  // parseBudget6
  const aoa6 = [];
  aoa6.push(new Array(16).fill(null));
  aoa6[0][11] = '2026WK34'; aoa6[0][12] = '8月'; aoa6[0][13] = '2026WK35'; aoa6[0][14] = '9月';
  aoa6.push(new Array(16).fill(null)); aoa6[1][9] = 'DH071S PLAY500'; aoa6[1][11] = 100; aoa6[1][13] = 200;
  aoa6.push(new Array(16).fill(null)); aoa6[2][9] = 'DH071S PLAY500'; aoa6[2][11] = 50; aoa6[2][13] = 70;
  const b6 = D.parseBudget6(aoaToWs(aoa6));
  check('回归. parseBudget6 WK34=150/WK35=270', !!b6 && b6['DH071S PLAY500'] && b6['DH071S PLAY500']['2026WK34'] === 150 && b6['DH071S PLAY500']['2026WK35'] === 270);
})();

// =========================================================================
console.log('\n========== 内嵌数据一致性 ==========');
(function testEmbeddedConsistency() {
  // EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致
  check('内嵌. EMBEDDED_ANALYSIS 与 analysis_data.json 深度一致', deepEq(EMB_ANALYSIS, analysisRef), EMB_ANALYSIS && analysisRef ? (deepEq(EMB_ANALYSIS, analysisRef) ? '一致' : '不一致') : '抽取失败');
  // 若不一致，定位差异键
  if (!deepEq(EMB_ANALYSIS, analysisRef)) {
    const ka = Object.keys(EMB_ANALYSIS || {}), kb = Object.keys(analysisRef || {});
    check('内嵌. EMBEDDED_ANALYSIS 键集一致', JSON.stringify(ka.sort()) === JSON.stringify(kb.sort()), 'html=' + ka.join(',') + ' json=' + kb.join(','));
  }

  // EMBEDDED_GAP 内嵌数据一致（gap 27模具/53周、material 28/38周、stock 141）
  check('内嵌. EMBEDDED_GAP 与 gap_material_data.json 深度一致', deepEq(EMB_GAP, gapRef));
  check('内嵌. gap 27 模具', EMB_GAP.gap.molds.length === 27, String(EMB_GAP.gap.molds.length));
  check('内嵌. gap 53 周', EMB_GAP.gap.weeks.length === 53, String(EMB_GAP.gap.weeks.length));
  check('内嵌. material 28 项', EMB_GAP.material.items.length === 28, String(EMB_GAP.material.items.length));
  check('内嵌. material 38 周', EMB_GAP.material.weeks.length === 38, String(EMB_GAP.material.weeks.length));
  check('内嵌. stock 141 项', EMB_GAP.stock.length === 141, String(EMB_GAP.stock.length));
  check('内嵌. stockTotal = 216553', EMB_GAP.stockTotal === 216553, String(EMB_GAP.stockTotal));
})();

// =========================================================================
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);
