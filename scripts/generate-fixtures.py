"""Create synthetic test media only. Requires Pillow, numpy and soundfile."""
from pathlib import Path
import random
import numpy as np
from PIL import Image
import soundfile as sf

target = Path(__file__).resolve().parents[1] / 'target'
target.mkdir(exist_ok=True)
Image.frombytes('RGB', (256, 256), random.Random(123).randbytes(256 * 256 * 3)).save(target / 'preview-test.png')
(target / 'svg-test.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128"><rect width="256" height="128" fill="#252957"/><circle cx="128" cy="64" r="42" fill="#49e7cd"/></svg>', encoding='utf-8')
sf.write(target / 'audio-test.ogg', np.random.default_rng(42).normal(0, 0.01, (44100 * 6, 2)), 44100, format='OGG', subtype='VORBIS')
