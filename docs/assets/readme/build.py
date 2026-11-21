"""Render the README cover from existing XMP/AE vectors and Manrope outlines.

Optional artwork tooling: Python 3 and fonttools==4.61.1. Run from any directory.
No network, device access or raster generation is involved.
"""
from pathlib import Path
import html
import xml.etree.ElementTree as ET

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
NS = '{http://www.w3.org/2000/svg}'
ET.register_namespace('', NS[1:-1])
FOREST = '#35473e'


def vector_body(path, recolor=False):
    root = ET.parse(path).getroot()
    if recolor:
        for element in root.iter():
            if element.get('fill', '').upper() == '#F4ECD6':
                element.set('fill', FOREST)
    return ''.join(ET.tostring(child, encoding='unicode') for child in root
                   if child.tag not in {NS + 'title', NS + 'desc'})


def text_path(text, x, y, size, weight='Regular', tracking=0):
    font = TTFont(ROOT / f'brand/abstract-engineering/assets/fonts/Manrope-{weight}.ttf')
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / font['head'].unitsPerEm
    paths = []
    for char in text:
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, y)))
        commands = pen.getCommands()
        if commands:
            paths.append(f'<path d="{commands}"/>')
        x += font['hmtx'][name][0] * scale + tracking
    font.close()
    return f'<g fill="{FOREST}" aria-label="{html.escape(text, quote=True)}">' + ''.join(paths) + '</g>'


logo = vector_body(ROOT / 'brand/xmp/assets/svg/xmp-orbit.svg', recolor=True)
gesture = vector_body(ROOT / 'brand/abstract-engineering/assets/artwork/hero-gesture.svg')
body = [
    '<rect width="1440" height="400" fill="#f2efe9"/>',
    f'<svg x="680" y="-48" width="760" height="489" viewBox="0 0 1400 900"><title>Abstract Engineering gesture artwork</title>{gesture}</svg>',
    text_path('ABSTRACT ENGINEERING', 72, 55, 16, 'SemiBold', 2),
    f'<svg x="68" y="108" width="420" height="162" viewBox="0 0 1130 436"><title>XMP Orbit Play/Record mark</title>{logo}</svg>',
    text_path('OS', 516, 249, 58, 'Medium', -1),
    text_path('eXtensible Music Platform', 72, 322, 29, 'Regular', -.4),
    '<path d="M72 360 H610" fill="none" stroke="#35473e" stroke-opacity=".22"/>',
]
svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="400" viewBox="0 0 1440 400" role="img" aria-labelledby="title desc">
<title id="title">XMP OS — eXtensible Music Platform</title>
<desc id="desc">The Orbit Play/Record XMP mark in forest green, with gold, rose and iris artwork on a warm paper background. An Abstract Engineering project.</desc>
''' + '\n'.join(body) + '\n</svg>\n'
(HERE / 'cover.svg').write_text(svg)
print('Rendered docs/assets/readme/cover.svg')
