#!/usr/bin/env python3
"""
Nebula product film — illustrated scenes.

Draws each scene as an SVG in the same hand-built style as
docs/assets/nebula-hero.svg (slate palette, lucide icons as paths, rounded
cards, app-accurate chrome), rasterises with rsvg-convert, and assembles an
mp4 with ffmpeg crossfades. No screen recording, no live server, no fixtures
— so the film can be regenerated any time the product changes.

Usage:
  python3 scripts/demo-illustrate.py svg     # scenes -> build/film/*.svg
  python3 scripts/demo-illustrate.py png     # + rasterise to *.png
  python3 scripts/demo-illustrate.py video   # + assemble build/film/nebula-tour.mp4
  python3 scripts/demo-illustrate.py poster  # hero poster still (README)
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "build", "film")
W, H = 960, 540                      # logical canvas (16:9); rendered at 2x
FPS = 30

# ---------------------------------------------------------------- palette --
INK      = "#0f172a"   # headings
BODY     = "#334155"   # body text
MUTED    = "#94a3b8"   # secondary text
LINE     = "#e5e9f0"   # card borders
RULE     = "#e2e8f0"   # hairlines
PAGE     = "#f8fafc"   # app background
CARD     = "#ffffff"
GREEN    = "#16a34a"
GREEN_BG = "#f0fdf4"
PURPLE   = "#9d2ce8"
PURPLE_L = "#f5f3ff"
PURPLE_R = "#c4b5fd"
AMBER    = "#d97706"
AMBER_BG = "#fffbeb"
AMBER_LN = "#fde68a"
BLUE     = "#2563eb"
BLUE_BG  = "#eff6ff"
RED      = "#dc2626"
RED_BG   = "#fef2f2"
SLATE_BG = "#eef2f6"
MONO     = "ui-monospace, SFMono-Regular, Menlo, monospace"
SANS     = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
# syntax
KW, STR, NUM, PLAIN, COM = "#a626a4", "#b3403a", "#0d9488", "#1e293b", "#c2563c"

# ------------------------------------------------------------------ icons --
# lucide 24x24 path data, drawn at any scale (matches the hero illustration).
ICONS = {
    "play":      ['<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>'],
    "bot":       ['<path d="M12 8V4H8"/>', '<rect width="16" height="12" x="4" y="8" rx="2"/>',
                  '<path d="M2 14h2"/>', '<path d="M20 14h2"/>', '<path d="M15 13v2"/>', '<path d="M9 13v2"/>'],
    "chev_down": ['<path d="m6 9 6 6 6-6"/>'],
    "chev_right":['<path d="m9 18 6-6-6-6"/>'],
    "check":     ['<path d="M20 6 9 17l-5-5"/>'],
    "check_circ":['<circle cx="12" cy="12" r="10"/>', '<path d="m9 12 2 2 4-4"/>'],
    "terminal":  ['<path d="m4 17 6-6-6-6"/>', '<path d="M12 19h8"/>'],
    "history":   ['<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>',
                  '<path d="M3 3v5h5"/>', '<path d="M12 7v5l4 2"/>'],
    "search":    ['<circle cx="11" cy="11" r="8"/>', '<path d="m21 21-4.3-4.3"/>'],
    "undo":      ['<path d="M9 14 4 9l5-5"/>',
                  '<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>'],
    "up_to_line":['<path d="m18 9-6-6-6 6"/>', '<path d="M12 3v14"/>', '<path d="M5 21h14"/>'],
    "dn_to_line":['<path d="M12 17V3"/>', '<path d="m6 11 6 6 6-6"/>', '<path d="M19 21H5"/>'],
    "collapse":  ['<path d="m7 20 5-5 5 5"/>', '<path d="m7 4 5 5 5-5"/>'],
    "expand":    ['<path d="m7 15 5 5 5-5"/>', '<path d="m7 9 5-5 5 5"/>'],
    "cpu":       ['<rect width="16" height="16" x="4" y="4" rx="2"/>', '<rect width="6" height="6" x="9" y="9" rx="1"/>',
                  '<path d="M15 2v2"/>', '<path d="M15 20v2"/>', '<path d="M2 15h2"/>', '<path d="M2 9h2"/>',
                  '<path d="M20 15h2"/>', '<path d="M20 9h2"/>', '<path d="M9 2v2"/>', '<path d="M9 20v2"/>'],
    "server":    ['<rect width="20" height="8" x="2" y="2" rx="2"/>', '<rect width="20" height="8" x="2" y="14" rx="2"/>',
                  '<path d="M6 6h.01"/>', '<path d="M6 18h.01"/>'],
    "shield":    ['<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'],
    "key":       ['<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L18.9 4"/>',
                  '<path d="m21 2-9.6 9.6"/>', '<circle cx="7.5" cy="15.5" r="5.5"/>'],
    "lock":      ['<rect width="18" height="11" x="3" y="11" rx="2"/>', '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>'],
    "file_text": ['<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>',
                  '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>', '<path d="M10 9H8"/>', '<path d="M16 13H8"/>', '<path d="M16 17H8"/>'],
    "save":      ['<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>',
                  '<path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/>', '<path d="M7 3v4a1 1 0 0 0 1 1h7"/>'],
    "menu":      ['<path d="M4 5h16"/>', '<path d="M4 12h16"/>', '<path d="M4 19h16"/>'],
    "sparkles":  ['<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'],
    "alert":     ['<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>',
                  '<path d="M12 9v4"/>', '<path d="M12 17h.01"/>'],
    "x_circle":  ['<circle cx="12" cy="12" r="10"/>', '<path d="m15 9-6 6"/>', '<path d="m9 9 6 6"/>'],
    "eye":       ['<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>',
                  '<circle cx="12" cy="12" r="3"/>'],
    "layers":    ['<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/>',
                  '<path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/>'],
    "folder":    ['<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'],
    "refresh":   ['<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>', '<path d="M21 3v5h-5"/>',
                  '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>', '<path d="M3 21v-5h5"/>'],
}


def icon(name, x, y, size=16, stroke=BODY, width=2.0):
    """A lucide glyph at (x,y) with the given box size."""
    s = size / 24.0
    body = "".join(ICONS[name])
    return (f'<g transform="translate({x},{y}) scale({s:.4f})" fill="none" stroke="{stroke}" '
            f'stroke-width="{width/s*0.0 + width:.2f}" stroke-linecap="round" stroke-linejoin="round">{body}</g>')


# ------------------------------------------------------------- primitives --
def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def txt(x, y, s, size=13, fill=BODY, weight=None, anchor=None, family=None, opacity=None):
    a = f' text-anchor="{anchor}"' if anchor else ""
    w = f' font-weight="{weight}"' if weight else ""
    f = f' font-family="{family}"' if family else ""
    o = f' opacity="{opacity}"' if opacity is not None else ""
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}"{w}{a}{f}{o}>{esc(s)}</text>'


def rect(x, y, w, h, r=8, fill=CARD, stroke=None, sw=1, opacity=None, dash=None):
    s = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    o = f' opacity="{opacity}"' if opacity is not None else ""
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"{s}{o}{d}/>'


def line(x1, y1, x2, y2, stroke=RULE, sw=1):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"/>'


def pill(x, y, label, fill, text_fill, size=10.5, pad=8, h=18, weight="600"):
    w = len(label) * size * 0.58 + pad * 2
    return (rect(x, y, w, h, r=h / 2, fill=fill) +
            txt(x + w / 2, y + h * 0.71, label, size=size, fill=text_fill, weight=weight, anchor="middle")), w


def button(x, y, label, icon_name=None, fill=INK, fg="#ffffff", h=26, size=12, pad=11, border=None):
    tw = len(label) * size * 0.56
    iw = 15 if icon_name else 0
    w = pad * 2 + iw + tw
    out = rect(x, y, w, h, r=7, fill=fill, stroke=border, sw=1)
    if icon_name:
        out += icon(icon_name, x + pad, y + (h - 13) / 2, 13, fg, 2.1)
    out += txt(x + pad + iw, y + h * 0.68, label, size=size, fill=fg, weight="600")
    return out, w


def code_line(x, y, spans, size=11.5):
    """spans: list of (text, color)."""
    out = [f'<text x="{x}" y="{y}" font-size="{size}" font-family="{MONO}" xml:space="preserve">']
    for s, c in spans:
        out.append(f'<tspan fill="{c}">{esc(s)}</tspan>')
    out.append("</text>")
    return "".join(out)


def svg_open(w=W, h=H, bg=PAGE):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'font-family="{SANS}">'
            '<defs>'
            '<filter id="sh" x="-6%" y="-6%" width="112%" height="115%">'
            f'<feDropShadow dx="0" dy="3" stdDeviation="7" flood-color="{INK}" flood-opacity="0.13"/></filter>'
            '<filter id="glow" x="-30%" y="-30%" width="160%" height="160%">'
            '<feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="#9d2ce8" flood-opacity="0.45"/></filter>'
            '</defs>'
            f'<rect width="{w}" height="{h}" fill="{bg}"/>')


def caption(text, sub=None):
    """Lower-third caption bar, matching the film's previous look."""
    y = H - 78
    out = [f'<rect x="0" y="{y}" width="{W}" height="78" fill="{INK}" opacity="0.93"/>']
    out.append(txt(48, y + (32 if sub else 44), text, size=21, fill="#ffffff", weight="600"))
    if sub:
        out.append(txt(48, y + 56, sub, size=13.5, fill="#cbd5e1"))
    return "".join(out)


