#!/usr/bin/env python3
"""
New interstitial cards for the product film — drawn in the film's OWN style.

The shipped tour (docs/DEMO.md) alternates light screen recordings with dark
starfield interstitials: a glowing orb + letterspaced kicker, a two-tone
headline (white + cyan→lavender gradient), a bespoke mini-diagram, and a muted
subtitle. This script adds cards for everything that shipped after the film was
cut, and splices them in ahead of the end card — the recording stays untouched.

  python3 scripts/demo-cards.py cards   # -> build/film/cards/*.png
  python3 scripts/demo-cards.py splice  # -> build/film/nebula-demo-v11.mp4

Requires the original film at build/film/old/nebula-demo-v10.mp4 (release
demo-assets). Audio is continuous music: the inserted span is filled with a
passage lifted from the middle of the same track, crossfaded at both seams.
"""
import os, random, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "build", "film", "cards")
OLD = os.path.join(ROOT, "build", "film", "old", "nebula-demo-v10.mp4")
DST = os.path.join(ROOT, "build", "film", "nebula-demo-v11.mp4")
W, H = 1920, 1080
SPLICE_AT = 156.0          # end of the last recorded beat, before the end card
CARD_SECS = 4.2            # hold per card
XFADE = 0.55

BG0, BG1 = "#0a0e19", "#0d1526"
KICK = "#a5b4fc"
SUB = "#cbd5e1"
MUTED = "#8ea0be"
CYAN, LAV, GREEN, AMBER, PINK = "#7dd3fc", "#c4b5fd", "#4ade80", "#fbbf24", "#f472b6"
SANS = "Helvetica, Arial, 'Segoe UI', sans-serif"
MONO = "Menlo, 'SF Mono', ui-monospace, monospace"


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def stars(n=70, seed=3):
    random.seed(seed)
    out = []
    for _ in range(n):
        x, y = random.randint(0, W), random.randint(0, H)
        r = random.choice([1, 1, 1.4, 1.8, 2.4])
        o = random.uniform(0.15, 0.75)
        c = random.choice(["#ffffff", "#ffffff", CYAN, LAV])
        out.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c}" opacity="{o:.2f}"/>')
    return "".join(out)


def head(): 
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
            f'viewBox="0 0 {W} {H}" font-family="{SANS}">'
            '<defs>'
            f'<radialGradient id="vig" cx="50%" cy="42%" r="72%">'
            f'<stop offset="0" stop-color="{BG1}"/><stop offset="1" stop-color="{BG0}"/></radialGradient>'
            f'<linearGradient id="accent" x1="0" x2="1">'
            f'<stop offset="0" stop-color="{CYAN}"/><stop offset="1" stop-color="{LAV}"/></linearGradient>'
            f'<radialGradient id="orb" cx="38%" cy="32%" r="72%">'
            f'<stop offset="0" stop-color="#bae6fd"/><stop offset="0.55" stop-color="#38bdf8"/>'
            f'<stop offset="1" stop-color="#1d4ed8"/></radialGradient>'
            f'<linearGradient id="rail" x1="0" x2="1">'
            f'<stop offset="0" stop-color="#312e81" stop-opacity="0"/>'
            f'<stop offset="0.2" stop-color="#6d28d9"/><stop offset="0.8" stop-color="#6d28d9"/>'
            f'<stop offset="1" stop-color="#312e81" stop-opacity="0"/></linearGradient>'
            '<filter id="soft" x="-80%" y="-80%" width="260%" height="260%">'
            '<feGaussianBlur stdDeviation="9"/></filter>'
            '<filter id="dot" x="-160%" y="-160%" width="420%" height="420%">'
            '<feGaussianBlur stdDeviation="5"/></filter>'
            '</defs>'
            f'<rect width="{W}" height="{H}" fill="url(#vig)"/>{stars()}')


def kicker(label, y=362):
    """Glowing orb + letterspaced small-caps label, centred as a unit."""
    tw = len(label) * 17.4
    total = 34 + tw
    x0 = W / 2 - total / 2
    return (f'<circle cx="{x0 + 14}" cy="{y}" r="17" fill="#38bdf8" opacity="0.32" filter="url(#soft)"/>'
            f'<circle cx="{x0 + 14}" cy="{y}" r="13" fill="url(#orb)"/>'
            f'<circle cx="{x0 + 14}" cy="{y}" r="15.5" fill="none" stroke="#60a5fa" stroke-opacity="0.5"/>'
            f'<text x="{x0 + 40}" y="{y + 8}" font-size="23" font-weight="700" fill="{KICK}" '
            f'letter-spacing="5.5">{esc(label)}</text>')


