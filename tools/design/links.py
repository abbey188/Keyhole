#!/usr/bin/env python3
"""Maps the design's placeholder links to real routes in the generated pages. Usage: links.py <file.tsx> landing|doc"""
import re, sys
REPO = "https://github.com/abbey188/Keyhole"
COMMON = {"#open-app": "/app", "#github": REPO, "#licence": REPO + "#licence", "#home": "/"}
LANDING = {"#developers-page": "/developers", "#limits-page": "/limits", "#proof-page": "/proof", "#security-page": "/security", "#trust-page": "/trust"}
DOC = {"#how": "/#how", "#trust": "/trust", "#security": "/security", "#limits": "/limits", "#developers": "/developers", "#proof": "/proof"}
p, kind = sys.argv[1], sys.argv[2]
s = open(p).read()
table = {**COMMON, **(LANDING if kind == "landing" else DOC)}
s = re.sub(r'href="(#[^"]*)"', lambda m: f'href="{table.get(m.group(1), m.group(1))}"', s)
open(p, "w").write(s)
left = sorted(set(re.findall(r'href="(#[^"]*)"', s)))
print(p.split("/")[-1], "in-page anchors left:", left)
