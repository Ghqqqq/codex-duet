"""Render Fugato's README art into docs/assets: the banner, four mode glyphs and four mode scores.

Run from anywhere: python3 docs/assets/src/fugato/build.py (needs fontTools and the fonts listed in README.md).
"""
import os

from art import INK, MUTED, TEXT, Glyphs, layout, load, stroke, strokes_svg, svg

OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
ITALIC = load("CormorantGaramond-Italic.ttf", {"wght": 500})
ITALIC_LIGHT = load("CormorantGaramond-Italic.ttf", {"wght": 400})
ITALIC_SEMI = load("CormorantGaramond-Italic.ttf", {"wght": 600})
ROMAN = load("CormorantGaramond.ttf", {"wght": 500})

PALETTE = {
    "light": {"canvas": "#FFFFFF", "ink": "#202725", "voices": INK["light"], "hair": "#C3CCC6",
              "stem": "#DCE2DE", "muted": "#5F6E66", "faint": "#EEF1EE"},
    "dark": {"canvas": "#0D1117", "ink": "#F5F3EC", "voices": INK["dark"], "hair": "#39433E",
             "stem": "#2A332F", "muted": "#9CAC9F", "faint": "#151C19"},
}


def write(name, content):
    with open(os.path.join(OUT, name), "w") as fh:
        fh.write(content)


def tones(theme, n):
    """n tones from the mark's lightest to darkest stroke (reversed brightness on dark canvases)."""
    base = INK[theme]
    if n <= 4:
        return base[4 - n:] if theme == "light" else base[:n]
    rgb = lambda c: [int(c[i:i + 2], 16) for i in (1, 3, 5)]
    a, b = rgb(base[0]), rgb(base[-1])
    return ["#" + "".join(f"{round(a[k] + (b[k] - a[k]) * i / (n - 1)):02X}" for k in range(3)) for i in range(n)]


def banner(theme):
    """The exposition: four voices enter one after another and close on a final barline."""
    text, muted = TEXT[theme], MUTED[theme]
    left, right = 70, 1500
    ys, entries, steps = [212, 276, 340, 404], [70, 300, 530, 760], [410, 640, 870, 1100]
    body = strokes_svg([stroke(entries[i], ys[i], steps[i], 24, right, 52) for i in range(4)], INK[theme], 9)
    body += f'<path d="M{right + 34} 172V412" stroke="{muted}" stroke-width="2" stroke-linecap="round"/>'
    body += f'<path d="M{right + 50} 172V412" stroke="{text}" stroke-width="6" stroke-linecap="round"/>'
    gl = Glyphs()
    title, w = gl.use(ITALIC, "Fugato", 128, left - 6, 112, text)
    sub, _ = gl.use(ITALIC_LIGHT, "for Claude and any number of Codex voices", 40, left + w + 36, 112, muted)
    return svg(1600, 470, gl.block() + body + title + sub, "Fugato, for Claude and any number of Codex voices")


def glyphs(theme):
    """One stroke vocabulary, four arrangements (200 x 88)."""
    ink, edge = INK[theme], 186
    shapes = {
        # One executor, with Claude's brief entering above and answering it.
        "pair": ([stroke(14, 34, 92, 10, edge, 22), stroke(56, 64, 128, 10, edge, 22)], tones(theme, 2)),
        # Two voices exchange places, crossing once (inversion).
        "duel": ([f"M14 22H74C100 22 100 66 126 66H{edge}", f"M44 66H74C100 66 100 22 126 22H{edge}"],
                 [ink[1], ink[3]]),
        # Many bounded voices fanned out, all arriving at one edge.
        "ultra": ([f"M{14 + i * 13} {12 + i * 10.6:.1f}H{edge}" for i in range(7)], tones(theme, 7)),
        # Six persistent voices, each entering with its own step.
        "roundtable": ([stroke(14 + i * 18, 22 + i * 11.5, 60 + i * 18, 6, edge, 14) for i in range(6)], tones(theme, 6)),
    }
    return {name: svg(200, 88, strokes_svg(paths, colors, 7.5), f"{name} glyph") for name, (paths, colors) in shapes.items()}


