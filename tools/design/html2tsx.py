#!/usr/bin/env python3
"""Converts a design mockup (docs/design/*.dc.html) to a React TSX component plus a scoped CSS file.
Usage: html2tsx.py <in.html> <ComponentName> <scope-class> <out.tsx> <out.css>
Drops <x-dc>, <helmet>, <link>, <script>; keeps the markup and the page <style> (scoped under .<scope-class>)."""
import re, sys, json
from html.parser import HTMLParser

SVG_ATTR = {a.lower(): a for a in "viewBox patternUnits patternContentUnits preserveAspectRatio gradientUnits gradientTransform stdDeviation baseFrequency numOctaves stitchTiles markerWidth markerHeight refX refY maskUnits maskContentUnits textLength lengthAdjust startOffset clipPathUnits".split()}
SVG_TAG = {t.lower(): t for t in "linearGradient radialGradient clipPath foreignObject feTurbulence feColorMatrix feGaussianBlur textPath".split()}
VOID = {"area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"}
RENAME = {"class": "className", "for": "htmlFor", "tabindex": "tabIndex", "readonly": "readOnly", "maxlength": "maxLength", "colspan": "colSpan", "rowspan": "rowSpan", "xlink:href": "xlinkHref", "xmlns:xlink": "xmlnsXlink", "autocomplete": "autoComplete", "spellcheck": "spellCheck", "contenteditable": "contentEditable"}

def camel(s): return re.sub(r"-([a-z])", lambda m: m.group(1).upper(), s)

def style_obj(s):
    out = []
    for decl in [d for d in re.split(r";(?![^(]*\))", s) if d.strip()]:
        if ":" not in decl: continue
        k, v = decl.split(":", 1); k = k.strip(); v = v.strip()
        key = json.dumps(k) if k.startswith("--") else camel(k if not k.startswith("-") else k[1:].capitalize() if False else k)
        if k.startswith("-") and not k.startswith("--"): key = camel(k[1:]); key = key[0].upper() + key[1:]
        out.append(f"{key}: {json.dumps(v)}")
    return "{{" + ", ".join(out) + "}}"

def attr_name(n):
    if n in RENAME: return RENAME[n]
    if n in SVG_ATTR: return SVG_ATTR[n]
    if n.startswith("data-") or n.startswith("aria-"): return n
    return camel(n)

class Conv(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []; self.css = []; self.skip = 0; self.in_style = False; self.in_pre = 0; self.started = False
    def handle_starttag(self, tag, attrs, selfclose=False):
        if tag == "x-dc": self.started = True; return
        if tag == "title": self.skip += 1; return
        if tag in ("helmet", "html", "head", "body", "meta"): return
        if tag == "script": self.skip += 1; return
        if tag == "link": return
        if tag == "style": self.in_style = True; return
        if self.skip: return
        t = SVG_TAG.get(tag, tag)
        parts = []
        for n, v in attrs:
            if n == "style": parts.append(f"style={style_obj(v or '')}"); continue
            name = attr_name(n)
            if v is None: parts.append(name)
            else: parts.append(f"{name}={json.dumps(v)}")
        if tag == "pre": self.in_pre += 1
        close = "/>" if (tag in VOID or selfclose) else ">"
        self.out.append(f"<{t}{' ' if parts else ''}{' '.join(parts)}{close}")
    def handle_startendtag(self, tag, attrs): self.handle_starttag(tag, attrs, selfclose=True)
    def handle_endtag(self, tag):
        if tag == "title": self.skip = max(0, self.skip - 1); return
        if tag in ("x-dc", "helmet", "html", "head", "body", "meta", "link") or tag in VOID: return
        if tag == "script": self.skip = max(0, self.skip - 1); return
        if tag == "style": self.in_style = False; return
        if self.skip: return
        if tag == "pre": self.in_pre -= 1
        self.out.append(f"</{SVG_TAG.get(tag, tag)}>")
    def handle_data(self, d):
        if self.in_style: self.css.append(d); return
        if self.skip or self.in_style or not self.started: return
        if self.in_pre: self.out.append("{" + json.dumps(d) + "}"); return
        if not d.strip() and "\n" in d: return  # formatting newline between tags
        c = re.sub(r"\s+", " ", d)
        if not c: return
        if c == " ": self.out.append('{" "}'); return
        lead = '{" "}' if c.startswith(" ") else ""; trail = '{" "}' if c.endswith(" ") else ""
        body = c.strip()
        if re.search(r"[{}<>]", body): body = "{" + json.dumps(body) + "}"
        self.out.append(lead + body + trail)
    def handle_comment(self, d): pass

def scope_css(css, scope):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        sels = [s.strip() for s in m.group(1).split(",") if s.strip()]
        scoped = []
        for s in sels:
            if s in ("body", "html", ":root"): scoped.append(f".{scope}")
            elif s == "*": scoped.append(f".{scope} *")
            else: scoped.append(f".{scope} {s}")
        out.append(f"{', '.join(scoped)}{{{m.group(2).strip()}}}")
    return "\n".join(out) + "\n"

src, name, scope, out_tsx, out_css = sys.argv[1:6]
c = Conv(); c.feed(open(src, encoding="utf8").read())
jsx = "".join(c.out)
open(out_css, "w").write(f"/* Generated from {src.split('/')[-1]} (scoped to .{scope}). */\n" + scope_css("".join(c.css), scope))
open(out_tsx, "w").write(f"// Generated from docs/design/{src.split('/')[-1]} by tools/design/html2tsx.py, then edited by hand where marked.\n/* eslint-disable */\nimport \"./{out_css.split('/')[-1]}\";\n\nexport function {name}() {{\n  return (\n    <div className=\"{scope}\">{jsx}</div>\n  );\n}}\n")
print(name, len(jsx), "chars of JSX,", len(c.css), "chars of CSS")
