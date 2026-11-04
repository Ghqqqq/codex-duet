"""Drawing helpers for Fugato's README art: the mark's stroke, palettes and text set as glyph outlines."""
import os

from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONTS = os.environ.get("FUGATO_FONTS", os.path.join(os.path.dirname(__file__), "fonts"))

# Tones of the shipped mark (docs/assets/fugato-mark-*.svg), lightest stroke first.
INK = {"light": ["#687A70", "#536D62", "#3B4942", "#202725"],
       "dark": ["#7C8981", "#9CAC9F", "#C5CDC3", "#F5F3EC"]}
TEXT = {"light": "#202725", "dark": "#F5F3EC"}
MUTED = {"light": "#687A70", "dark": "#9CAC9F"}


def load(name, axes=None):
    font = TTFont(os.path.join(FONTS, name))
    if axes and "fvar" in font:
        font = instancer.instantiateVariableFont(font, axes)
    return font


def stroke(x0, y, x1, rise, x_end, step=16):
    """The mark's stroke: enters at x0 on y, steps softly by `rise` over `step` at x1, runs to x_end."""
    h = step / 2
    return (f"M{x0:.2f} {y:.2f}H{x1:.2f}C{x1 + h:.2f} {y:.2f} {x1 + h:.2f} {y - rise:.2f} "
            f"{x1 + step:.2f} {y - rise:.2f}H{x_end:.2f}")


def strokes_svg(paths, colors, stroke_w):
    return "".join(f'<path d="{d}" stroke="{c}" stroke-width="{stroke_w:.2f}" stroke-linecap="round" '
                   f'stroke-linejoin="round"/>' for d, c in zip(paths, colors))


def svg(width, height, body, title, top=0):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {top} {width:.0f} {height:.0f}" '
            f'width="{width:.0f}" height="{height:.0f}" fill="none"><title>{title}</title>{body}</svg>\n')


_KERN = {}


def _kerning(font):
    """(left, right) glyph name pairs to x-advance adjustments from GPOS pair positioning."""
    if id(font) in _KERN:
        return _KERN[id(font)]
    kern = {}
    if "GPOS" in font:
        for lookup in font["GPOS"].table.LookupList.Lookup:
            subtables = lookup.SubTable
            if lookup.LookupType == 9:
                subtables = [s.ExtSubTable for s in subtables]
            for st in subtables:
                if getattr(st, "LookupType", lookup.LookupType) != 2:
                    continue
                if st.Format == 1:
                    for first, pairset in zip(st.Coverage.glyphs, st.PairSet):
                        for rec in pairset.PairValueRecord:
                            v = getattr(rec.Value1, "XAdvance", 0) if rec.Value1 else 0
                            if v:
                                kern.setdefault((first, rec.SecondGlyph), v)
                elif st.Format == 2:
                    cls1 = st.ClassDef1.classDefs if st.ClassDef1 else {}
                    cls2 = st.ClassDef2.classDefs if st.ClassDef2 else {}
                    for first in st.Coverage.glyphs:
                        row = st.Class1Record[cls1.get(first, 0)].Class2Record
                        for second, c2 in cls2.items():
                            v = getattr(row[c2].Value1, "XAdvance", 0) if row[c2].Value1 else 0
                            if v:
                                kern.setdefault((first, second), v)
    _KERN[id(font)] = kern
    return kern


def layout(font, text, size, x=0.0):
    """[(glyph name, x)] for `text` at `size` px, kerned, and its advance width."""
    scale = size / font["head"].unitsPerEm
    cmap, hmtx, kern = font.getBestCmap(), font["hmtx"], _kerning(font)
    names = [cmap[ord(ch)] for ch in text]
    out, cursor = [], 0.0
    for i, name in enumerate(names):
        out.append((name, x + cursor * scale))
        cursor += hmtx[name][0]
        if i + 1 < len(names):
            cursor += kern.get((name, names[i + 1]), 0)
    return out, cursor * scale


def glyph_d(font, name):
    """A glyph outline in font units, integer coordinates, y up."""
    rec = RecordingPen()
    font.getGlyphSet()[name].draw(rec)
    parts = []
    for op, pts in rec.value:
        if op == "qCurveTo" and len(pts) > 2:
            # Consecutive off-curve points imply on-curve midpoints.
            for i in range(len(pts) - 1):
                c = pts[i]
                e = pts[i + 1] if i == len(pts) - 2 else ((c[0] + pts[i + 1][0]) / 2, (c[1] + pts[i + 1][1]) / 2)
                parts.append(f"Q{round(c[0])} {round(c[1])} {round(e[0])} {round(e[1])}")
            continue
        code = {"moveTo": "M", "lineTo": "L", "qCurveTo": "Q", "curveTo": "C", "closePath": "Z", "endPath": ""}[op]
        parts.append(code + " ".join(f"{round(px)} {round(py)}" for px, py in pts))
    return "".join(parts)


class Glyphs:
    """Each glyph used in one SVG is defined once; text becomes <use> references to it."""

    def __init__(self):
        self.defs, self.ids = [], {}

    def use(self, font, text, size, x, y, color):
        s = size / font["head"].unitsPerEm
        items, width = layout(font, text, size, x)
        refs = []
        for name, gx in items:
            key = (id(font), name)
            if key not in self.ids:
                self.ids[key] = f"g{len(self.ids)}"
                self.defs.append(f'<path id="{self.ids[key]}" d="{glyph_d(font, name)}"/>')
            refs.append(f'<use href="#{self.ids[key]}" transform="matrix({s:.5f} 0 0 {-s:.5f} {gx:.1f} {y:.1f})"/>')
        return f'<g fill="{color}">{"".join(refs)}</g>', width

    def block(self):
        return f'<defs>{"".join(self.defs)}</defs>' if self.defs else ""