# ----------------------------------------------------------- app chrome ----
def app_shell(title="exoplanets", ext=".ipynb", kernel="Python 3.12 (Nebula)",
              saved="2m ago", run_label="Run All", agent=True, y=26, h=None, content_h=None,
              run_disabled=False):
    """The notebook window: title row, kernel row, toolbar buttons.

    `content_h` sizes the card to what it actually holds (an app window with a
    lake of white space under two cells reads as a mockup, not a product)."""
    if content_h is not None:
        h = 70 + content_h + 18
    h = h or (H - 78 - y - 18)
    out = [f'<g filter="url(#sh)">{rect(24, y, W - 48, h, r=11, fill=CARD, stroke=LINE)}</g>']
    out.append(icon("menu", 40, y + 16, 15, BODY, 1.9))
    out.append(txt(64, y + 28, title, size=15, fill=INK, weight="700"))
    tw = len(title) * 8.6
    out.append(rect(70 + tw, y + 13, 42, 17, r=5, fill=SLATE_BG))
    out.append(txt(91 + tw, y + 25, ext, size=9.5, fill=MUTED, anchor="middle"))
    # kernel row
    out.append(f'<circle cx="46" cy="{y + 50}" r="3.5" fill="#22c55e"/>')
    out.append(txt(55, y + 54, kernel, size=11, fill=BODY))
    kw = len(kernel) * 5.9
    out.append(icon("check", 62 + kw, y + 45, 11, GREEN, 2.4))
    out.append(txt(77 + kw, y + 54, f"Saved {saved}", size=11, fill=MUTED))
    # toolbar right
    x = W - 64
    if agent:
        bw = button(0, 0, "Agent", "bot", PURPLE)[1]
        x -= bw
        out.append(button(x, y + 11, "Agent", "bot", PURPLE)[0])
        x -= 10
    # Run All is a split button: the ▾ opens run-above / run-below, so the
    # chevron's 17px must be reserved BEFORE placing the main button.
    run_fill = "#cbd5e1" if run_disabled else INK
    b, bw = button(0, 0, run_label, "play", run_fill)
    x -= 17
    out.append(rect(x, y + 11, 17, 26, r=7, fill=run_fill))
    out.append(icon("chev_down", x + 3.5, y + 18, 11, "#ffffff", 2.2))
    x -= bw
    out.append(button(x, y + 11, run_label, "play", run_fill)[0])
    out.append(rect(x + bw - 6, y + 11, 6, 26, r=0, fill=run_fill))
    x -= 12
    for name in ("save", "search", "history"):
        x -= 24
        out.append(icon(name, x, y + 17, 15, "#475569", 1.9))
    return "".join(out), y + 70, h


