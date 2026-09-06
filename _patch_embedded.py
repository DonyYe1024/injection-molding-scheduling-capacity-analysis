# -*- coding: utf-8 -*-
"""把 4 个抽取 JSON 重新内嵌进 index.html 的 4 个 EMBEDDED 常量（通用注入器）"""
import json, os

HTML = r"D:\WorkBuddy工作资料\injection_dashboard\index.html"

# marker -> json 文件（marker 用 "const XXX" 前缀精确定位，避免前缀混淆）
TARGETS = [
    ("const EMBEDDED_DATA",      r"D:\WorkBuddy工作资料\injection_dashboard\data.json"),
    ("const EMBEDDED_MAPPINGS",  r"D:\WorkBuddy工作资料\injection_dashboard\mappings.json"),
    ("const EMBEDDED_ANALYSIS",  r"D:\WorkBuddy工作资料\injection_dashboard\analysis_data.json"),
    ("const EMBEDDED_GAP",       r"D:\WorkBuddy工作资料\injection_dashboard\gap_material_data.json"),
]

html = open(HTML, encoding="utf-8").read()


def find_json_bounds(text, marker):
    idx = text.index(marker)
    brace = text.index("{", idx)
    depth = 0
    in_str = False
    esc = False
    for i in range(brace, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return brace, i
    raise AssertionError("未找到 %s 的 JSON 结尾" % marker)


edits = []
for marker, jpath in TARGETS:
    data = json.load(open(jpath, encoding="utf-8"))
    new_json = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    new_json = new_json.replace("</", "\\u003c/")   # 防止 </ 破坏 script 标签
    json.loads(new_json)                             # 校验新 JSON 可 parse
    brace, end = find_json_bounds(html, marker)
    edits.append((brace, end, new_json, marker.replace("const ", ""), end + 1 - brace, len(new_json)))
    print("%s: 旧=%d 新=%d chars" % (marker.replace("const ", ""), end + 1 - brace, len(new_json)))

# 逆序替换，避免偏移
for brace, end, new_json, name, old_len, new_len in sorted(edits, key=lambda e: e[0], reverse=True):
    html = html[:brace] + new_json + html[end + 1:]

open(HTML, "w", encoding="utf-8").write(html)
print("已写回 index.html，新大小:", len(html.encode("utf-8")), "bytes")
