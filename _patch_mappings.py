# -*- coding: utf-8 -*-
"""把修正后的 mappings.json 重新内嵌进 index.html 的 EMBEDDED_MAPPINGS"""
import json, re

HTML = r"D:\WorkBuddy工作资料\injection_dashboard\index.html"
MAPP = r"D:\WorkBuddy工作资料\injection_dashboard\mappings.json"

html = open(HTML, encoding="utf-8").read()
mappings = json.load(open(MAPP, encoding="utf-8"))

# 定位 EMBEDDED_MAPPINGS 的 JSON 对象（括号匹配）
marker = "EMBEDDED_MAPPINGS"
idx = html.index(marker)
brace = html.index("{", idx)
# 括号匹配找结束
depth = 0
end = -1
in_str = False
esc = False
for i in range(brace, len(html)):
    c = html[i]
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
                end = i
                break
assert end > 0, "未找到 EMBEDDED_MAPPINGS JSON 结尾"

old_json = html[brace:end+1]
new_json = json.dumps(mappings, ensure_ascii=False, separators=(",", ":"))
# 防止 </ 破坏 script 标签
new_json = new_json.replace("</", "\\u003c/")

print("旧 JSON 长度:", len(old_json), " 新 JSON 长度:", len(new_json))
# 校验新 JSON 可解析
json.loads(new_json)
print("新 JSON 解析通过")

html2 = html[:brace] + new_json + html[end+1:]
open(HTML, "w", encoding="utf-8").write(html2)
print("已写回 index.html，新大小:", len(html2.encode("utf-8")), "bytes")

# 验证：替换后 EMBEDDED_MAPPINGS 里 2090000287 周期
m = re.search(r'2090000287[^}]*?}', new_json)
print("替换后 2090000287 片段:", m.group(0)[:80] if m else "未找到")