def cell(x, y, w, *, idx="1", count=None, lines=(), out_lines=(), img=None,
         active=False, ring=None, running=False, ms=None, collapsed=False,
         err=False, pad=10, lh=17, toolbar=True):
    """One notebook cell card, drawn like the app renders it."""
    head = 22 if toolbar else 0
    body_h = pad * 2 + max(len(lines), 1) * lh
    if collapsed:
        body_h = min(body_h, 64)
    out_h = 0
    if out_lines:
        out_h = 8 + len(out_lines) * 15 + 6
    if img:
        out_h = img[1] + 12
    h = head + body_h + out_h
    stroke = PURPLE_R if ring else ("#bfdbfe" if active else LINE)
    sw = 1.6 if (ring or active) else 1
    g = []
    if ring:
        g.append(f'<g filter="url(#glow)">{rect(x, y, w, h, r=9, fill=CARD, stroke=PURPLE_R, sw=1.6)}</g>')
    else:
        g.append(rect(x, y, w, h, r=9, fill=CARD, stroke=stroke, sw=sw))
    if toolbar:
        g.append(rect(x + 1, y + 1, w - 2, head, r=8, fill="#f8fafc"))
        g.append(line(x + 1, y + head, x + w - 1, y + head, RULE))
        g.append(txt(x + 10, y + 15, f"#{idx}", size=9.5, fill=MUTED, family=MONO))
        mark = "[*]" if running else (f"[{count}]" if count else "[ ]")
        mcol = AMBER if running else (GREEN if count else MUTED)
        g.append(txt(x + 28, y + 15, mark, size=9.5, fill=mcol, family=MONO))
        bx = x + 52
        for nm in ("play", "bot"):
            g.append(icon(nm, bx, y + 5, 12, "#64748b", 1.8))
            bx += 19
        if collapsed:
            g.append(rect(bx - 3, y + 3, 17, 16, r=4, fill=BLUE_BG))
            g.append(icon("expand", bx, y + 5, 12, BLUE, 1.9))
        if ms:
            g.append(txt(x + w - 10, y + 15, ms, size=9.5, fill=GREEN, family=MONO, anchor="end"))
    ty = y + head + pad + 10
    shown = lines[:3] if collapsed else lines
    for ln in shown:
        g.append(code_line(x + 12, ty, ln))
        ty += lh
    if collapsed:
        fy = y + head + body_h - 30
        g.append(f'<linearGradient id="fade{idx}" x1="0" x2="0" y1="0" y2="1">'
                 f'<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>'
                 f'<stop offset="1" stop-color="#ffffff" stop-opacity="1"/></linearGradient>')
        g.append(f'<rect x="{x + 2}" y="{fy}" width="{w - 4}" height="23" fill="url(#fade{idx})"/>')
        g.append(rect(x + 1, y + head + body_h - 7, w - 2, 7, r=0, fill="#f8fafc"))
        g.append(rect(x + w / 2 - 12, y + head + body_h - 4.5, 24, 2, r=1, fill="#cbd5e1"))
    if out_lines or img:
        oy = y + head + body_h
        g.append(line(x + 1, oy, x + w - 1, oy, RULE))
        if img:
            g.append(img[0].replace("__X__", str(x + 12)).replace("__Y__", str(oy + 6)))
        else:
            ly = oy + 18
            for ln, col in out_lines:
                g.append(code_line(x + 12, ly, [(ln, col)], size=11))
                ly += 15
    return "".join(g), h


def scatter_plot(w=380, h=120):
    """A small matplotlib-looking scatter, as in the hero."""
    import random
    random.seed(7)
    pts = []
    cols = ["#38bdf8", "#f59e0b", "#f472b6"]
    for i in range(120):
        px = random.random() ** 0.7
        py = random.random() ** 1.6
        pts.append(f'<circle cx="{28 + px * (w - 46):.1f}" cy="{h - 22 - py * (h - 40):.1f}" r="2" '
                   f'fill="{cols[i % 3]}" opacity="0.72"/>')
    hz = ''.join(f'<circle cx="{60 + i * 47}" cy="{h - 44 - (i % 3) * 13}" r="6.5" fill="none" '
                 f'stroke="#7c3aed" stroke-width="1.4"/>' for i in range(4))
    body = (f'<g transform="translate(__X__,__Y__)">'
            f'{rect(0, 0, w, h, r=6, fill="#ffffff", stroke=RULE)}'
            f'<line x1="26" y1="{h - 20}" x2="{w - 14}" y2="{h - 20}" stroke="#cbd5e1"/>'
            f'<line x1="26" y1="12" x2="26" y2="{h - 20}" stroke="#cbd5e1"/>'
            f'{"".join(pts)}{hz}'
            f'{txt(w / 2, h - 5, "orbital period (days)", size=8.5, fill=MUTED, anchor="middle")}'
            f'<text x="10" y="{h / 2}" font-size="8.5" fill="{MUTED}" text-anchor="middle" '
            f'transform="rotate(-90 10 {h / 2})">radius (R⊕)</text></g>')
    return body, h


def agent_panel(x, y, w, h, lines, title="Agent · claude", chip=None):
    """The agent terminal panel (dark), as docked under the notebook."""
    g = [rect(x, y, w, h, r=9, fill="#0b1220", stroke="#1e293b")]
    g.append(rect(x + 1, y + 1, w - 2, 22, r=8, fill="#111a2e"))
    g.append(icon("terminal", x + 10, y + 5, 12, "#7dd3fc", 1.9))
    g.append(txt(x + 28, y + 16, title, size=10.5, fill="#cbd5e1", weight="600"))
    if chip:
        p, pw = pill(x + w - 12 - (len(chip) * 6.1 + 16), y + 4, chip, "#1e1b4b", "#c4b5fd", size=9.5)
        g.append(p)
    ty = y + 38
    for ln, col in lines:
        g.append(code_line(x + 12, ty, [(ln, col)], size=10.5))
        ty += 14
    return "".join(g)


