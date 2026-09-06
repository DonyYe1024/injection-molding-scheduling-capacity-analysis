# -*- coding: utf-8 -*-
"""把 index.html 的 CDN 引用替换为内嵌本地库，生成离线可运行的单文件 HTML。"""
import io, os

DIR = r"D:\WorkBuddy工作资料\injection_dashboard"
SRC = os.path.join(DIR, "index.html")
OUT = os.path.join(DIR, "index.html")  # 直接覆盖（已由外部备份）

with open(SRC, "r", encoding="utf-8") as f:
    html = f.read()

echarts = open(os.path.join(DIR, "echarts.min.js"), "r", encoding="utf-8").read()
xlsx = open(os.path.join(DIR, "xlsx.full.min.js"), "r", encoding="utf-8").read()

# 替换两处 CDN script 为内嵌 script
echarts_tag = '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js" onerror="window.__echartsFail=true"></script>'
xlsx_tag = '<script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js" onerror="window.__xlsxFail=true"></script>'

assert echarts_tag in html, "未找到 echarts CDN 标签"
assert xlsx_tag in html, "未找到 xlsx CDN 标签"

html = html.replace(echarts_tag, '<script>\n' + echarts + '\n</script>')
html = html.replace(xlsx_tag, '<script>\n' + xlsx + '\n</script>')

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

print("打包完成 ->", OUT)
print("文件大小:", os.path.getsize(OUT), "bytes (", round(os.path.getsize(OUT)/1024/1024, 2), "MB )")
print("已移除 CDN 引用:", 'cdn.' not in html[:2000])
