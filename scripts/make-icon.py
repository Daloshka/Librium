"""Generate Librium's geometric application mark and the Windows and macOS icon sizes."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'desktop' / 'assets'
root.mkdir(parents=True, exist_ok=True)
scale = 4
im = Image.new('RGBA', (256 * scale, 256 * scale))
d = ImageDraw.Draw(im)
def box(bounds, radius, fill):
    d.rounded_rectangle(tuple(int(v * scale) for v in bounds), radius * scale, fill=fill)

box((8, 8, 248, 248), 58, '#171c39')
box((20, 20, 236, 236), 48, '#252957')
box((62, 51, 99, 201), 13, '#a394ff')
box((62, 164, 198, 201), 13, '#a394ff')
box((121, 61, 199, 84), 11, '#49e7cd')
box((121, 104, 177, 127), 11, '#65baff')
im.save(root / 'icon.icns')  # 1024 px master; Pillow embeds the macOS icon sizes
im = im.resize((256, 256), Image.Resampling.LANCZOS)
im.save(root / 'icon.png')
im.save(root / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