class Score:
    """A mode drawn as a page of a score: Claude's stave and the Codex voices, time running left to right."""

    def __init__(self, theme, height, top):
        self.p, self.h, self.top = PALETTE[theme], height, top
        self.parts, self.glyphs = [], Glyphs()

    def add(self, s):
        self.parts.append(s)

    def text(self, s, size, x, y, font=ROMAN, color=None, anchor="start"):
        w = layout(font, s, size)[1]
        x -= w if anchor == "end" else w / 2 if anchor == "middle" else 0
        self.add(self.glyphs.use(font, s, size, x, y, color or self.p["ink"])[0])

    def line(self, x1, y1, x2, y2, color=None, width=1.6, dash=None, cap="round"):
        da = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<path d="M{x1:.1f} {y1:.1f}L{x2:.1f} {y2:.1f}" stroke="{color or self.p["hair"]}" '
                 f'stroke-width="{width}" stroke-linecap="{cap}"{da}/>')

    def voice(self, x0, y, x_end, color, step_at=None, rise=12, step=26, width=10):
        d = f"M{x0:.1f} {y:.1f}H{x_end:.1f}" if step_at is None else stroke(x0, y, step_at, rise, x_end, step)
        self.add(f'<path d="{d}" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')

    def slur(self, x1, y1, x2, y2, color=None, dash=None):
        """A hand-off between staves."""
        da = f' stroke-dasharray="{dash}"' if dash else ""
        my = (y1 + y2) / 2
        self.add(f'<path d="M{x1:.1f} {y1:.1f}C{x1:.1f} {my:.1f} {x2:.1f} {my:.1f} {x2:.1f} {y2:.1f}" '
                 f'stroke="{color or self.p["muted"]}" stroke-width="1.6" stroke-linecap="round"{da}/>')

    def dot(self, x, y, r=6.5, filled=True, color=None):
        c = color or self.p["ink"]
        self.add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{c if filled else self.p["canvas"]}" '
                 f'stroke="{c}" stroke-width="2.4"/>')

    def barline(self, x, y1, y2, final=False):
        if final:
            self.line(x, y1, x, y2, self.p["muted"], 2)
            self.line(x + 12, y1, x + 12, y2, self.p["ink"], 6.5, cap="butt")
        else:
            self.line(x, y1, x, y2, self.p["hair"], 1.6)

    def stave(self, name, note, y, x=236, font=ITALIC_SEMI):
        self.text(name, 31, x, y + 9, font, self.p["ink"], "end")
        if note:
            self.text(note, 23, x, y + 36, ROMAN, self.p["muted"], "end")

    def mark(self, s, x, y, ink=False, anchor="start"):
        self.text(s, 28, x, y, ITALIC, self.p["ink"] if ink else self.p["muted"], anchor)

    def svg(self, title):
        return svg(1600, self.h, self.glyphs.block() + "".join(self.parts), title, self.top)


def pair(theme):
    s = Score(theme, 380, 100)
    p = s.p
    yc, yv, yr = 196, 316, 420
    s.stave("Claude", "plans · reviews", yc)
    s.stave("Ada", "Codex executor", yv)
    s.stave("verifier", "optional · read-only", yr, font=ITALIC)
    s.line(268, yc, 1468, yc, p["ink"], 2.4)
    phrases = [(330, 680, "initial"), (760, 1070, "rework 1"), (1150, 1420, "rework 2")]
    reviews = [720, 1110]
    for x in [268] + reviews:
        s.barline(x, yc - 40, yr + 30)
    s.barline(1468, yc - 40, yr + 30, final=True)
    s.dot(300, yc)
    s.mark("brief", 300, yc - 22, anchor="middle")
    for x in reviews:
        s.dot(x, yc, filled=False)
        s.mark("review", x, yc - 22, anchor="middle")
    s.mark("accept", 1474, yc - 52, ink=True, anchor="middle")
    for i, ((a, b, label), src) in enumerate(zip(phrases, [300] + reviews)):
        s.slur(src, yc + 8, a, yv - 8)
        s.voice(a, yv, b, p["voices"][i + 1], step_at=a + 46)
        s.slur(b + 6, yv - 6, reviews[i] if i < 2 else 1456, yc + 9, dash="2 7")
        s.text(label, 27, a, yv + 52, ITALIC, p["muted"])
    s.line(800, yr, 1040, yr, p["muted"], 2.4, dash="1 12")
    s.slur(1040, yr - 4, 1104, yv + 14, color=p["hair"], dash="2 7")
    s.text("challenges a round", 23, 800, yr + 40, ITALIC, p["muted"])
    return s.svg("Pair: Claude briefs one Codex executor, reviews its initial delivery and up to two rework rounds, "
                 "with an optional read-only verifier, and accepts at the final barline")


