'use strict';
/* QA 校验脚本 02：上传重算逻辑独立验证（用 vm + 桩环境实际执行） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'D:/WorkBuddy工作资料/injection_dashboard';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 提取两段内联脚本
function extractInlineScripts(src) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}
const scripts = extractInlineScripts(html);
const dataScript = scripts.find(s => /EMBEDDED_DATA/.test(s));
let logicScript = scripts.find(s => /function renderKPI/.test(s));

// 注入导出，便于调用 IIFE 内部函数
const EXPORT_INJECT = '\n  globalThis.__QA = { parseDetail: parseDetail, parseValue: parseValue, normalizeWeek: normalizeWeek, mapMachineGroup: mapMachineGroup, extractMold: extractMold, parseWeek: parseWeek, sortWeeks: sortWeeks, yearForWeek: yearForWeek, num: num, sum: sum, toYearMonth: toYearMonth, excelDateToJSDate: excelDateToJSDate, normSheetName: normSheetName, findSheet: findSheet };\n';
const idx = logicScript.lastIndexOf('})();');
if (idx < 0) { console.error('未找到 IIFE 结尾'); process.exit(2); }
logicScript = logicScript.slice(0, idx) + EXPORT_INJECT + logicScript.slice(idx);

// 桩：XLSX.utils.sheet_to_json 直接把传入数组当 aoa 返回
const xlsxStub = { utils: { sheet_to_json: function (ws) { return ws; } } };
const sandbox = {
  window: {
    echarts: null,           // 渲染未执行，null 即可
    XLSX: xlsxStub,
    addEventListener: function () {}
  },
  document: {
    readyState: 'loading',   // 阻止自动 init()
    addEventListener: function () {},
    getElementById: function () { return null; }
  },
  FileReader: function () {},
  console: console
};
vm.createContext(sandbox);

const combined = dataScript + '\n;\n' + logicScript;
try {
  vm.runInContext(combined, sandbox, { filename: 'logic.js' });
} catch (e) {
  console.error('逻辑脚本在桩环境中执行失败：', e.message, '\n', e.stack);
  process.exit(2);
}

const Q = sandbox.__QA;
if (!Q) { console.error('未捕获到 __QA 导出'); process.exit(2); }

// ---- 轻量断言 ----
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('[PASS] ' + name + (detail ? ' — ' + detail : '')); }
  else { failed++; console.log('[FAIL] ' + name + (detail ? ' — ' + detail : '')); }
}
function close(a, b, eps) { return Math.abs(a - b) < (eps || 1e-9); }

// ---- a) 工时计算：周期60、数量1000、穴数2 → 60*1000/3600/2 = 8.3333 ----
(function testA() {
  const aoa = [
    ['表头0'], ['表头1'], ['表头2（品名/规格/工时/数量/周/机台/穴数/周期所在行）'],
    // D=3, E=4, J=9, L=11, P=15, Q=16, R=17, S=18
    ['x','x','x','产品A','602204458/DH010S/外壳W-0','x','x','x','x', null, 'x', 1000, 'x','x','x','2026WK30','260T', 2, 60],
  ];
  const r = Q.parseDetail(aoa);
  const expect = 60 * 1000 / 3600 / 2;
  const g = r.machine.groups['230T-280T'];
  const got = g ? g.real[0] : null;
  assert('a) 工时公式 60*1000/3600/2 = ' + expect.toFixed(4), g && close(got, expect), '实际 ' + got);
  assert('a) 260T 归入 230T-280T', !!g && r.machine.groups['230T-280T'].real.length === 1, '组存在且仅1周');
  const mold = r.mold.items.find(i => i.mold === 'DH010S');
  assert('a) 模具 DH010S 被识别并计工时', !!mold && close(mold.hours[0], expect), mold ? 'hours[0]=' + mold.hours[0] : '未找到');
})();

// ---- b) 机台分组：'0' → 其他，不计入机台产能 ----
(function testB() {
  const aoa = [
    ['h0'], ['h1'], ['h2'],
    ['x','x','x','产品B','x','x','x','x','x', null, 'x', 500, 'x','x','x','2026WK35','0', 1, 10],
  ];
  const r = Q.parseDetail(aoa);
  const keys = Object.keys(r.machine.groups);
  const hasOther = keys.includes('其他');
  const totalReal = keys.reduce((s,k)=>s+Q.sum(r.machine.groups[k].real),0);
  assert('b) 机台分组键不含"其他"', !hasOther, 'keys=' + JSON.stringify(keys));
  assert('b) "0" 的工时不计入任何机台组', totalReal === 0, '所有组 real 总和=' + totalReal);
  // 备料机台分布应含"其他"
  const byMachineOther = (r.backlog.byMachine || []).find(x => x.name === '其他');
  assert('b) 备料机台分布含"其他"且数量=500', !!byMachineOther && byMachineOther.value === 500, JSON.stringify(byMachineOther));
})();

// ---- c) 周归一化 ----
(function testC() {
  assert('c) 数字 21 → 2026WK21', Q.normalizeWeek(21) === '2026WK21', Q.normalizeWeek(21));
  assert('c) 数字 5 → 2027WK5', Q.normalizeWeek(5) === '2027WK5', Q.normalizeWeek(5));
  assert('c) 数字 20 → 2027WK20', Q.normalizeWeek(20) === '2027WK20', Q.normalizeWeek(20));
  assert('c) 字符串 2026WK21', Q.normalizeWeek('2026WK21') === '2026WK21', Q.normalizeWeek('2026WK21'));
  assert('c) 字符串 WK21 → 2026WK21', Q.normalizeWeek('WK21') === '2026WK21', Q.normalizeWeek('WK21'));
  assert('c) 字符串 WK5 → 2027WK5', Q.normalizeWeek('WK5') === '2027WK5', Q.normalizeWeek('WK5'));
  assert('c) 字符串 2026wk05（小写补零）', Q.normalizeWeek('2026wk05') === '2026WK5', Q.normalizeWeek('2026wk05'));
  assert('c) 带空格 2026 WK 21', Q.normalizeWeek('2026 WK 21') === '2026WK21', Q.normalizeWeek('2026 WK 21'));
  const d = new Date(2026, 0, 1); // 2026-01-01
  const dn = Q.normalizeWeek(d);
  assert('c) Date 对象 → YYYYWKx 格式', /^2026WK\d+$/.test(dn), dn);
  assert('c) 空/非法 → 未排期', Q.normalizeWeek('') === '未排期' && Q.normalizeWeek(null) === '未排期' && Q.normalizeWeek('abc') === '未排期', JSON.stringify([Q.normalizeWeek(''), Q.normalizeWeek(null), Q.normalizeWeek('abc')]));
})();

// ---- d) 模具提取 ----
(function testD() {
  assert('d) 规格 602204458/DH010S/外壳W-0 → DH010S', Q.extractMold('602204458/DH010S/外壳W-0', 'xxx') === 'DH010S', Q.extractMold('602204458/DH010S/外壳W-0', 'xxx'));
  assert('d) 小写 dh010s → DH010S', Q.extractMold('dh010s', null) === 'DH010S', Q.extractMold('dh010s', null));
  assert('d) 品名含 DH123 兜底', Q.extractMold(null, 'abc DH123 外壳') === 'DH123', Q.extractMold(null, 'abc DH123 外壳'));
  assert('d) 无模具 → null', Q.extractMold('abc', 'def') === null, String(Q.extractMold('abc','def')));
  assert('d) DH 后三位+可选字母 DH010S（含S）', /^DH\d{3}[A-Z]?$/.test('DH010S'), '格式校验');
})();

// ---- e) 空数据 / 无匹配表 ----
(function testE() {
  let err = null;
  try {
    const r = Q.parseDetail([]);
    assert('e) parseDetail([]) 不崩溃', true, 'weeks=' + r.machine.weeks.length + ', orders=' + r.backlog.totalOrders);
    assert('e) 空数据 totalOrders=0', r.backlog.totalOrders === 0);
    assert('e) 空数据 4 个规范组且全空', Object.keys(r.machine.groups).length === 4);
  } catch (e) { err = e; assert('e) parseDetail([]) 不崩溃', false, e.message); }
  // findSheet 无匹配 → null
  const wb = { SheetNames: ['Sheet1', '其他表'], Sheets: { Sheet1: {}, '其他表': {} } };
  assert('e) findSheet 无匹配返回 null', Q.findSheet(wb, '工单备料明细') === null, String(Q.findSheet(wb, '工单备料明细')));
  // findSheet 全角/空格归一化
  const wb2 = { SheetNames: ['原始数据1（工单备料明细）'], Sheets: {} };
  const fs2 = Q.findSheet(wb2, '工单备料明细');
  assert('e) findSheet 全角括号匹配', fs2 !== null, fs2 === null ? 'null' : '命中');
  // parseValue 空数据
  try {
    const pv = Q.parseValue([]);
    assert('e) parseValue([]) 不崩溃', true, 'months=' + pv.months.length);
  } catch (e2) { assert('e) parseValue([]) 不崩溃', false, e2.message); }
})();

// ---- f) 机台分组规则完整性（额外核对） ----
(function testF() {
  assert('f) 400T-550T → 400T-550T', Q.mapMachineGroup('400T-550T') === '400T-550T');
  assert('f) 230T-260T → 230T-280T', Q.mapMachineGroup('230T-260T') === '230T-280T');
  assert('f) 230T260T → 230T-280T', Q.mapMachineGroup('230T260T') === '230T-280T');
  assert('f) 150T → 150T', Q.mapMachineGroup('150T') === '150T');
  assert('f) 90T → 90T', Q.mapMachineGroup('90T') === '90T');
  assert('f) 空/未知 → 其他', Q.mapMachineGroup('') === '其他' && Q.mapMachineGroup('999T') === '其他');
  // 关键：150T-280T 是否被覆盖
  const r150_280 = Q.mapMachineGroup('150T-280T');
  console.log('[INFO] mapMachineGroup("150T-280T") =', JSON.stringify(r150_280), '（内嵌数据存在该组，上传重算将丢失该组，归入其他/不计机台产能）');
})();

// ---- g) parseValue 正确性 ----
(function testG() {
  const aoa = [
    ['入库日期','x','x','x','x','x','品名','x','x','入库数量','x','x','x','x','金额'],
    ['2026-01-15','x','x','x','x','x','外壳A','x','x', 10, 'x','x','x','x', 1000],
    ['2026-01-20','x','x','x','x','x','外壳B','x','x', 20, 'x','x','x','x', 500],
    ['2026-02-01','x','x','x','x','x','外壳A','x','x', 5, 'x','x','x','x', 300],
  ];
  const pv = Q.parseValue(aoa);
  assert('g) months 数量=2', pv.months.length === 2, JSON.stringify(pv.months));
  assert('g) 2026-01 amount=1500', pv.months.indexOf('2026-01') >= 0 && pv.amount[pv.months.indexOf('2026-01')] === 1500, JSON.stringify(pv.amount));
  assert('g) 2026-02 qty=5', pv.qty[pv.months.indexOf('2026-02')] === 5);
  const catA = pv.byCategory.find(c => c.name === '外壳A');
  assert('g) byCategory 外壳A=1300', !!catA && catA.value === 1300, JSON.stringify(catA));
})();

console.log('\n===== 重算逻辑测试汇总 =====');
console.log('通过 ' + passed + '，失败 ' + failed);
process.exit(failed ? 1 : 0);