def headline(white, accent, y=490):
    """Two-tone headline: plain white, then the gradient phrase."""
    size = 86
    wpx = len(white) * size * 0.545
    apx = len(accent) * size * 0.545
    gap = size * 0.28 if white and accent else 0
    x0 = W / 2 - (wpx + gap + apx) / 2
    out = ""
    if white:
        out += (f'<text x="{x0}" y="{y}" font-size="{size}" font-weight="700" fill="#ffffff">'
                f'{esc(white)}</text>')
    if accent:
        out += (f'<text x="{x0 + wpx + gap}" y="{y}" font-size="{size}" font-weight="700" '
                f'fill="url(#accent)">{esc(accent)}</text>')
    return out


def subtitle(text, y=768):
    return (f'<text x="{W/2}" y="{y}" font-size="29" fill="{SUB}" text-anchor="middle">'
            f'{esc(text)}</text>')


def glow_dot(x, y, col, r=11):
    return (f'<circle cx="{x}" cy="{y}" r="{r+6}" fill="{col}" opacity="0.30" filter="url(#dot)"/>'
            f'<circle cx="{x}" cy="{y}" r="{r}" fill="{col}"/>')


def chip(x, y, label, col=LAV, w=None, h=44, fill="#141c30", stroke=None, size=20, mono=False):
    w = w or (len(label) * (size * 0.62) + 40)
    st = f' stroke="{stroke or col}" stroke-opacity="0.55"' if True else ""
    fam = MONO if mono else SANS
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h/2.6}" fill="{fill}"{st}/>'
            f'<text x="{x + w/2}" y="{y + h*0.66}" font-size="{size}" fill="{col}" '
            f'text-anchor="middle" font-family="{fam}" font-weight="600">{esc(label)}</text>'), w


# ------------------------------------------------------------- diagrams ----
def d_focus(y=640):
    """Two notebook tabs; the focused one glows and the agent points at it."""
    g = []
    for i, (name, on) in enumerate((("exoplanets.ipynb", False), ("transits.ipynb", True))):
        x = W / 2 - 430 + i * 300
        c, wd = chip(x, y - 26, name, "#ffffff" if on else MUTED, w=270,
                     fill="#18233c" if on else "#121a2c", stroke=CYAN if on else "#334155", size=19)
        g.append(c)
        if on:
            g.append(f'<rect x="{x}" y="{y-26}" width="270" height="44" rx="17" fill="none" '
                     f'stroke="{CYAN}" stroke-opacity="0.85" stroke-width="2"/>')
            g.append(f'<text x="{x+135}" y="{y+42}" font-size="17" fill="{CYAN}" '
                     f'text-anchor="middle">you are here</text>')
    ax = W / 2 + 210
    g.append(f'<path d="M{W/2+185} {y-4} H{ax+22}" stroke="{LAV}" stroke-width="2.4" '
             f'stroke-dasharray="7 7" opacity="0.8"/>')
    g.append(glow_dot(ax + 78, y - 4, LAV, 15))
    g.append(f'<text x="{ax+78}" y="{y+42}" font-size="17" fill="{LAV}" text-anchor="middle">agent</text>')
    return "".join(g)


def d_runs(y=620):
    """A cell stack with the above/below spans bracketed."""
    g = []
    for i in range(7):
        cy = y - 70 + i * 24
        sel = i == 3
        col = CYAN if sel else "#243049"
        g.append(f'<rect x="{W/2-120}" y="{cy}" width="240" height="16" rx="5" fill="{col}" '
                 f'opacity="{1 if sel else 0.95}"/>')
    g.append(f'<path d="M{W/2-150} {y-66} V{y-26}" stroke="{LAV}" stroke-width="3"/>')
    g.append(f'<text x="{W/2-168}" y="{y-40}" font-size="19" fill="{LAV}" text-anchor="end">above</text>')
    g.append(f'<path d="M{W/2+150} {y+10} V{y+78}" stroke="{GREEN}" stroke-width="3"/>')
    g.append(f'<text x="{W/2+168}" y="{y+50}" font-size="19" fill="{GREEN}">and below</text>')
    g.append(f'<text x="{W/2+134}" y="{y+2}" font-size="17" fill="{CYAN}">selected</text>')
    return "".join(g)