def duel(theme):
    s = Score(theme, 400, 116)
    p = s.p
    ya, yc, yb = 222, 334, 446
    s.stave("Codex", "builds, by default", ya)
    s.stave("Claude", "relays · decides", yc)
    s.stave("subagent", "Claude, breaks", yb)
    bars = [268, 680, 1080, 1468]
    for x in bars[:-1]:
        s.barline(x, ya - 44, yb + 34)
    s.barline(bars[-1], ya - 44, yb + 34, final=True)
    s.line(268, yc, 1468, yc, p["ink"], 2.4)
    for i, m in enumerate(["round 1", "round 2 · if needed", "round 3 · if needed"]):
        s.mark(m, bars[i] + 24, ya - 58)
    a_tone, b_tone = p["voices"][2], p["voices"][0] if theme == "light" else p["voices"][3]
    for i in range(3):
        x0, span = bars[i], bars[i + 1] - bars[i]
        a0, a1, b0, b1 = x0 + 36, x0 + span * 0.46, x0 + span * 0.50, x0 + span * 0.90
        relay, nxt = (a1 + b0) / 2, bars[i + 1] - 18
        s.voice(a0, ya, a1, a_tone, step_at=a0 + 40)
        s.voice(b0, yb, b1, b_tone, step_at=b0 + 40, rise=-12)
        s.slur(a1 + 6, ya + 6, relay, yc - 8, dash="2 7")
        s.dot(relay, yc, filled=False)
        s.slur(relay, yc + 8, b0, yb - 8)
        s.slur(b1 + 6, yb - 6, nxt, yc + 8, dash="2 7")
        s.dot(nxt, yc, filled=False)
        if i < 2:
            s.slur(nxt, yc - 8, bars[i + 1] + 36, ya + 8)
    s.dot(300, yc)
    s.slur(300, yc - 8, 304, ya + 8)
    s.text("build", 24, bars[0] + 96, ya + 44, ITALIC, p["muted"])
    s.text("break", 24, bars[0] + (bars[1] - bars[0]) * 0.50, yb + 50, ITALIC, p["muted"])
    s.mark("decide", 1474, ya - 58, ink=True, anchor="middle")
    return s.svg("Duel: a Codex builder above and a Claude subagent breaker below; every exchange passes through "
                 "Claude's stave between them, over up to three rounds")


def ultra(theme):
    s = Score(theme, 470, 100)
    p = s.p
    yc, lanes = 200, [296, 352, 408, 464, 520]
    s.stave("Claude", "briefs · accepts", yc)
    top, bot = lanes[0] - 14, lanes[-1] + 14
    mid = (top + bot) / 2
    s.add(f'<path d="M252 {top}C240 {top} 240 {top + 10} 240 {top + 28}V{mid - 16}C240 {mid - 4} 234 {mid} 226 {mid}'
          f'C234 {mid} 240 {mid + 4} 240 {mid + 16}V{bot - 28}C240 {bot - 10} 240 {bot} 252 {bot}" '
          f'stroke="{p["muted"]}" stroke-width="2" stroke-linecap="round"/>')
    s.text("Codex", 31, 212, mid - 6, ITALIC_SEMI, p["ink"], "end")
    s.text("voices in flight", 23, 212, mid + 24, ROMAN, p["muted"], "end")
    s.barline(268, yc - 44, bot + 24)
    s.barline(1468, yc - 44, bot + 24, final=True)
    s.line(268, yc, 1468, yc, p["ink"], 2.4)
    # Each lane is a worker slot; an item starts as soon as the previous one in that slot is accepted.
    plan = [[(300, 480), (540, 760), (830, 1120), (1190, 1360)],
            [(330, 510), (580, 720), (790, 1060), (1130, 1300)],
            [(370, 540), (610, 830), (900, 1150), (1220, 1400)],
            [(410, 590), (660, 800), (880, 1080), (1150, 1330)],
            [(450, 630), (700, 980), (1050, 1240)]]
    for y, phrases in zip(lanes, plan):
        for a, b in phrases:
            s.line(b + 10, y - 4, b + 10, yc + 6, p["stem"], 1.4)
    for y, phrases in zip(lanes, plan):
        for i, (a, b) in enumerate(phrases):
            s.voice(a, y, b, p["voices"][min(3, i)], step_at=a + 24, rise=8, step=18, width=7.5)
            s.dot(b + 10, yc, r=4.2, color=p["muted"])
    for x, m in [(300, "understand"), (520, "design"), (740, "implement"), (1010, "review"), (1180, "verify")]:
        s.mark(m, x, yc - 58)
    s.dot(284, yc)
    s.mark("accept", 1474, yc - 58, ink=True, anchor="middle")
    return s.svg("Ultra: Claude's stave above five Codex voices in flight; each phrase is accepted as it arrives "
                 "while the next starts, across understand, design, implement, review and verify")


