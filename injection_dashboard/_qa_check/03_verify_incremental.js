'use strict';
/* =========================================================================
 * QA 校验脚本 03：两项增量改善独立复验（机台堆叠柱状图 + J~W 列前端补算）
 * 用真实 testdata.json 300 行 + 内嵌 EMBEDDED_MAPPINGS 逐行核对计算正确性
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'D:/WorkBuddy工作资料/injection_dashboard';
const HTML = path.join(ROOT, 'index.html');
const MAP = path.join(ROOT, 'mappings.json');
const TESTDATA = path.join(ROOT, '_qa_check/testdata.json');

const html = fs.readFileSync(HTML, 'utf8');
const mappingsRef = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const testdata = JSON.parse(fs.readFileSync(TESTDATA, 'utf8')).rows;

// ---------- 通用 ----------
let total = 0, passed = 0, failed = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? '  — ' + detail : '')); }
  else { failed++; console.log('[FAIL] ' + name + (detail ? '  — ' + detail : '')); }
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

// ---------- 提取两段内联 script ----------
function extractInlineScripts(src) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}
const scripts = extractInlineScripts(html);
const dataScript = scripts.find(s => /EMBEDDED_DATA/.test(s)) || '';
const logicScript = scripts.find(s => /function renderKPI/.test(s)) || '';

// ---------- A. 抽取 EMBEDDED_MAPPINGS 并比对 mappings.json ----------
console.log('\n========== A. 映射表一致性 ==========');
function extractMappings(src) {
  const key = 'const EMBEDDED_MAPPINGS = ';
  const i = src.indexOf(key);
  if (i < 0) return null;
  const tail = src.slice(i + key.length).trim();
  const j = tail.lastIndexOf(';');
  const jsonText = tail.slice(0, j).trim();
  return JSON.parse(jsonText);
}
let embeddedMappings = null;
try {
  embeddedMappings = extractMappings(dataScript);
  check('A. EMBEDDED_MAPPINGS 可抽取并 JSON.parse', !!embeddedMappings);
} catch (e) {
  check('A. EMBEDDED_MAPPINGS 可抽取并 JSON.parse', false, e.message);
}

if (embeddedMappings) {
  check('A. capacity 数量 = 717', Object.keys(embeddedMappings.capacity).length === 717,
    '实际 ' + Object.keys(embeddedMappings.capacity).length);
  check('A. lineDate 数量 = 4323', Object.keys(embeddedMappings.lineDate).length === 4323,
    '实际 ' + Object.keys(embeddedMappings.lineDate).length);
  check('A. bom 数量 = 1982', Object.keys(embeddedMappings.bom).length === 1982,
    '实际 ' + Object.keys(embeddedMappings.bom).length);

  // 深比较（键序无关：用排序序列化）
  function canonical(obj) {
    if (Array.isArray(obj)) return obj.map(canonical);
    if (obj && typeof obj === 'object') {
      const out = {};
      Object.keys(obj).sort().forEach(k => { out[k] = canonical(obj[k]); });
      return out;
    }
    return obj;
  }
  const same = JSON.stringify(canonical(embeddedMappings)) === JSON.stringify(canonical(mappingsRef));
  check('A. EMBEDDED_MAPPINGS 与 mappings.json 深度一致', same);

  // 抽查若干键
  const capKeys = Object.keys(mappingsRef.capacity);
  const spot = ['2090000283', capKeys[100], capKeys[400], capKeys[716]];
  let spotOk = true, spotDetail = [];
  spot.forEach(k => {
    const a = JSON.stringify(embeddedMappings.capacity[k]);
    const b = JSON.stringify(mappingsRef.capacity[k]);
    if (a !== b) { spotOk = false; spotDetail.push(k + ': ' + a + ' vs ' + b); }
  });
  check('A. 抽查 capacity 键值一致', spotOk, spotDetail.join(' | ') || '抽查 4 键均一致');

  const ldKeys = Object.keys(mappingsRef.lineDate);
  let ldSpotOk = true;
  ['Z1PFZ1-26052700037', ldKeys[100], ldKeys[2000], ldKeys[4322]].forEach(k => {
    if (embeddedMappings.lineDate[k] !== mappingsRef.lineDate[k]) ldSpotOk = false;
  });
  check('A. 抽查 lineDate 键值一致', ldSpotOk);
}

// ---------- 运行逻辑 IIFE（vm + 桩环境） ----------
console.log('\n========== 执行环境 ==========');
let capturedOption = null;
const echartsStub = {
  getInstanceByDom: function () { return null; },
  init: function () {
    return { setOption: function (opt) { capturedOption = opt; } };
  }
};
const xlsxStub = { utils: { sheet_to_json: function (ws) { return ws; } } };
const fakeEl = { __fake: true };
const sandbox = {
  window: { echarts: echartsStub, XLSX: xlsxStub, addEventListener: function () {} },
  document: {
    readyState: 'loading',
    addEventListener: function () {},
    getElementById: function (id) { return id === 'machineChart' ? fakeEl : null; }
  },
  FileReader: function () {},
  console: console
};
vm.createContext(sandbox);
try {
  vm.runInContext(dataScript + '\n;\n' + logicScript, sandbox, { filename: 'logic.js' });
  console.log('[INFO] 逻辑脚本在桩环境执行成功');
} catch (e) {
  console.error('[FATAL] 逻辑脚本执行失败：', e.message, '\n', e.stack);
  process.exit(2);
}
const D = sandbox.window && sandbox.window.__injectionDebug;
if (!D) { console.error('[FATAL] 未捕获 window.__injectionDebug'); process.exit(2); }
check('执行环境. window.__injectionDebug 已暴露', !!D);
check('执行环境. 暴露函数齐全', ['computeDetailRows','excelWeekNum','weekFromLineDate','cavityCount','renderMachineChart'].every(f => typeof D[f] === 'function'));

// ---------- 改善1：renderMachineChart 堆叠柱状图 ----------
console.log('\n========== 改善1：机台产能堆叠柱状图 ==========');
capturedOption = null;
D.renderMachineChart('400T-550T');
if (capturedOption) {
  const series = capturedOption.series || [];
  check('1. series 数量 = 2', series.length === 2, '实际 ' + series.length);
  check('1. 两个 series 均为 bar', series.every(s => s.type === 'bar'), JSON.stringify(series.map(s => s.type)));
  check('1. 两个 series 均带 stack="total"', series.every(s => s.stack === 'total'), JSON.stringify(series.map(s => s.stack)));
  check('1. 无 line 系列', !series.some(s => s.type === 'line'));
  check('1. series[0] name=实单工时', series[0] && series[0].name === '实单工时', series[0] && series[0].name);
  check('1. series[1] name=预算工时', series[1] && series[1].name === '预算工时', series[1] && series[1].name);
  const budgetData = series[1] && series[1].data || [];
  const hasNaN = budgetData.some(v => Number.isNaN(v));
  const hasNull = budgetData.some(v => v === null);
  check('1. budget 无 NaN', !hasNaN);
  check('1. budget 无 null（已映射为 0）', !hasNull, 'null 数量 ' + budgetData.filter(v => v === null).length);
  // 90T 组 budget 全 null → 应全为 0
  capturedOption = null;
  D.renderMachineChart('90T');
  const b90 = capturedOption && capturedOption.series && capturedOption.series[1].data || [];
  check('1. 90T 组 budget 全 null → 映射为全 0', b90.every(v => v === 0), '长度 ' + b90.length + ', 非0个数 ' + b90.filter(v => v !== 0).length);
  // 检查 option 中不再有 capHi/capLo 相关 series（产能虚线/预算折线已删除）
  const optStr = JSON.stringify(capturedOption || {});
  const hasCapLine = /capHi|capLo|产能上限|预算折线/.test(optStr);
  check('1. option 不含 capHi/capLo/产能线', !hasCapLine);
} else {
  check('1. renderMachineChart 产出 option', false, '未捕获到 setOption 调用');
}

// ---------- 改善2：J~W 列补算（金标准核对） ----------
console.log('\n========== 改善2：金标准 300 行核对 ==========');

// 构造 aoa：3 行表头 + 300 行数据；输入列 B/C/D/E/F/G/H/I，输出列置空强制补算
function buildAoa(rows) {
  const header = ['h0', 'h1', 'h2'];
  const data = rows.map(r => {
    // 索引对齐 Excel 列：A=0 B=1 C=2 D=3 E=4 F=5 G=6 H=7 I=8 J=9 K=10 L=11 M=12
    // N=13 O=14 P=15 Q=16 R=17 S=18 T=19 U=20 V=21 W=22
    const row = new Array(23).fill(null);
    row[1] = r.B; row[2] = r.C; row[3] = r.D; row[4] = r.E;
    row[5] = r.F; row[6] = r.G; row[7] = r.H; row[8] = r.I;
    return row;
  });
  return header.concat(data);
}

const aoa = buildAoa(testdata);
let result = null;
try {
  result = D.computeDetailRows(aoa);
  check('2. computeDetailRows 正常返回', !!result && Array.isArray(result.rows));
} catch (e) {
  check('2. computeDetailRows 正常返回', false, e.message);
}

if (result && result.rows) {
  check('2. 输出行数 = 300', result.rows.length === 300, '实际 ' + result.rows.length);
  check('2. recomputed 标记 = true', result.recomputed === true);

  const out = result.rows;
  // 统计各项不一致
  let kBad = 0, lBad = 0, jBad = 0, wBad = 0, qBad = 0, rBad = 0, sBad = 0, tBad = 0, mBad = 0;
  const lBadSamples = [], jBadSamples = [], wBadSamples = [], mBadSamples = [];
  const qrtBadSamples = [];

  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    const td = testdata[i];

    // K 累计：精确整数
    if (o.K !== td.K) { kBad++; }

    // L 扣库存后待生产：精确（整数）
    if (o.L !== td.L) {
      lBad++;
      if (lBadSamples.length < 8) lBadSamples.push({ line: i + 1, C: td.C, H: td.H, I: td.I, expK: td.K, expL: td.L, gotL: o.L, gotK: o.K });
    }

    // J 工时：按 2 位小数（整数分）比对，容忍 Excel 浮点噪声
    const jGot = Math.round((o.J || 0) * 100);
    const jExp = Math.round((td.J || 0) * 100);
    if (jGot !== jExp) {
      jBad++;
      if (jBadSamples.length < 8) jBadSamples.push({ line: i + 1, C: td.C, L: o.L, S: o.S, R: o.R, expJ: td.J, gotJ: o.J });
    }

    // W 原料KG：相对/绝对容差 1e-6
    const wDiff = Math.abs((o.W || 0) - (td.W || 0));
    const wTol = Math.max(1e-6, 1e-9 * Math.abs(td.W || 0));
    if (wDiff > wTol) {
      wBad++;
      if (wBadSamples.length < 8) wBadSamples.push({ line: i + 1, C: td.C, L: o.L, T: o.T, expW: td.W, gotW: o.W });
    }

    // M 上线日：lineDate[B] 与期望一致（computeDetailRows 不直接输出 M）
    const mVal = (embeddedMappings && embeddedMappings.lineDate[String(td.B)]) || '';
    if (mVal !== td.M) { mBad++; if (mBadSamples.length < 5) mBadSamples.push({ line: i + 1, B: td.B, expM: td.M, gotM: mVal }); }

    // Q 机台 / R 穴数 / S 周期 / T 毛重
    const qGot = o.Q == null ? '' : String(o.Q).trim();
    const qExp = td.Q == null ? '' : String(td.Q).trim();
    const rGot = o.R == null ? '' : String(o.R).trim();
    const rExp = td.R == null ? '' : String(td.R).trim();
    if (qGot !== qExp || rGot !== rExp || !close(o.S, td.S, 1e-9) || !close(o.T, td.T, 1e-9)) {
      qBad = (qGot !== qExp) ? qBad + 1 : qBad;
      rBad = (rGot !== rExp) ? rBad + 1 : rBad;
      sBad = (!close(o.S, td.S, 1e-9)) ? sBad + 1 : sBad;
      tBad = (!close(o.T, td.T, 1e-9)) ? tBad + 1 : tBad;
      if (qrtBadSamples.length < 8) qrtBadSamples.push({ line: i + 1, C: td.C, exp: [td.Q, td.R, td.S, td.T], got: [o.Q, o.R, o.S, o.T] });
    }
  }

  check('2. K（待生产累计）300 行全部一致', kBad === 0, kBad + ' 行不一致');
  check('2. L（扣库存后待生产）300 行全部一致', lBad === 0, lBad + ' 行不一致');
  check('2. J（工时）300 行全部一致(±0.005)', jBad === 0, jBad + ' 行不一致');
  check('2. W（原料KG）300 行全部一致(±1e-6)', wBad === 0, wBad + ' 行不一致');
  check('2. M（上线日）300 行全部一致', mBad === 0, mBad + ' 行不一致');
  check('2. Q（机台）300 行全部一致', qBad === 0, qBad + ' 行不一致');
  check('2. R（穴数）300 行全部一致', rBad === 0, rBad + ' 行不一致');
  check('2. S（周期）300 行全部一致', sBad === 0, sBad + ' 行不一致');
  check('2. T（毛重）300 行全部一致', tBad === 0, tBad + ' 行不一致');

  if (lBadSamples.length) { console.log('  [L 不一致样本]', JSON.stringify(lBadSamples)); }
  if (jBadSamples.length) { console.log('  [J 不一致样本]', JSON.stringify(jBadSamples)); }
  if (wBadSamples.length) { console.log('  [W 不一致样本]', JSON.stringify(wBadSamples)); }
  if (mBadSamples.length) { console.log('  [M 不一致样本]', JSON.stringify(mBadSamples)); }
  if (qrtBadSamples.length) { console.log('  [Q/R/S/T 不一致样本]', JSON.stringify(qrtBadSamples)); }

  // 附加：逐行用公式独立复算 J/W 与代码输出交叉验证（反算，双保险）
  let jCrossBad = 0, wCrossBad = 0;
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    const cav = D.cavityCount(o.R);
    const jExp2 = (o.S > 0 && cav > 0) ? Math.ceil((o.S * o.L / 3600 / cav) * 100) / 100 : 0;
    if (Math.round(jExp2 * 100) !== Math.round((o.J || 0) * 100)) jCrossBad++;
    const wExp2 = o.L * o.T / 1000;
    if (Math.abs(wExp2 - (o.W || 0)) > 1e-6) wCrossBad++;
  }
  check('2. 交叉验证：J=ROUNDUP(S×L/3600/穴数,2) 一致', jCrossBad === 0, jCrossBad + ' 行不符');
  check('2. 交叉验证：W=L×T/1000 一致', wCrossBad === 0, wCrossBad + ' 行不符');
}

// ---------- B2. 数据一致性（区分代码正确 vs 映射数据） ----------
console.log('\n========== B2. 映射数据一致性（capacity.t vs 金标准 S） ==========');
{
  const mism = {};
  for (const r of testdata) {
    const c = String(r.C);
    const cap = embeddedMappings && embeddedMappings.capacity[c];
    if (!cap) continue;
    if (Number(cap.t) !== r.S) {
      mism[c] = mism[c] || { p: cap.p, t: cap.t, w: cap.w, expS: new Set(), expT: new Set(), n: 0 };
      mism[c].expS.add(r.S); mism[c].expT.add(r.T); mism[c].n++;
    }
  }
  const mKeys = Object.keys(mism);
  if (mKeys.length === 0) {
    check('B2. 全部 300 行 capacity.t 与金标准 S 一致（无数据偏差）', true);
  } else {
    check('B2. 全部 300 行 capacity.t 与金标准 S 一致（无数据偏差）', false, mKeys.length + ' 个料号周期不一致');
    mKeys.forEach(c => {
      const e = mism[c];
      console.log('  [数据偏差] 料号 ' + c + ' 品种=' + e.p + '：映射周期t=' + e.t + ' vs 金标准S=' + Array.from(e.expS).join('/') +
        '（毛重 ' + e.w + ' vs ' + Array.from(e.expT).join('/') + '），影响 ' + e.n + ' 行');
    });
  }
}

// ---------- C. 边界与工具函数 ----------
console.log('\n========== C. 边界与工具函数 ==========');
// excelWeekNum
check('C. excelWeekNum(2026-05-30)=22', D.excelWeekNum(new Date(2026, 4, 30)) === 22, D.excelWeekNum(new Date(2026, 4, 30)));
check('C. excelWeekNum(2026-01-01)=1', D.excelWeekNum(new Date(2026, 0, 1)) === 1, D.excelWeekNum(new Date(2026, 0, 1)));
check('C. excelWeekNum(2026-12-31)=53', D.excelWeekNum(new Date(2026, 11, 31)) === 53, D.excelWeekNum(new Date(2026, 11, 31)));
check('C. excelWeekNum(2026-01-04)=2', D.excelWeekNum(new Date(2026, 0, 4)) === 2, D.excelWeekNum(new Date(2026, 0, 4)));

// weekFromLineDate（M-7 → P 周数）
const wf = D.weekFromLineDate('2026-06-06');
check('C. weekFromLineDate(2026-06-06)="2026WK22"', wf === '2026WK22', wf);
// 跨年：M=2026-01-01 减 7 天 = 2025-12-25 → 2025WK52（正确跨年行为）
check('C. weekFromLineDate(2026-01-01)="2025WK52"（跨年正确）', D.weekFromLineDate('2026-01-01') === '2025WK52', D.weekFromLineDate('2026-01-01'));
check('C. weekFromLineDate("")=""（无崩溃）', D.weekFromLineDate('') === '', JSON.stringify(D.weekFromLineDate('')));

// cavityCount
const cavCases = [['1*1', 1], ['1*16', 16], ['2*2', 2], ['1*64', 64], ['1*10', 10]];
let cavOk = true;
cavCases.forEach(([s, e]) => { if (D.cavityCount(s) !== e) { cavOk = false; console.log('  cavityCount(' + s + ')=' + D.cavityCount(s) + ' 期望 ' + e); } });
check('C. cavityCount 各穴数解析正确', cavOk, cavCases.map(([s, e]) => s + '→' + D.cavityCount(s)).join(', '));

// 映射查不到：不崩溃，相关列置空/0
try {
  const missAoa = ['h0', 'h1', 'h2', ['', 'NO_SUCH_ORDER', 'NO_SUCH_MATERIAL', '', '', '', '', 100, 500, null, null, null, null, null, null, null, null, null, null, null, null, null]];
  const mr = D.computeDetailRows(missAoa);
  const row = mr.rows[0];
  check('C. 映射查不到不崩溃', !!row);
  check('C. 查不到时 Q=""', row.Q === '', JSON.stringify(row.Q));
  check('C. 查不到时 R=""', row.R === '', JSON.stringify(row.R));
  check('C. 查不到时 S=0 / T=0', row.S === 0 && row.T === 0, 'S=' + row.S + ' T=' + row.T);
  check('C. 查不到时 P=""（归未排期）', row.P === '', JSON.stringify(row.P));
  check('C. 查不到时 J=0', row.J === 0, String(row.J));
} catch (e) {
  check('C. 映射查不到不崩溃', false, e.message);
}

// 空数据
try {
  const er = D.computeDetailRows([]);
  check('C. computeDetailRows([]) 不崩溃', true);
  check('C. 空数据 rows=[] 且 recomputed=false', Array.isArray(er.rows) && er.rows.length === 0 && er.recomputed === false,
    JSON.stringify(er));
} catch (e) {
  check('C. computeDetailRows([]) 不崩溃', false, e.message);
}

// ---------- D. 性能 ----------
console.log('\n========== D. 性能 ==========');
function synthRows(n) {
  const rows = [];
  const caps = Object.keys(embeddedMappings.capacity);
  for (let i = 0; i < n; i++) {
    const row = new Array(23).fill(null);
    row[1] = 'ORD' + i;
    row[2] = caps[i % caps.length];
    row[3] = '品名' + i;
    row[4] = '规格/DH010/外壳';
    row[7] = (i % 3) * 50;         // H
    row[8] = 100000;              // I（远大于累计，触发 I>K → L=0 快速路径）
    rows.push(row);
  }
  return rows;
}
const N = 20000;
const synth = ['h0', 'h1', 'h2'].concat(synthRows(N));
const t0 = process.hrtime.bigint();
let r2;
try {
  r2 = D.computeDetailRows(synth);
} catch (e) { console.log('[FAIL] 性能测试执行异常', e.message); }
const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;
check('D. 2 万行输出行数正确', r2 && r2.rows.length === N, r2 && r2.rows.length);
check('D. 2 万行耗时 < 1000ms', ms < 1000, ms.toFixed(2) + ' ms');
// O(n) 结构检查：函数体内无 slice/filter/sort 嵌套于行循环
const fnSrc = D.computeDetailRows.toString();
const hasNestedScan = /\.slice\(/.test(fnSrc) || /\.filter\(/.test(fnSrc) || /\.sort\(/.test(fnSrc);
check('D. computeDetailRows 无 slice/filter/sort 嵌套扫描', !hasNestedScan);

// ---------- 汇总 ----------
console.log('\n===== 汇总 =====');
console.log('总计 ' + total + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failed) {
  console.log('存在失败项，请见上方 [FAIL]。');
  process.exit(1);
} else {
  console.log('全部通过。');
}