# --------------------------------------------------------------- scenes ----
CODE_A = [[("df", PLAIN), (" = pd.read_csv(", PLAIN), ('"exoplanets.csv"', STR), (")", PLAIN)],
          [("hz", PLAIN), (" = df[df.in_habitable_zone]", PLAIN)]]


def s_title():
    g = [svg_open()]
    g.append(f'<circle cx="{W-120}" cy="96" r="150" fill="#eef2ff" opacity="0.7"/>')
    g.append(f'<circle cx="86" cy="{H-150}" r="110" fill="#f0fdf4" opacity="0.7"/>')
    g.append(txt(W / 2, 226, "Nebula Notebook", size=52, fill=INK, weight="700", anchor="middle"))
    g.append(txt(W / 2, 272, "The notebook your agent can drive — while you keep working in it.",
                 size=19, fill=BODY, anchor="middle"))
    x = W / 2 - 150
    for label, ic, col, bg in (("you", "sparkles", BLUE, BLUE_BG), ("+", None, MUTED, None),
                               ("your agent", "bot", PURPLE, PURPLE_L)):
        if ic:
            g.append(rect(x, 312, 150, 42, r=10, fill=bg, stroke=col, sw=1.2))
            g.append(icon(ic, x + 18, 324, 18, col, 2))
            g.append(txt(x + 46, 339, label, size=15, fill=col, weight="600"))
            x += 166
        else:
            g.append(txt(x + 8, 340, "+", size=22, fill=MUTED, weight="700"))
            x += 34
    g.append(txt(W / 2, 404, "same cells · same moment · nothing overwritten",
                 size=13.5, fill=MUTED, anchor="middle"))
    g.append("</svg>")
    return "".join(g)


def s_money(step=0):
    g = [svg_open()]
    shell, y0, _ = app_shell(content_h=186)
    g.append(shell)
    c1, h1 = cell(44, y0, W - 88 - 250, idx="2", count="4", ms="0.4s", active=(step >= 1),
                  lines=[[("period", PLAIN), (" = df.period_days", PLAIN)],
                         [("ax.set_xscale(", PLAIN), ('"log"', STR), (")", PLAIN)]])
    g.append(c1)
    if step >= 1:  # the user's caret + selection in cell 2
        g.append(rect(232, y0 + 40, 1.7, 14, r=0, fill=BLUE))
        p, _ = pill(W - 88 - 250 - 66, y0 + 3, "you", BLUE_BG, BLUE, size=9)
        g.append(p)
    c2, h2 = cell(44, y0 + h1 + 12, W - 88 - 250, idx="5", count="5", ms="1.1s",
                  ring=(step >= 1),
                  lines=[[("hz", PLAIN), (" = df[df.in_habitable_zone]", PLAIN)],
                         [("ax.scatter(hz.period_days, hz.radius_earth, s=", PLAIN), ("90", NUM), (")", PLAIN)]]
                        if step >= 1 else
                        [[("hz = df[df.habitable]", PLAIN)],
                         [("ax.scatter(hz.period, hz.radius)", PLAIN)]])
    g.append(c2)
    if step >= 1:
        p, pw = pill(W - 88 - 250 - 96, y0 + h1 + 15, "agent editing", PURPLE_L, "#7c3aed", size=9)
        g.append(p)
    # right rail: the agent terminal
    g.append(agent_panel(W - 44 - 236, y0, 236, h1 + h2 + 12, [
        ("$ nebula nb read exoplanets.ipynb", "#7dd3fc"),
        ("  52 cells · kernel idle", "#64748b"),
        ("$ nebula nb edit … cell-5 -", "#7dd3fc"),
        ("  ✓ updated cell-5", "#86efac"),
        ("$ nebula run … cell-5", "#7dd3fc"),
        ("  ✓ ok · 1.1s", "#86efac"),
    ] if step >= 1 else [("$ nebula session start …", "#7dd3fc"), ("  agent session held", "#64748b")],
        chip="claude"))
    if step >= 2:  # the OCC conflict toast — blue, not red
        tw = 372
        g.append(f'<g filter="url(#sh)">{rect(W / 2 - tw / 2, H - 152, tw, 46, r=10, fill=BLUE_BG, stroke="#bfdbfe", sw=1.2)}</g>')
        g.append(icon("refresh", W / 2 - tw / 2 + 14, H - 140, 16, BLUE, 2))
        g.append(txt(W / 2 - tw / 2 + 40, H - 134, "You both edited cell 5.", size=12.5, fill=INK, weight="600"))
        g.append(txt(W / 2 - tw / 2 + 40, H - 118, "The agent got your version and re-applied its change.",
                     size=11.5, fill="#1e40af"))
    g.append(caption("Your notebook. Your agent. At the same time.",
                     "Per-cell optimistic concurrency — nothing is silently overwritten."))
    g.append("</svg>")
    return "".join(g)


def s_focus():
    g = [svg_open()]
    # two tabs, second focused
    for i, (name, focused) in enumerate((("exoplanets.ipynb", False), ("transits.ipynb", True))):
        x = 24 + i * 210
        g.append(rect(x, 22, 200, 30, r=8, fill=CARD if focused else "#eef2f6",
                      stroke="#bfdbfe" if focused else LINE, sw=1.6 if focused else 1))
        g.append(icon("file_text", x + 12, 30, 14, BLUE if focused else MUTED, 1.8))
        g.append(txt(x + 33, 42, name, size=11.5, fill=INK if focused else MUTED,
                     weight="600" if focused else None))
        if focused:
            p, _ = pill(x + 150, 28, "you are here", BLUE_BG, BLUE, size=8.5, h=16)
            g.append(p)
    shell, y0, _ = app_shell(title="transits", ext=".ipynb", y=64, content_h=152)
    g.append(shell)
    c, h = cell(44, y0, W - 88 - 300, idx="3", count="2", ms="0.2s",
                lines=[[("# fold the light curve", COM)],
                       [("phase", PLAIN), (" = (t % period) / period", PLAIN)]])
    g.append(c)
    g.append(agent_panel(W - 44 - 288, y0, 288, h + 70, [
        ("$ nebula context", "#7dd3fc"),
        ("  /work/transits.ipynb", "#86efac"),
        ("  (you switched 4s ago)", "#64748b"),
        ("", BODY),
        ("edit \"this cell\" ->", "#cbd5e1"),
        ("  resolved against transits.ipynb", "#86efac"),
    ], chip="follows focus"))
    g.append(caption("Two notebooks open? The agent tracks the one you're looking at.",
                     "`nebula context` — plus a one-time notice the moment you switch."))
    g.append("</svg>")
    return "".join(g)