def d_collapse(y=612):
    g = []
    g.append(f'<rect x="{W/2-330}" y="{y-80}" width="260" height="190" rx="12" fill="#121a2c" '
             f'stroke="#243049"/>')
    for i in range(9):
        g.append(f'<rect x="{W/2-310}" y="{y-62+i*19}" width="{200 - (i%3)*44}" height="7" rx="3.5" '
                 f'fill="#2c3a58"/>')
    g.append(f'<path d="M{W/2-40} {y+14} h84 m-14-12 14 12-14 12" stroke="{LAV}" stroke-width="3" '
             f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
    g.append(f'<rect x="{W/2+90}" y="{y-24}" width="260" height="78" rx="12" fill="#121a2c" '
             f'stroke="{CYAN}" stroke-opacity="0.7"/>')
    for i in range(3):
        g.append(f'<rect x="{W/2+110}" y="{y-6+i*19}" width="{200 - i*40}" height="7" rx="3.5" fill="#2c3a58"/>')
    g.append(f'<rect x="{W/2+188}" y="{y+58}" width="64" height="7" rx="3.5" fill="{CYAN}" opacity="0.9"/>')
    g.append(f'<text x="{W/2+220}" y="{y+96}" font-size="17" fill="{CYAN}" text-anchor="middle">drag</text>')
    return "".join(g)


def d_sealed(y=626):
    g = []
    steps = (("notebook", CYAN), ("fresh kernel", LAV), ("outputs match", GREEN))
    for i, (label, col) in enumerate(steps):
        x = W / 2 - 440 + i * 258
        g.append(f'<rect x="{x}" y="{y-38}" width="210" height="62" rx="12" fill="#121a2c" '
                 f'stroke="{col}" stroke-opacity="0.5"/>')
        g.append(f'<text x="{x+105}" y="{y}" font-size="19" fill="{col}" text-anchor="middle">{label}</text>')
        if i < 2:
            g.append(f'<path d="M{x+220} {y-8} h26 m-9-8 9 8-9 8" stroke="#475569" stroke-width="2.6" '
                     f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
    lx = W / 2 + 400
    g.append(f'<circle cx="{lx}" cy="{y-8}" r="34" fill="#052e1a" stroke="{GREEN}" stroke-opacity="0.7"/>')
    g.append(f'<g transform="translate({lx-13},{y-21}) scale(1.1)" fill="none" stroke="{GREEN}" '
             f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
             f'<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></g>')
    g.append(f'<text x="{W/2}" y="{y+70}" font-size="18" fill="{MUTED}" text-anchor="middle" '
             f'font-family="{MONO}">sha256 9c2e…  ·  41ab…  ·  d80f…</text>')
    return "".join(g)


def d_keys(y=620):
    g = []
    items = (("passkey", CYAN), ("TOTP", LAV), ("agent token", GREEN))
    for i, (label, col) in enumerate(items):
        x = W / 2 - 400 + i * 275
        g.append(f'<rect x="{x}" y="{y-44}" width="235" height="76" rx="14" fill="#121a2c" '
                 f'stroke="{col}" stroke-opacity="0.45"/>')
        g.append(glow_dot(x + 40, y - 6, col, 9))
        g.append(f'<text x="{x+72}" y="{y+1}" font-size="21" fill="#e2e8f0">{label}</text>')
    g.append(f'<text x="{W/2}" y="{y+76}" font-size="18" fill="{MUTED}" '
             f'text-anchor="middle">one login · every surface</text>')
    return "".join(g)


def d_arch(y=624):
    g = []
    for i, (node, arch, col) in enumerate((("login node", "x86_64", CYAN), ("compute node", "aarch64", LAV))):
        x = W / 2 - 430 + i * 560
        g.append(f'<rect x="{x}" y="{y-56}" width="300" height="104" rx="14" fill="#121a2c" '
                 f'stroke="{col}" stroke-opacity="0.5"/>')
        g.append(f'<text x="{x+150}" y="{y-20}" font-size="21" fill="#e2e8f0" text-anchor="middle">{node}</text>')
        c, cw = chip(x + 150 - 62, y - 2, arch, col, w=124, h=36, size=18, mono=True)
        g.append(c)
    g.append(f'<path d="M{W/2-108} {y-8} h216" stroke="{GREEN}" stroke-width="2.6" stroke-dasharray="8 8"/>')
    g.append(f'<text x="{W/2}" y="{y-34}" font-size="18" fill="{GREEN}" text-anchor="middle">same notebook</text>')
    return "".join(g)


def card(kick, white, accent, sub, diagram):
    return head() + kicker(kick) + headline(white, accent) + diagram() + subtitle(sub) + "</svg>"


def end_card():
    """The film's closing card, rebuilt — the old one still says jzthree."""
    g = [head()]
    y = 430
    g.append(f'<rect x="{W/2-372}" y="{y-58}" width="92" height="92" rx="24" fill="url(#orb)"/>')
    g.append(f'<rect x="{W/2-372}" y="{y-58}" width="92" height="92" rx="24" fill="none" '
             f'stroke="#60a5fa" stroke-opacity="0.55" stroke-width="2.5"/>')
    g.append(f'<text x="{W/2-258}" y="{y+16}" font-size="76" font-weight="700" fill="url(#accent)">Nebula</text>')
    g.append(f'<text x="{W/2+14}" y="{y+16}" font-size="76" font-weight="700" fill="#ffffff">Notebook</text>')
    for i, cmd in enumerate(("npx nebula-notebook", "npx nebula-notebook-mcp setup-mcp")):
        cy = y + 96 + i * 92
        g.append(f'<rect x="{W/2-372}" y="{cy}" width="744" height="72" rx="16" fill="#101a2e" '
                 f'stroke="#1e293b"/>')
        g.append(f'<text x="{W/2-338}" y="{cy+47}" font-size="30" fill="{GREEN}" font-family="{MONO}">$</text>')
        g.append(f'<text x="{W/2-298}" y="{cy+47}" font-size="30" fill="#e2e8f0" '
                 f'font-family="{MONO}">{esc(cmd)}</text>')
    g.append(f'<text x="{W/2}" y="{y+306}" font-size="26" font-weight="700" fill="#ffffff" '
             f'text-anchor="middle">github.com/jzhoulab/nebula-notebook</text>')
    g.append("</svg>")
    return "".join(g)


def build_cards():
    return [
        ("01-focus", card("FOCUS AWARENESS", "The agent follows", "your notebook",
                          "Two notebooks open — it edits the one you're looking at", d_focus)),
        ("02-runs", card("RUN CONTROL", "Run above. Or", "everything below.",
                         "Anchored on the cell you picked — and in the palette", d_runs)),
        ("03-collapse", card("LONG CELLS", "Fold any cell", "down to size",
                             "Drag the height — the notebook remembers it", d_collapse)),
        ("04-sealed", card("SEALED EVIDENCE", "Results you can", "prove",
                           "Replayed in a fresh kernel · outputs matched · hash-bound", d_sealed)),
        ("05-keys", card("SIGN-IN", "Sign in with", "a touch",
                         "Passkeys, TOTP, and a real token for your agent", d_keys)),
        ("06-arch", card("ANY ARCHITECTURE", "x86 or", "ARM",
                         "Detected per queue — ARM setup handed to your agent", d_arch)),
        ("07-end", end_card()),
    ]


# -------------------------------------------------------------- pipeline ---
def render():
    os.makedirs(OUT, exist_ok=True)
    pngs = []
    for slug, svg in build_cards():
        s = os.path.join(OUT, f"{slug}.svg")
        p = os.path.join(OUT, f"{slug}.png")
        with open(s, "w") as fh:
            fh.write(svg)
        subprocess.run(["rsvg-convert", "-w", str(W), "-h", str(H), "-o", p, s], check=True)
        pngs.append(p)
    print(f"{len(pngs)} cards -> {OUT}")
    return pngs


def segment(pngs):
    """The new cards as one silent clip, with crossfades between them."""
    seg = os.path.join(OUT, "segment.mp4")
    inputs = []
    for p in pngs:
        inputs += ["-loop", "1", "-t", f"{CARD_SECS + XFADE:.2f}", "-i", p]
    chain, prev, off = [], "[0:v]", 0.0
    for i in range(1, len(pngs)):
        off += CARD_SECS
        lbl = f"[v{i}]"
        chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={XFADE}:offset={off:.2f}{lbl}")
        prev = lbl
    cmd = ["ffmpeg", "-y"] + inputs
    if chain:
        cmd += ["-filter_complex", ";".join(chain), "-map", prev]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-crf", "18", seg]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "default=nw=1:nk=1", seg],
                               capture_output=True, text=True).stdout.strip())
    print(f"segment: {dur:.1f}s")
    return seg, dur


