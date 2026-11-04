# Fugato README art

`build.py` draws every image the README uses, as light and dark SVG pairs in
`docs/assets/`:

| File | What it is |
| --- | --- |
| `fugato-banner-{light,dark}.svg` | The exposition banner: four voices enter one after another and close on a final barline |
| `fugato-glyph-<mode>-{light,dark}.svg` | One small stroke figure per mode, for the mode table |
| `fugato-score-<mode>-{light,dark}.svg` | Each mode drawn as a page of a score: Claude's stave and the Codex voices |

The drawings reuse the mark's stroke (`docs/assets/fugato-mark-*.svg`) and its
four tones. Text is set as glyph outlines, so the images look the same on every
system; each glyph is defined once per file and referenced with `<use>`.

## Regenerate

Requires Python 3 with `fontTools`, and Cormorant Garamond (italic and upright
variable fonts, SIL Open Font License 1.1) in `fonts/` next to the script, or
in a directory named by `FUGATO_FONTS`:

```bash
mkdir -p docs/assets/src/fugato/fonts
curl -L -o docs/assets/src/fugato/fonts/CormorantGaramond-Italic.ttf \
  "https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantgaramond/CormorantGaramond-Italic%5Bwght%5D.ttf"
curl -L -o docs/assets/src/fugato/fonts/CormorantGaramond.ttf \
  "https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf"
python3 docs/assets/src/fugato/build.py
```

The `fonts/` directory is ignored by Git.