def s_fix(step=0):
    g = [svg_open()]
    shell, y0, _ = app_shell(content_h=118 if step == 0 else 214)
    g.append(shell)
    if step == 0:
        c, h = cell(44, y0, W - 88, idx="7", count="6",
                    lines=[[("df.groupby(", PLAIN), ('"startype"', STR), (").radius.mean()", PLAIN)]],
                    out_lines=[("KeyError: 'startype'", RED),
                               ("  → column not found in DataFrame", "#b91c1c")], err=True)
        g.append(c)
        b, bw = button(W - 44 - 150, y0 + h + 12, "Fix with agent", "bot", PURPLE)
        g.append(b)
        g.append(txt(60, y0 + h + 30, "a cell just failed", size=12.5, fill=MUTED))
        g.append(caption("A cell breaks. One click.", "“Fix with agent” sits on every failing cell."))
    else:
        c, h = cell(44, y0, W - 88, idx="7", count="7", ms="0.3s", ring=True,
                    lines=[[("df.groupby(", PLAIN), ('"star_type"', STR), (").radius_earth.mean()", PLAIN)]],
                    out_lines=[("star_type", BODY), ("G     1.42", PLAIN), ("K     1.08", PLAIN),
                               ("M     0.91", PLAIN)])
        g.append(c)
        g.append(agent_panel(44, y0 + h + 14, W - 88, 86, [
            ("$ nebula nb read exoplanets.ipynb --cells 7 --outputs", "#7dd3fc"),
            ("  KeyError: 'startype'  → columns: star_type, radius_earth", "#64748b"),
            ("$ nebula nb edit exoplanets.ipynb cell-7 -   ✓   $ nebula run … cell-7   ✓ ok · 0.3s", "#86efac"),
        ], chip="claude"))
        g.append(caption("It reads the error, fixes the cell, and re-runs it.",
                         "You watch the edit land — presence ring on the cell it touched."))
    g.append("</svg>")
    return "".join(g)


def s_runs():
    g = [svg_open()]
    shell, y0, _ = app_shell(content_h=222)
    g.append(shell)
    ys = y0
    for i, (idx, cnt, ms, act) in enumerate((("3", "3", "0.2s", False), ("4", "4", "0.9s", True),
                                             ("5", None, None, False))):
        c, h = cell(44, ys, W - 88 - 232, idx=idx, count=cnt, ms=ms, active=act,
                    lines=[[("ax.scatter(df.period_days, df.radius_earth, s=", PLAIN), ("10", NUM), (")", PLAIN)]])
        g.append(c)
        if act:
            p, _ = pill(W - 88 - 232 - 74, ys + 3, "selected", BLUE_BG, BLUE, size=9)
            g.append(p)
        ys += h + 10
    # the open Run All ▾ menu
    mx, my, mw = W - 44 - 216, 62, 216
    g.append(f'<g filter="url(#sh)">{rect(mx, my, mw, 92, r=10, fill=CARD, stroke=LINE)}</g>')
    rows = (("up_to_line", "Run cells above", "3"), ("dn_to_line", "Run cell and below", "9"))
    ry = my + 12
    for ic, label, n in rows:
        g.append(rect(mx + 6, ry - 3, mw - 12, 28, r=7, fill="#f1f5f9" if ic == "up_to_line" else CARD))
        g.append(icon(ic, mx + 16, ry + 2, 15, BODY, 1.9))
        g.append(txt(mx + 40, ry + 15, label, size=12.5, fill=INK))
        g.append(txt(mx + mw - 16, ry + 15, n, size=11.5, fill=MUTED, anchor="end"))
        ry += 34
    g.append(line(mx + 6, ry - 6, mx + mw - 6, ry - 6, RULE))
    g.append(txt(mx + 16, ry + 10, "⌘⇧P  ·  also in the palette", size=10.5, fill=MUTED))
    g.append(caption("Run everything above. Or this cell and everything below.",
                     "Anchored on the selected cell — and in the command palette."))
    g.append("</svg>")
    return "".join(g)


def s_collapse(step=0):
    g = [svg_open()]
    shell, y0, _ = app_shell(content_h=246 if step == 0 else 310)
    g.append(shell)
    long_lines = [[("def", KW), (" fold_light_curve(t, period, t0=", PLAIN), ("0.0", NUM), ("):", PLAIN)],
                  [("    phase = ((t - t0) % period) / period", PLAIN)],
                  [("    phase[phase > ", PLAIN), ("0.5", NUM), ("] -= ", PLAIN), ("1.0", NUM)],
                  [("    order = np.argsort(phase)", PLAIN)],
                  [("    return", KW), (" phase[order], order", PLAIN)],
                  [("", PLAIN)],
                  [("for", KW), (" candidate ", PLAIN), ("in", KW), (" catalogue:", PLAIN)],
                  [("    ph, idx = fold_light_curve(candidate.t, candidate.p)", PLAIN)],
                  [("    ax.plot(ph, candidate.flux[idx], lw=", PLAIN), ("0.4", NUM), (")", PLAIN)],
                  [("    ax.set_title(candidate.name)", PLAIN)]]
    if step == 0:
        c, h = cell(44, y0, W - 88, idx="12", count="8", lines=long_lines)
        g.append(c)
        g.append(caption("A 200-line cell buries everything under it.", "Its toolbar is a scroll away, too."))
    else:
        c, h = cell(44, y0, W - 88, idx="12", count="8", ms="2.4s", lines=long_lines, collapsed=True)
        g.append(c)
        g.append(txt(W - 56, y0 + h + 22, "drag to resize · height is remembered", size=10.5,
                     fill=MUTED, anchor="end"))
        oy = y0 + h + 34
        img = scatter_plot(W - 112, 128)
        c2, h2 = cell(44, oy, W - 88, idx="13", count="9", ms="0.6s",
                      lines=[[("plot_folded(catalogue)", PLAIN)]], img=img)
        g.append(c2)
        g.append(caption("Collapse it to a height you choose — and it stays that way.",
                         "Saved in the notebook; the toolbar sticks as you scroll."))
    g.append("</svg>")
    return "".join(g)