def splice(seg, seg_dur):
    """head(old) + cards + tail(old, minus its stale end card), audio rejoined.

    The old end card is dropped: it still points at github.com/jzthree. The
    rebuilt one closes the new cut instead.
    """
    tmp = OUT
    head_v = os.path.join(tmp, "head.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", OLD, "-t", str(SPLICE_AT),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-an", head_v], check=True)
    lst = os.path.join(tmp, "concat.txt")
    with open(lst, "w") as fh:
        fh.write(f"file '{head_v}'\nfile '{seg}'\n")
    video = os.path.join(tmp, "video.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-c", "copy", video], check=True)
    # audio: original up to the splice, then a passage from mid-track to cover
    # the new cards, crossfaded at both seams so the music reads as continuous.
    a_head = os.path.join(tmp, "a_head.m4a")
    a_fill = os.path.join(tmp, "a_fill.m4a")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", OLD, "-t", str(SPLICE_AT + 0.5),
                    "-vn", "-c:a", "aac", "-b:a", "192k", a_head], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "62", "-i", OLD, "-t", f"{seg_dur + 1.0:.2f}",
                    "-vn", "-af", "afade=t=in:st=0:d=0.8,"
                    f"afade=t=out:st={seg_dur:.2f}:d=0.8",
                    "-c:a", "aac", "-b:a", "192k", a_fill], check=True)
    alst = os.path.join(tmp, "aconcat.txt")
    with open(alst, "w") as fh:
        fh.write(f"file '{a_head}'\nfile '{a_fill}'\n")
    audio = os.path.join(tmp, "audio.m4a")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", alst,
                    "-c", "copy", audio], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", video, "-i", audio,
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
                    "-movflags", "+faststart", DST], check=True)
    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", DST], capture_output=True, text=True).stdout.strip()
    size = os.path.getsize(DST) / 1e6
    print(f"{DST}  ({float(dur):.1f}s, {size:.1f} MB)")
    return DST


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "splice"
    pngs = render()
    if what == "splice":
        if not os.path.exists(OLD):
            sys.exit(f"missing {OLD} — download the demo-assets release first")
        splice(*segment(pngs))


