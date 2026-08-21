#  Downscales oversized textures in a built dist.
#
#  Cosmos Journeyer ships 4K terrain materials — grass, sand, ice, concrete —
#  because you can land on its planets and walk around. This page never gets
#  nearer than a few planetary radii, where a 4096px albedo and a 512px one are
#  the same handful of pixels.
#
#  They are resized rather than deleted on purpose: the loader waits on its own
#  progress monitor, and a missing asset risks it never completing. Every file
#  stays exactly where the bundle expects it, just smaller.
import os, sys
from PIL import Image

DIST = sys.argv[1]
MAX_EDGE = int(sys.argv[2]) if len(sys.argv) > 2 else 512
FLOOR = 400_000  # leave anything already small alone

#  Never touch the brand mark. It is displayed at up to 46rem — larger than the
#  cap this script enforces — so shrinking it visibly softens the one asset on
#  the page whose crispness anyone will actually notice.
KEEP = ("starktronix-logo",)

saved = 0
touched = 0
for root, _, files in os.walk(DIST):
    for name in files:
        if not name.lower().endswith(('.webp', '.png', '.jpg', '.jpeg')):
            continue
        if any(k in name for k in KEEP):
            continue
        path = os.path.join(root, name)
        before = os.path.getsize(path)
        if before < FLOOR:
            continue
        try:
            im = Image.open(path)
        except Exception:
            continue
        if max(im.size) <= MAX_EDGE:
            continue
        ratio = MAX_EDGE / max(im.size)
        new = (max(1, int(im.width * ratio)), max(1, int(im.height * ratio)))
        im = im.convert('RGBA' if im.mode in ('RGBA', 'LA', 'P') and 'png' in name.lower() else 'RGB')
        im = im.resize(new, Image.LANCZOS)
        if name.lower().endswith('.png'):
            im.save(path, optimize=True)
        elif name.lower().endswith('.webp'):
            im.save(path, quality=82, method=4)
        else:
            im.save(path, quality=85, optimize=True)
        after = os.path.getsize(path)
        saved += before - after
        touched += 1

print(f"shrank {touched} textures to <= {MAX_EDGE}px, saved {saved/1048576:.1f} MB")