def s_history():
    g = [svg_open()]
    shell, y0, _ = app_shell(content_h=196)
    g.append(shell)
    pw = 268
    c, h = cell(44, y0, W - 88 - pw - 14, idx="9", count="7",
                lines=[[("ax.set(xscale=", PLAIN), ('"log"', STR), (", xlabel=", PLAIN), ('"period"', STR), (")", PLAIN)],
                       [("ax.legend(frameon=", PLAIN), ("False", KW), (")", PLAIN)]])
    g.append(c)
    g.append(rect(44, y0, W - 88 - pw - 14, h, r=9, fill="#fff7ed", opacity=0.55))
    p, _ = pill(48 + (W - 88 - pw - 14) - 96, y0 + h - 22, "preview · 3 steps back", "#ffedd5", "#9a3412", size=9)
    g.append(p)
    # history rail
    hx = W - 44 - pw
    g.append(rect(hx, y0 - 6, pw, h + 96, r=10, fill=CARD, stroke=LINE))
    g.append(icon("history", hx + 12, y0 + 4, 14, BODY, 1.9))
    g.append(txt(hx + 34, y0 + 16, "History", size=12.5, fill=INK, weight="700"))
    g.append(txt(hx + pw - 12, y0 + 16, "⌘⇧H", size=10, fill=MUTED, anchor="end", family=MONO))
    rows = (("Edit", "cell 9", "just now", BODY, False), ("Run All", "12 cells", "1m", GREEN, False),
            ("Edit", "cell 9", "3m", "#ea580c", True), ("Agent edit", "cell 5", "4m", PURPLE, False),
            ("Delete", "cell 11", "6m", RED, False))
    ry = y0 + 34
    for name, target, when, col, sel in rows:
        if sel:
            g.append(rect(hx + 6, ry - 4, pw - 12, 26, r=6, fill="#fff7ed", stroke="#fed7aa", sw=1))
        g.append(f'<circle cx="{hx + 18}" cy="{ry + 8}" r="3" fill="{col}"/>')
        g.append(txt(hx + 30, ry + 12, name, size=11.5, fill=INK, weight="600" if sel else None))
        g.append(txt(hx + 96, ry + 12, target, size=11, fill=MUTED))
        g.append(txt(hx + pw - 12, ry + 12, when, size=10.5, fill=MUTED, anchor="end"))
        ry += 30
    b, bw = button(hx + 12, ry + 4, "Restore here", "undo", "#ea580c", h=25, size=11.5)
    g.append(b)
    g.append(txt(hx + 20 + bw, ry + 21, "⌘Z undoes anything", size=10.5, fill=MUTED))
    g.append(caption("Scrub back through every edit — yours and the agent's.",
                     "Journaled to disk, survives reloads, one-click restore."))
    g.append("</svg>")
    return "".join(g)


def s_search():
    g = [svg_open()]
    shell, y0, _ = app_shell(content_h=222)
    g.append(shell)
    # find & replace bar
    bx, bw2 = 44, W - 88
    g.append(f'<g filter="url(#sh)">{rect(bx, y0 - 4, bw2, 42, r=9, fill=CARD, stroke="#bfdbfe", sw=1.3)}</g>')
    g.append(icon("search", bx + 12, y0 + 7, 15, BLUE, 1.9))
    g.append(rect(bx + 34, y0 + 5, 212, 24, r=6, fill="#f8fafc", stroke=LINE))
    g.append(txt(bx + 42, y0 + 21, "period_(\\w+)", size=11.5, fill=INK, family=MONO))
    g.append(txt(bx + 256, y0 + 21, "8 matches", size=11.5, fill=MUTED))
    g.append(rect(bx + 330, y0 + 5, 212, 24, r=6, fill="#f8fafc", stroke=LINE))
    g.append(txt(bx + 338, y0 + 21, "orbital_$1", size=11.5, fill=INK, family=MONO))
    p, pw2 = pill(bx + 556, y0 + 8, ".*  regex", BLUE_BG, BLUE, size=9.5)
    g.append(p)
    b, _ = button(bx + bw2 - 108, y0 + 5, "Replace all", None, BLUE, h=24, size=11.5)
    g.append(b)
    ys = y0 + 52
    for idx, before, after in (("4", "period_days", "orbital_days"), ("6", "period_err", "orbital_err")):
        c, h = cell(44, ys, W - 88, idx=idx, count=idx,
                    lines=[[("ax.scatter(df.", PLAIN), (before, PLAIN), (", df.radius_earth)", PLAIN)]])
        g.append(c)
        g.append(rect(150, ys + 30, 68, 15, r=3, fill="#fef08a", opacity=0.85))
        ys += h + 10
    g.append(caption("Real find & replace — the whole notebook, regex included.",
                     "⌘F to search · ⌘⇧H history · Ctrl+` terminal — all one keystroke."))
    g.append("</svg>")
    return "".join(g)


