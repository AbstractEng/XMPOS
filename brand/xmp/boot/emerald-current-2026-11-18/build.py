"""Recompose the selected Rose Current layout with the edited emerald artwork."""
from pathlib import Path
import base64
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / 'explorations-2026-11-17/01-rose-current.svg'
NS = '{http://www.w3.org/2000/svg}'
ET.register_namespace('', NS[1:-1])
tree = ET.parse(SOURCE)
root = tree.getroot()
root.find(NS+'image').set('href', 'data:image/png;base64,' +
                         base64.b64encode((HERE/'background.png').read_bytes()).decode())
root.find(NS+'title').text = 'XMP OS — Emerald Current'
root.find(NS+'desc').text = (
    'Selected Rose Current boot-screen layout with the rose pigment recoloured '
    'to the XMP UI emerald family. Original XMP and Abstract Engineering logo '
    'geometry, copy, loading motif and layout are retained. Static boot artwork.')
tree.write(HERE/'mpc-live-mk1-emerald-current.svg',encoding='utf-8',xml_declaration=True)

# Changing the background and accessible description must preserve all vectors.
original_paths = [(p.get('d'), p.get('transform'), p.get('fill')) for p in
                  ET.parse(SOURCE).getroot().iter(NS+'path')]
new_paths = [(p.get('d'), p.get('transform'), p.get('fill')) for p in root.iter(NS+'path')]
assert original_paths == new_paths
assert root.get('viewBox') == '0 0 1280 800'
print('Emerald Current SVG composed; all original vector paths and fills preserved.')
