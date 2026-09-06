'use strict';
/* QA 校验脚本 01：文件结构 / JS 语法 / 数据内嵌一致性 */
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/WorkBuddy工作资料/injection_dashboard';
const HTML = path.join(ROOT, 'index.html');
const JSONF = path.join(ROOT, 'data.json');

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' — ' + detail : ''));
}

// ---------- 1. 文件与结构 ----------
const htmlExists = fs.existsSync(HTML);
const jsonExists = fs.existsSync(JSONF);
report('index.html 存在', htmlExists, htmlExists ? (fs.statSync(HTML).size + ' bytes') : '缺失');
report('data.json 存在', jsonExists, jsonExists ? (fs.statSync(JSONF).size + ' bytes') : '缺失');

const html = fs.readFileSync(HTML, 'utf8');

const hasEmbedded = /EMBEDDED_DATA/.test(html);
const hasEcharts = /echarts(@|\/)/.test(html) || /cdn\.jsdelivr\.net\/npm\/echarts/.test(html);
const hasSheetJS = /xlsx\.full\.min\.js|sheetjs/.test(html);
const hasUploadDom = /id="uploadBtn"/.test(html) && /id="fileInput"/.test(html) && /id="dropzone"/.test(html);
const hasUploadFn = /function handleFile/.test(html) && /function parseDetail/.test(html) && /function parseValue/.test(html);
report('含 EMBEDDED_DATA', hasEmbedded);
report('引用 ECharts CDN', hasEcharts);
report('引用 SheetJS CDN', hasSheetJS);
report('含上传相关 DOM 元素', hasUploadDom);
report('含上传/重算函数', hasUploadFn);

// 提取两段内联 script
function extractInlineScripts(src) {
  // 匹配 <script> ... </script> 不带 src 属性
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push(m[1]);
  }
  return out;
}
const scripts = extractInlineScripts(html);
report('内联 script 段数量 = 2', scripts.length === 2, '实际 ' + scripts.length + ' 段');
const dataScript = scripts.find(s => /EMBEDDED_DATA/.test(s)) || '';
const logicScript = scripts.find(s => /function renderKPI/.test(s)) || '';
report('识别出数据段脚本', !!dataScript);
report('识别出逻辑段脚本', !!logicScript);

// ---------- 2. JS 语法检查 ----------
function syntaxCheck(code, label) {
  try {
    // 编译检测（不执行）
    new Function(code);
    report('语法检查：' + label, true);
    return true;
  } catch (e) {
    report('语法检查：' + label, false, e.message);
    return false;
  }
}
syntaxCheck(dataScript, '数据段 (EMBEDDED_DATA)');
syntaxCheck(logicScript, '逻辑段 (IIFE)');