# ------------------------------------------------ v12: reworded opening ----
# The original opening explained what an agent is ("A notebook for both human
# and AI", "BUILT FOR AGENTS · Your AI works in the notebook", "You and your
# AI…"). By now the audience ships with Claude Code or Codex open; the pitch
# is not that an agent can touch a notebook, it is that you don't have to take
# turns. Name the tools, skip the explanation, lead with concurrency.

def intro_title():
    g = [head()]
    y = 470
    g.append(f'<circle cx="{W/2}" cy="{y-146}" r="46" fill="#38bdf8" opacity="0.28" filter="url(#soft)"/>')
    g.append(f'<circle cx="{W/2}" cy="{y-146}" r="34" fill="url(#orb)"/>')
    g.append(f'<circle cx="{W/2}" cy="{y-146}" r="39" fill="none" stroke="#60a5fa" stroke-opacity="0.5" stroke-width="2"/>')
    g.append(f'<text x="{W/2-268}" y="{y}" font-size="82" font-weight="700" fill="url(#accent)">Nebula</text>')
    g.append(f'<text x="{W/2+14}" y="{y}" font-size="82" font-weight="700" fill="#ffffff">Notebook</text>')
    g.append(f'<text x="{W/2}" y="{y+72}" font-size="31" fill="{SUB}" text-anchor="middle">'
             f'You and your coding agent, in the same cells.</text>')
    g.append("</svg>")
    return "".join(g)


def d_tools(y=640):
    """The agents people already run — named, not explained."""
    g = []
    names = (("Claude Code", CYAN), ("Codex", LAV), ("Cursor", GREEN), ("…any MCP client", MUTED))
    widths = [len(n) * 13 + 56 for n, _ in names]
    total = sum(widths) + 26 * (len(names) - 1)
    x = W / 2 - total / 2
    for (label, col), wd in zip(names, widths):
        c, _ = chip(x, y - 28, label, col, w=wd, h=56, size=22)
        g.append(c)
        x += wd + 26
    return "".join(g)


