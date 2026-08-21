#  Replaces the embedded textures in a GLB with a 1x1 pixel, rebuilding the
#  binary chunk so the file actually gets smaller.
#
#  Structure is preserved exactly — every node, mesh and material stays, and
#  only the image data changes — because the loader looks meshes up by name and
#  a wholesale stub risks blanking the page.
import json, struct, sys, os

TINY = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000d49444154789c6360000002000100ffff03000006"
    "00057b7d5c0000000049454e44ae426082")

def strip(path):
    d = open(path, 'rb').read()
    magic, ver, total = struct.unpack('<III', d[:12])
    if magic != 0x46546C67:
        return 0
    off, chunks = 12, []
    while off < total:
        clen, ctype = struct.unpack('<II', d[off:off+8])
        chunks.append((ctype, d[off+8:off+8+clen]))
        off += 8 + clen + ((4 - clen % 4) % 4)
    js = json.loads(chunks[0][1].decode('utf-8').rstrip('\x00'))
    binary = chunks[1][1] if len(chunks) > 1 else b''
    if 'bufferViews' not in js:
        return 0

    image_views = {img['bufferView'] for img in js.get('images', []) if 'bufferView' in img}
    if not image_views:
        return 0

    out = bytearray()
    for i, bv in enumerate(js['bufferViews']):
        start = bv.get('byteOffset', 0)
        data = TINY if i in image_views else binary[start:start + bv['byteLength']]
        while len(out) % 4:
            out.append(0)
        bv['byteOffset'] = len(out)
        bv['byteLength'] = len(data)
        bv.pop('byteStride', None) if i in image_views else None
        out.extend(data)

    js['buffers'] = [{'byteLength': len(out)}]
    before = os.path.getsize(path)
    jb = json.dumps(js, separators=(',', ':')).encode('utf-8')
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    ob = bytes(out) + b'\x00' * ((4 - len(out) % 4) % 4)
    body = struct.pack('<II', len(jb), 0x4E4F534A) + jb + struct.pack('<II', len(ob), 0x004E4942) + ob
    open(path, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)
    return before - os.path.getsize(path)

saved = 0
for root, _, files in os.walk(sys.argv[1]):
    for n in files:
        if n.lower().endswith('.glb'):
            saved += strip(os.path.join(root, n))
print(f"stripped GLB textures, saved {saved/1048576:.1f} MB")