// ---------- 3. 数据内嵌一致性 ----------
// 从数据段脚本提取 JSON 对象字面量
function extractEmbeddedJson(code) {
  const m = code.match(/const\s+EMBEDDED_DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
  if (!m) return null;
  return m[1];
}
const embeddedJsonText = extractEmbeddedJson(dataScript);
report('可抽取 EMBEDDED_DATA 对象字面量', !!embeddedJsonText);

let embedded = null;
let embeddedErr = null;
try {
  embedded = JSON.parse(embeddedJsonText);
  report('EMBEDDED_DATA 可 JSON.parse', true);
} catch (e) {
  embeddedErr = e;
  report('EMBEDDED_DATA 可 JSON.parse', false, e.message);
}

// 检查裸 </script> 串
const rawScriptClose = /<\/script/i.test(embeddedJsonText || '');
report('内嵌 JSON 无裸 </script>', !rawScriptClose, rawScriptClose ? '发现裸 </script>' : '已转义（用 \\u003c）');
const hasEscaped = /\\u003c/i.test(embeddedJsonText || '');
report('存在 \\u003c 转义', hasEscaped);

// 读 data.json
let ref = null;
try {
  ref = JSON.parse(fs.readFileSync(JSONF, 'utf8'));
  report('data.json 可 JSON.parse', true);
} catch (e) {
  report('data.json 可 JSON.parse', false, e.message);
}

if (embedded && ref) {
  // meta.totalOrders
  const t1 = embedded.meta && embedded.meta.totalOrders;
  report('meta.totalOrders === 21615', t1 === 21615, '实际 ' + t1 + '（data.json=' + (ref.meta && ref.meta.totalOrders) + '）');

  // machine.weeks.length
  const wLen = embedded.machine && embedded.machine.weeks && embedded.machine.weeks.length;
  report('machine.weeks.length === 53', wLen === 53, '实际 ' + wLen + '（data.json=' + (ref.machine.weeks.length) + '）');

  // machine.groups 5 keys
  const gKeys = embedded.machine && embedded.machine.groups ? Object.keys(embedded.machine.groups) : [];
  report('machine.groups 有 5 个键', gKeys.length === 5, '实际 ' + gKeys.length + ' → ' + JSON.stringify(gKeys));
  const expectedGroups = ['400T-550T', '230T-280T', '150T', '90T', '150T-280T'];
  report('machine.groups 键集合正确', expectedGroups.every(k => gKeys.includes(k)), JSON.stringify(gKeys));

  // material.items.length
  const matLen = embedded.material && embedded.material.items ? embedded.material.items.length : null;
  report('material.items.length === 154', matLen === 154, '实际 ' + matLen + '（data.json=' + (ref.material && ref.material.items.length) + '）');

  // mold.items.length
  const moldLen = embedded.mold && embedded.mold.items ? embedded.mold.items.length : null;
  report('mold.items.length === 76', moldLen === 76, '实际 ' + moldLen + '（data.json=' + (ref.mold && ref.mold.items.length) + '）');

  // productionValue.months.length
  const pvLen = embedded.productionValue && embedded.productionValue.months ? embedded.productionValue.months.length : null;
  report('productionValue.months.length === 50', pvLen === 50, '实际 ' + pvLen + '（data.json=' + (ref.productionValue && ref.productionValue.months.length) + '）');

  // 抽查数组
  const grp = embedded.machine.groups['400T-550T'];
  const grpRef = ref.machine.groups['400T-550T'];
  if (grp && grpRef) {
    const sample = grp.real.slice(0, 3);
    const sampleRef = grpRef.real.slice(0, 3);
    const eq = JSON.stringify(sample) === JSON.stringify(sampleRef);
    report('抽查 400T-550T.real 前3值一致', eq, JSON.stringify(sample) + ' vs ' + JSON.stringify(sampleRef));
  } else {
    report('抽查 400T-550T.real 前3值一致', false, '缺少该组');
  }

  // 深度一致性：整体比对（先 JSON 序列化比对）
  const embeddedStr = JSON.stringify(embedded);
  const refStr = JSON.stringify(ref);
  report('EMBEDDED_DATA 与 data.json 完全一致', embeddedStr === refStr,
    embeddedStr === refStr ? '逐字节一致' : '存在差异（长度 embedded=' + embeddedStr.length + ' ref=' + refStr.length + '）');

  // 90T budget 是否 null 数组
  const g90 = embedded.machine && embedded.machine.groups && embedded.machine.groups['90T'];
  if (g90) {
    const budgetAllNull = Array.isArray(g90.budget) && g90.budget.every(v => v === null);
    report('90T.budget 为全 null 数组', budgetAllNull, '长度 ' + (g90.budget ? g90.budget.length : '?'));
  }

  // 顶层键
  report('内嵌数据含 backlog 键（渲染依赖）', !!embedded.backlog, JSON.stringify(Object.keys(embedded)));
}

console.log('\n===== 汇总 =====');
const fails = results.filter(r => !r.pass);
console.log('总计 ' + results.length + ' 项，通过 ' + (results.length - fails.length) + '，失败 ' + fails.length);
if (fails.length) {
  console.log('失败项：');
  fails.forEach(f => console.log('  - ' + f.name + (f.detail ? '：' + f.detail : '')));
}
process.exit(fails.length ? 1 : 0);