def intro_tools():
    return (head() + kicker("THE AGENT YOU ALREADY RUN")
            + headline("Drives this notebook.", "", y=500)
            + d_tools() + subtitle("MCP server or the nebula CLI — nothing new to learn", y=790)
            + "</svg>")


def d_concurrent(y=628):
    """Two lanes writing the same stack of cells at once."""
    g = []
    for i in range(5):
        cy = y - 54 + i * 26
        g.append(f'<rect x="{W/2-150}" y="{cy}" width="300" height="18" rx="6" fill="#1b2540"/>')
    g.append(f'<rect x="{W/2-150}" y="{y-54+26}" width="300" height="18" rx="6" fill="{CYAN}" opacity="0.85"/>')
    g.append(f'<rect x="{W/2-150}" y="{y-54+3*26}" width="300" height="18" rx="6" fill="{LAV}" opacity="0.85"/>')
    g.append(f'<path d="M{W/2-320} {y-18} h140 m-12-9 12 9-12 9" stroke="{CYAN}" stroke-width="2.6" '
             f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
    g.append(f'<text x="{W/2-330}" y="{y-12}" font-size="21" fill="{CYAN}" text-anchor="end">you</text>')
    g.append(f'<path d="M{W/2+320} {y+34} h-140 m12-9-12 9 12 9" stroke="{LAV}" stroke-width="2.6" '
             f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
    g.append(f'<text x="{W/2+330}" y="{y+40}" font-size="21" fill="{LAV}">your agent</text>')
    return "".join(g)


def intro_concurrent():
    return (head() + kicker("NO TURN-TAKING")
            + headline("Edit the same cell.", "Both of you.")
            + d_concurrent()
            + subtitle("Per-cell concurrency — the agent retries on your version, never over it", y=782)
            + "</svg>")


def build_intro():
    return [("i1-title", intro_title(), 3.5),
            ("i2-tools", intro_tools(), 3.6),
            ("i3-concurrent", intro_concurrent(), 4.2)]


# --------------------------------------- v12: alternating app-view frames --
# The film's rhythm is dark card -> light app -> dark card. The new features
# have no footage (they postdate the shoot), so the "app" half is drawn in the
# product's own UI language (scripts/demo-illustrate.py) and captioned with the
# film's pill, not that script's lower-third — so it cuts like the recordings.

_DI = None


def _di():
    """Load the sibling scene library (its filename has a hyphen)."""
    global _DI
    if _DI is None:
        import importlib.util as iu
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo-illustrate.py")
        spec = iu.spec_from_file_location("demo_illustrate", path)
        _DI = iu.module_from_spec(spec)
        spec.loader.exec_module(_DI)
    return _DI


_CAP = None          # set per scene so the pill carries OUR line, not the scene's


def _pill_caption(text, sub=None):
    """The film's caption: a dark rounded pill, centred near the bottom."""
    di = _di()
    text = _CAP or text
    size, pad = 20.5, 26
    w = len(text) * size * 0.505 + pad * 2
    x, y = di.W / 2 - w / 2, di.H - 52
    return (f'<g filter="url(#sh)">'
            f'<rect x="{x}" y="{y}" width="{w}" height="38" rx="11" fill="#1e2536" '
            f'stroke="#6d5bd0" stroke-opacity="0.55"/></g>'
            f'<text x="{di.W/2}" y="{y + 25}" font-size="{size}" fill="#ffffff" font-weight="700" '
            f'text-anchor="middle">{esc(text)}</text>')


def app_views():
    """(slug, svg) for the light app halves, captioned film-style."""
    global _CAP
    di = _di()
    di.caption = _pill_caption          # scene functions read this at call time
    specs = [
        ("a1-focus",    di.s_focus,     (),   "It edits the notebook you're looking at"),
        ("a2-runs",     di.s_runs,      (),   "Run above, or this cell and everything below"),
        ("a3-collapse", di.s_collapse,  (1,), "Fold a long cell to a height you choose"),
        ("a4-sealed",   di.s_sealed,    (),   "Sealed: replayed clean, outputs matched, hash-bound"),
        ("a5-keys",     di.s_security,  (),   "Passkeys, 2FA, and a real token for your agent"),
        ("a6-arch",     di.s_compute,   (0,), "aarch64 queue? It hands the setup to your agent"),
    ]
    out = []
    for slug, fn, args, cap in specs:
        _CAP = cap
        out.append((slug, fn(*args), cap))
    _CAP = None
    return out


def build_v12_tail():
    """Feature block: dark card, then the app view of the same feature."""
    cards = {slug.split("-", 1)[1]: svg for slug, svg in build_cards() if slug != "07-end"}
    views = {slug.split("-", 1)[1]: (svg, cap) for slug, svg, cap in
             [(s, v, c) for s, v, c in app_views()]}
    order = ["focus", "runs", "collapse", "sealed", "keys", "arch"]
    seq = []
    for key in order:
        seq.append((f"c-{key}", cards[key], 3.4))
        svg, _cap = views[key]
        seq.append((f"v-{key}", svg, 3.4))
    seq.append(("z-end", end_card(), 4.4))
    return seq


def render_list(items, tag):
    os.makedirs(OUT, exist_ok=True)
    pngs, holds = [], []
    for slug, svg, secs in items:
        s = os.path.join(OUT, f"{tag}{slug}.svg")
        p = os.path.join(OUT, f"{tag}{slug}.png")
        with open(s, "w") as fh:
            fh.write(svg)
        subprocess.run(["rsvg-convert", "-w", str(W), "-h", str(H), "-o", p, s], check=True)
        pngs.append(p)
        holds.append(secs)
    return pngs, holds


def clip_from(pngs, holds, dst):
    inputs = []
    for p, sec in zip(pngs, holds):
        inputs += ["-loop", "1", "-t", f"{sec + XFADE:.2f}", "-i", p]
    chain, prev, off = [], "[0:v]", 0.0
    for i in range(1, len(pngs)):
        off += holds[i - 1]
        lbl = f"[v{i}]"
        chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={XFADE}:offset={off:.2f}{lbl}")
        prev = lbl
    cmd = ["ffmpeg", "-y", "-v", "error"] + inputs
    if chain:
        cmd += ["-filter_complex", ";".join(chain), "-map", prev]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-crf", "18", dst]
    subprocess.run(cmd, check=True)
    d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=nw=1:nk=1", dst], capture_output=True, text=True).stdout)
    return d


def build_v12():
    """New opening + untouched recording + alternating feature block + close."""
    OPENING_END = 11.0                      # original's three intro cards
    intro_png, intro_hold = render_list(build_intro(), "v12-")
    tail_png, tail_hold = render_list(build_v12_tail(), "v12-")
    intro_clip = os.path.join(OUT, "v12-intro.mp4")
    tail_clip = os.path.join(OUT, "v12-tail.mp4")
    di = clip_from(intro_png, intro_hold, intro_clip)
    dt = clip_from(tail_png, tail_hold, tail_clip)
    mid = os.path.join(OUT, "v12-mid.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(OPENING_END), "-i", OLD,
                    "-t", str(SPLICE_AT - OPENING_END), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-crf", "18", "-an", mid], check=True)
    lst = os.path.join(OUT, "v12.txt")
    with open(lst, "w") as fh:
        for f in (intro_clip, mid, tail_clip):
            fh.write(f"file '{f}'\n")
    video = os.path.join(OUT, "v12-video.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-c", "copy", video], check=True)
    total = di + (SPLICE_AT - OPENING_END) + dt
    # music: the original track, then a mid-track passage to cover the new tail
    a1 = os.path.join(OUT, "v12-a1.m4a")
    a2 = os.path.join(OUT, "v12-a2.m4a")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", OLD, "-t", f"{di + SPLICE_AT - OPENING_END:.2f}",
                    "-vn", "-c:a", "aac", "-b:a", "192k", a1], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "54", "-i", OLD, "-t", f"{dt + 1:.2f}",
                    "-vn", "-af", f"afade=t=in:st=0:d=0.9,afade=t=out:st={dt-1.2:.2f}:d=1.2",
                    "-c:a", "aac", "-b:a", "192k", a2], check=True)
    alst = os.path.join(OUT, "v12a.txt")
    with open(alst, "w") as fh:
        fh.write(f"file '{a1}'\nfile '{a2}'\n")
    audio = os.path.join(OUT, "v12-audio.m4a")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", alst,
                    "-c", "copy", audio], check=True)
    out = os.path.join(ROOT, "build", "film", "nebula-demo-v12.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", video, "-i", audio, "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out],
                   check=True)
    d = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", out], capture_output=True, text=True).stdout.strip()
    print(f"{out}  ({float(d):.1f}s, {os.path.getsize(out)/1e6:.1f} MB)")
    return out