def s_sealed():
    g = [svg_open()]
    shell, y0, _ = app_shell(title="results-final", kernel="Python 3.12 (Nebula)", saved="sealed",
                             agent=False, content_h=332, run_disabled=True)
    g.append(shell)
    # sealed ribbon
    g.append(rect(44, y0 - 6, W - 88, 34, r=8, fill="#1e1b4b"))
    g.append(icon("lock", 58, y0 + 2, 15, "#c7d2fe", 1.9))
    g.append(txt(82, y0 + 15, "Sealed evidence — read-only", size=12.5, fill="#e0e7ff", weight="600"))
    g.append(txt(W - 58, y0 + 15, "seal 7f3a…c19", size=11, fill="#a5b4fc", anchor="end", family=MONO))
    img = scatter_plot(W - 112, 120)
    c, h = cell(44, y0 + 38, W - 88, idx="18", count="18", ms="4.2s",
                lines=[[("fig = plot_habitable_zone(df)", PLAIN)]], img=img, toolbar=True)
    g.append(c)
    # verification card
    vy = y0 + 38 + h + 12
    g.append(rect(44, vy, W - 88, 76, r=9, fill=GREEN_BG, stroke="#bbf7d0", sw=1.2))
    g.append(icon("check_circ", 60, vy + 14, 18, GREEN, 2))
    g.append(txt(88, vy + 28, "Replayed in a fresh kernel — every output matched.",
                 size=13, fill="#14532d", weight="600"))
    cols = (("notebook", "sha256 9c2e…"), ("figure.png", "sha256 41ab…"), ("inputs", "sha256 d80f…"),
            ("environment", "python 3.12 · numpy 2.1"))
    cx = 88
    for label, val in cols:
        g.append(txt(cx, vy + 50, label, size=10, fill="#15803d"))
        g.append(txt(cx, vy + 64, val, size=10, fill="#166534", family=MONO))
        cx += 202
    g.append(caption("Seal a result: re-run it clean, then hash-bind it.",
                     "Notebook + artifacts + environment, verified and locked."))
    g.append("</svg>")
    return "".join(g)


def s_security():
    g = [svg_open()]
    g.append(txt(W / 2, 92, "Yours only — from anywhere", size=30, fill=INK, weight="700", anchor="middle"))
    cards = (
        ("key", "Sign in with a passkey", "Touch ID / Windows Hello.\nNo code to type.", PURPLE, PURPLE_L),
        ("shield", "TOTP 2FA", "Scan once at first start.\n30-day trusted sessions.", GREEN, GREEN_BG),
        ("lock", "Agents carry real tokens", "NEBULA_TOKEN, pushed at launch —\nnot a network-shaped guess.", BLUE, BLUE_BG),
    )
    cw, gap = 276, 22
    x = (W - (cw * 3 + gap * 2)) / 2
    for ic, title, body, col, bg in cards:
        g.append(f'<g filter="url(#sh)">{rect(x, 140, cw, 178, r=12, fill=CARD, stroke=LINE)}</g>')
        g.append(rect(x + 20, 162, 40, 40, r=11, fill=bg))
        g.append(icon(ic, x + 31, 173, 18, col, 2))
        g.append(txt(x + 20, 230, title, size=15, fill=INK, weight="700"))
        for i, ln in enumerate(body.split("\n")):
            g.append(txt(x + 20, 254 + i * 17, ln, size=12, fill=BODY))
        x += cw + gap
    g.append(caption("Two-factor, passkeys, and tokens that travel with your agent.",
                     "Settings → Security · works the same on a laptop or a login node."))
    g.append("</svg>")
    return "".join(g)


def s_compute(step=0):
    g = [svg_open()]
    g.append(txt(48, 56, "One more thing — it runs where your compute lives",
                 size=25, fill=INK, weight="700"))
    mx, mw = 48, W - 96
    g.append(f'<g filter="url(#sh)">{rect(mx, 78, mw, 260, r=12, fill=CARD, stroke=LINE)}</g>')
    g.append(icon("cpu", mx + 18, 94, 17, INK, 2))
    g.append(txt(mx + 44, 108, "New compute allocation", size=14.5, fill=INK, weight="700"))
    p, _ = pill(mx + mw - 118, 94, "SLURM detected", GREEN_BG, GREEN, size=9.5)
    g.append(p)
    g.append(line(mx + 1, 122, mx + mw - 1, 122, RULE))
    # queue table
    heads = ("PARTITION", "ARCH", "CPUS idle", "GPUS idle", "QUEUE")
    colx = (mx + 20, mx + 168, mx + 250, mx + 352, mx + 470)
    for hd, cx in zip(heads, colx):
        g.append(txt(cx, 146, hd, size=9.5, fill=MUTED, weight="600"))
    rows = (("gpuq", "x86_64", "148/288", "14 A100 · 1 H200", "325", False),
            ("tier1q", "x86_64", "759/4704", "—", "1418", False),
            ("pearsonq", "aarch64", "576/576", "—", "0", True))
    ry = 160
    for name, arch, cpus, gpus, q, sel in rows:
        if sel:
            g.append(rect(mx + 12, ry, mw - 24, 28, r=7, fill=BLUE_BG, stroke="#bfdbfe", sw=1))
        g.append(txt(colx[0], ry + 19, name, size=12, fill=INK, weight="600" if sel else None))
        ap, _ = pill(colx[1], ry + 6, arch, PURPLE_L if arch == "aarch64" else SLATE_BG,
                     "#7c3aed" if arch == "aarch64" else MUTED, size=9, h=16)
        g.append(ap)
        g.append(txt(colx[2], ry + 19, cpus, size=11.5, fill=BODY, family=MONO))
        g.append(txt(colx[3], ry + 19, gpus, size=11.5, fill=BODY))
        g.append(txt(colx[4], ry + 19, q, size=11.5, fill=MUTED, family=MONO))
        ry += 32
    if step == 0:
        # ARM setup affordance
        g.append(rect(mx + 12, ry + 6, mw - 24, 52, r=9, fill=AMBER_BG, stroke=AMBER_LN, sw=1.2))
        g.append(icon("alert", mx + 26, ry + 20, 16, AMBER, 2))
        g.append(txt(mx + 50, ry + 28, "This queue runs aarch64 nodes — no ARM runtime configured yet.",
                     size=12, fill="#92400e", weight="600"))
        g.append(txt(mx + 50, ry + 45, "Setup is a one-time task; hand it to an agent.",
                     size=11, fill="#b45309"))
        b, bw = button(mx + mw - 176, ry + 20, "Copy setup prompt", None, AMBER, h=25, size=11.5)
        g.append(b)
        g.append(caption("Heterogeneous cluster? It says so, and hands the setup to your agent.",
                         "Detected arch per queue · a prompt filled with your real paths."))
    else:
        g.append(rect(mx + 12, ry + 6, mw - 24, 52, r=9, fill=GREEN_BG, stroke="#bbf7d0", sw=1.2))
        g.append(icon("server", mx + 26, ry + 20, 16, GREEN, 2))
        g.append(txt(mx + 50, ry + 28, "cri22cn409 · aarch64 · online", size=12.5, fill="#14532d", weight="600"))
        g.append(txt(mx + 50, ry + 45, "kernels now run on the compute node — same notebook, same agent.",
                     size=11, fill="#166534"))
        p2, _ = pill(mx + mw - 96, ry + 22, "active", "#dcfce7", GREEN, size=9.5)
        g.append(p2)
        g.append(caption("Queue it from the kernel menu. No sbatch, no SSH tunnel.",
                         "x86 or ARM — invisible if you're not on a cluster."))
    g.append("</svg>")
    return "".join(g)