def roundtable(theme):
    s = Score(theme, 510, 100)
    p = s.p
    yc, ys = 200, [284 + i * 56 for i in range(6)]
    s.stave("Claude", "chairs · decides", yc)
    for name, y in zip(["conjecturer", "critic", "steward", "improver", "integrator", "calibrator"], ys):
        s.text(name, 27, 236, y + 9, ITALIC_SEMI, p["ink"], "end")
    s.add(f'<rect x="284" y="{ys[0] - 30}" width="356" height="{ys[-1] - ys[0] + 60}" rx="10" fill="{p["faint"]}"/>')
    s.barline(268, yc - 44, ys[-1] + 34)
    s.barline(1468, yc - 44, ys[-1] + 34, final=True)
    s.line(268, yc, 1468, yc, p["ink"], 2.4)
    v = p["voices"]
    tone = [v[0], v[1], v[2], v[3], v[2], v[1]]
    for i, y in enumerate(ys):  # the sealed opening: each voice enters alone, later than the last
        a = 304 + i * 44
        s.voice(a, y, a + 120, tone[i], step_at=a + 30, rise=10, step=20, width=8)
    s.mark("sealed first round", 300, yc - 58)
    s.mark("threads", 700, yc - 58)
    s.mark("decide", 1474, yc - 58, ink=True, anchor="middle")

    def phrase(i, a, b, label=None):
        s.voice(a, ys[i], b, tone[i], step_at=a + 26, rise=10, step=20, width=8)
        if label:
            s.text(label, 23, b + 18, ys[i] + 8, ITALIC, p["muted"])

    phrase(1, 684, 784, "question")
    s.slur(790, ys[1] - 4, 880, ys[0] + 4)
    phrase(0, 880, 980, "reply")
    phrase(3, 700, 1040)
    s.add(f'<path d="M1052 {ys[3]}l10 -10l10 10l-10 10z" fill="{tone[3]}"/>')
    s.text("candidate", 23, 1084, ys[3] + 8, ITALIC, p["muted"])
    s.slur(1062, ys[3] - 12, 1150, ys[2] + 4)
    phrase(2, 1150, 1270, "finding")
    phrase(4, 760, 880, "combine")
    phrase(5, 900, 1010, "calibrate")
    s.slur(1276, ys[2] - 6, 1440, yc + 8, dash="2 7")
    s.dot(1440, yc, filled=False)
    s.dot(290, yc)
    return s.svg("Roundtable: six persona voices enter alone in a sealed first round, then answer one another in "
                 "threads; a candidate is followed by another member's finding before Claude decides")


if __name__ == "__main__":
    for theme in ("light", "dark"):
        write(f"fugato-banner-{theme}.svg", banner(theme))
        for name, content in glyphs(theme).items():
            write(f"fugato-glyph-{name}-{theme}.svg", content)
        for name, fn in (("ultra", ultra), ("pair", pair), ("duel", duel), ("roundtable", roundtable)):
            write(f"fugato-score-{name}-{theme}.svg", fn(theme))
    print("wrote", OUT)
