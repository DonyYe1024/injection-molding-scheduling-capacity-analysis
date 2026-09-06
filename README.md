# 注塑排程产能分析 · Injection Molding Scheduling & Capacity Analysis

> 注塑厂产能分析单文件 HTML 看板 | A single-file HTML dashboard for injection molding capacity analysis.

## 项目简介 · Overview

本项目是一个**单文件 HTML 注塑产能分析看板**，数据由源工作簿《最新排程产能分析-公式模板-最新.xlsm》经 Python 脚本抽取、聚合、注入，内嵌于单个 `index.html`；同时支持在页面上传 Excel（工单备料明细 / 最新主排程 / 最新预算）实时重算覆盖。

This is a **single-file HTML dashboard** for injection molding capacity analysis. Data is extracted/aggregated from the source workbook `最新排程产能分析-公式模板-最新.xlsm` by Python scripts and embedded into a single `index.html`; it also supports uploading Excel files on-page to recalculate in real time.

## 功能模块 · Modules

- **月度注塑机台负荷仪表盘** · Monthly injection machine load gauge
- **机台产能分析** · Machine capacity analysis（堆叠柱 + 产能折线，带机台组 Tab 与显示周数滑动条）
- **模具产能分析 · 品种** · Mold capacity by variety（带品种搜索下拉 + 显示周数滑动条）
- **模具产能 GAP** · Mold capacity GAP（王力预算）
- **实单+预算待生产前十占比** · Top-10 by real-order + budget PCS（外壳/配件双饼图）
- **注塑原料 1+7 需求推算** · Material demand forecast（首列「使用产品」）
- **注塑外壳库存水位** · Shell stock water level（饼图 + D36:F42 明细表）
- **入库汇总 / 年度汇总** · Inbound summary / Annual summary（金额 0 位小数，达成率 <100% 标红）
- **月历** · Calendar（含农历、月份切换、可拖拽）

## 快速开始 · Quick Start

双击 `injection_dashboard/index.html` 用浏览器打开即可（首次需联网加载 ECharts / SheetJS CDN）。

Open `injection_dashboard/index.html` in a browser (first load requires network for ECharts / SheetJS CDN).

## 目录结构 · Structure

```
├── index.html                 # 看板（在 injection_dashboard/ 下）
├── injection_dashboard/
│   ├── index.html             # 核心看板（单文件，数据+逻辑+视图内嵌）
│   ├── README_项目说明.html    # 项目说明（复现/维护/增删模块指引）
│   ├── overview.md            # 概览
│   ├── data.json / mappings.json / analysis_data.json / gap_material_data.json  # 4 个内嵌数据源
│   ├── 改善*.txt               # 迭代改善清单（按版本增量记录）
│   ├── _bundle_offline.py     # 离线打包脚本
│   └── _qa_check/             # QA 独立验证脚本 + 黄金测试数据
├── _extract_data.py           # 抽取脚本：机台/模具主数据
├── _extract_mappings.py       # 抽取脚本：产能/BOM/上线日期映射
├── _extract_analysis.py       # 抽取脚本：分析2/分析3
├── _extract_gap.py            # 抽取脚本：GAP + 原料需求 + 库存水位 + 入库/年度汇总
├── _patch_embedded.py         # 注入器：把 4 个 JSON 内嵌回 index.html
├── _patch_mappings.py         # 映射补丁
├── 产能分析-数据字典与描述文档.md   # 源工作簿数据字典
└── 个人工作台-提示词清单.md        # 提示词清单
```

## 数据抽取 · Data Extraction

内置数据由 4 个 Python 抽取脚本生成 4 个 JSON，再由 `_patch_embedded.py` 注入 `index.html` 的 4 个 `EMBEDDED_*` 常量：

1. `_extract_data.py` → `data.json`（EMBEDDED_DATA）
2. `_extract_mappings.py` → `mappings.json`（EMBEDDED_MAPPINGS）
3. `_extract_analysis.py` → `analysis_data.json`（EMBEDDED_ANALYSIS）
4. `_extract_gap.py` → `gap_material_data.json`（EMBEDDED_GAP）

> 注：源 Excel 数据文件（xlsm/xlsx，含真实订单/库存数据）未纳入本仓库。

> Note: Source Excel data files (xlsm/xlsx with real order/inventory data) are NOT included in this repository.

## 技术栈 · Tech Stack

- 原生 HTML + CSS + 原生 JS（IIFE）
- [ECharts 5.5.0](https://echarts.apache.org/)（图表）
- [SheetJS 0.20.3](https://sheetjs.com/)（上传 Excel 解析）

## 许可 · License

私有仓库 · Private repository