def s_start():
    g = [svg_open()]
    g.append(txt(W / 2, 130, "Two commands.", size=34, fill=INK, weight="700", anchor="middle"))
    bx, bw = 210, W - 420
    g.append(rect(bx, 172, bw, 104, r=11, fill="#0b1220"))
    g.append(code_line(bx + 24, 208, [("$ ", "#64748b"), ("npx nebula-notebook", "#e2e8f0")], size=15))
    g.append(code_line(bx + 24, 244, [("$ ", "#64748b"), ("npx nebula-notebook-mcp setup-mcp", "#e2e8f0")], size=15))
    g.append(txt(W / 2, 310, "Your notebook, and your agent.", size=17, fill=BODY, anchor="middle"))
    g.append(txt(W / 2, 358, "github.com/jzhoulab/nebula-notebook", size=14, fill=MUTED,
                 anchor="middle", family=MONO))
    g.append("</svg>")
    return "".join(g)


# scene table: (slug, [svg frames], seconds per frame)
def build_scenes():
    return [
        # holds: long enough to read a two-line caption and take in the frame;
        # follow-up frames inside a scene are shorter (the caption is already read).
        ("01-title",    [s_title()],                    [4.0]),
        ("02-money",    [s_money(0), s_money(1), s_money(2)], [2.4, 4.2, 4.4]),
        ("03-focus",    [s_focus()],                    [5.0]),
        ("04-fix",      [s_fix(0), s_fix(1)],           [3.6, 4.6]),
        ("05-runs",     [s_runs()],                     [4.6]),
        ("06-collapse", [s_collapse(0), s_collapse(1)], [3.0, 4.4]),
        ("07-history",  [s_history()],                  [4.8]),
        ("08-search",   [s_search()],                   [4.4]),
        ("09-sealed",   [s_sealed()],                   [5.0]),
        ("10-security", [s_security()],                 [4.6]),
        ("11-compute",  [s_compute(0), s_compute(1)],   [4.4, 4.4]),
        ("12-start",    [s_start()],                    [4.2]),
    ]


# ------------------------------------------------------------- pipeline ----
def write_svgs():
    os.makedirs(OUT, exist_ok=True)
    made = []
    for slug, frames, _ in build_scenes():
        for i, svg in enumerate(frames):
            p = os.path.join(OUT, f"{slug}-{i}.svg")
            with open(p, "w") as fh:
                fh.write(svg)
            made.append(p)
    print(f"{len(made)} svg frames -> {OUT}")
    return made


def rasterise(scale=2):
    made = []
    for slug, frames, _ in build_scenes():
        for i in range(len(frames)):
            src = os.path.join(OUT, f"{slug}-{i}.svg")
            dst = os.path.join(OUT, f"{slug}-{i}.png")
            subprocess.run(["rsvg-convert", "-w", str(W * scale), "-h", str(H * scale),
                            "-o", dst, src], check=True)
            made.append(dst)
    print(f"{len(made)} png frames ({W*scale}x{H*scale})")
    return made


def assemble(out_name="nebula-tour.mp4", xfade=0.45):
    """Still frames -> mp4 with crossfades (ffmpeg xfade chain)."""
    stills, holds = [], []
    for slug, frames, secs in build_scenes():
        for i in range(len(frames)):
            stills.append(os.path.join(OUT, f"{slug}-{i}.png"))
            holds.append(secs[i])
    inputs = []
    for p, sec in zip(stills, holds):
        inputs += ["-loop", "1", "-t", f"{sec + xfade:.2f}", "-i", p]
    chain, prev, offset = [], "[0:v]", 0.0
    for i in range(1, len(stills)):
        offset += holds[i - 1]
        label = f"[v{i}]"
        chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={xfade}:offset={offset:.2f}{label}")
        prev = label
    filt = ";".join(chain) if chain else None
    dst = os.path.join(OUT, out_name)
    cmd = ["ffmpeg", "-y"] + inputs
    if filt:
        cmd += ["-filter_complex", filt, "-map", prev]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(FPS), "-crf", "18",
            "-movflags", "+faststart", dst]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    total = sum(holds)
    print(f"{dst}  ({total:.1f}s, {len(stills)} scenes)")
    return dst


def poster():
    """Hero poster still for the README <video poster>."""
    p = os.path.join(ROOT, "docs", "assets", "nebula-tour-poster.svg")
    with open(p, "w") as fh:
        fh.write(s_money(1))
    print(p)
    return p


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "video"
    if what in ("svg", "png", "video"):
        write_svgs()
    if what in ("png", "video"):
        rasterise()
    if what == "video":
        assemble()
    if what == "poster":
        poster()
