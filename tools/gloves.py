"""Paint the gloves on the hands that hold the guns: blender -b --disable-autoexec -P tools/gloves.py -- web/public/models [previews]

The hands are a sculpted pair (tools/assets/fps_arms.blend, CC0; tools/weapons.py poses them). The
sculpt has texture coordinates: each hand laid flat, back and palm. This paints a tactical glove in
that flat layout, the way such gloves are made (looked up in pictures of real ones and of the gloved
hands of other shooters): a palm and fingertips of tan leather, a back of green-grey fabric, strips
of stretch fabric between the fingers, a moulded rubber guard over the knuckles and ribbed rubber
pads on the backs of the fingers, a second layer of leather on the heel of the palm, a strap round
the wrist, and a seam with a row of stitches wherever two pieces meet.

Three pictures come out, each 1024 x 512, used by the game on the material "Glove" (weapon.ts):

  glove_color.webp   the colours
  glove_normal.webp  the relief: pads and stitches stand up, seams and ribs lie deep
  glove_rough.webp   how dull each piece is (leather shines a little, fabric not at all)

Which piece a spot belongs to is worked out per pixel from where that spot lies on the hand: which
finger (by the sculpt's bone weights), how far along it, on the palm's side or the back, and where
on the palm. Nothing is drawn by hand and nothing is random between runs.

tools/weapons.py imports this file for the things both must agree on: the hand's size, which part
of the sculpt is the hand, and the corner of the sculpt's layout the hands lie in.
"""
import math
import os
import sys

import bpy

ARMS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "fps_arms.blend")
HAND_SCALE = 0.088  # the sculpt's units to metres: a gloved hand 18.5 cm from wrist to fingertip
CUT = 0.045         # m: how far up the forearm the hand's skin goes (the cuff covers the cut)
W, H = 1024, 512
FINGERS = ["thumb", "index", "middle", "ring", "pinky"]


def load_arms(link):
    """The sculpt's skeleton and skin, taken into this scene (`link` puts an object in it)."""
    with bpy.data.libraries.load(ARMS) as (have, take):
        take.objects = [n for n in have.objects if n.startswith("caucasian_male_1")]
    for o in take.objects:
        link(o)
        o.hide_render = True
    rig = next(o for o in take.objects if o.type == "ARMATURE")
    body = next(o for o in take.objects if o.type == "MESH")
    # The rig's own helpers (each finger's end bones copying its first, the forearm reaching for the hand)
    # would undo a pose set bone by bone.
    for pb in rig.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    return rig, body


def kept(rig, body, side, cut=CUT):
    """The points of the skin that are this hand (side 1: right, -1: left): from the fingertips to `cut` up the forearm."""
    X = ".R" if side > 0 else ".L"
    mw, bw = rig.matrix_world, body.matrix_world
    fore = rig.data.bones["forearm" + X]
    wr = mw @ fore.tail_local
    up = (mw @ fore.head_local - wr).normalized()
    return {v.index for v in body.data.vertices
            if (bw @ v.co).x * side > 0 and (bw @ v.co - wr).dot(up) < cut / HAND_SCALE}


def uv_of(mesh, loop):
    return mesh.uv_layers.active.uv[loop].vector


def uv_box(rig, body):
    """The corner of the sculpt's flat layout that the two hands lie in: (u0, v0, u1, v1), with a little room.
    The hands up to the wrist: the bit of forearm above it lies elsewhere in the layout, and under the cuff."""
    me = body.data
    keep = kept(rig, body, 1, 0.0) | kept(rig, body, -1, 0.0)
    us, vs = [], []
    for p in me.polygons:
        if all(i in keep for i in p.vertices):
            for li in p.loop_indices:
                uv = uv_of(me, li)
                us.append(uv.x)
                vs.append(uv.y)
    pad = 0.006
    return (min(us) - pad, min(vs) - pad, max(us) + pad, max(vs) + pad)


# ---------------------------------------------------------------------------------------------------
# Painting. Only when run by itself.

def paint(out_dir, preview):
    import numpy as np

    out_dir = os.path.abspath(out_dir)
    preview = os.path.abspath(preview) if preview else ""

    rig, body = load_arms(bpy.context.scene.collection.objects.link)
    bpy.context.view_layer.update()
    mw, bw = rig.matrix_world, body.matrix_world
    me = body.data
    me.calc_loop_triangles()
    box = uv_box(rig, body)
    nv = len(me.vertices)
    co = np.array([list(bw @ v.co) for v in me.vertices]) * HAND_SCALE
    turn = bw.to_3x3()
    no = np.array([list((turn @ v.normal).normalized()) for v in me.vertices])
    groups = {g.index: g.name for g in body.vertex_groups}

    cover = np.zeros((H, W), bool)
    P = np.zeros((H, W, 3))
    N = np.zeros((H, W, 3))
    F = np.zeros((H, W, 6))  # how much of each finger a spot is, and of the palm
    S = np.zeros((H, W), np.int8)  # 1: the right hand, -1: the left

    def px(uv):
        return ((uv.x - box[0]) / (box[2] - box[0]) * W, (1 - (uv.y - box[1]) / (box[3] - box[1])) * H)

    frames = {}
    for side in (1, -1):
        X = ".R" if side > 0 else ".L"
        keep = kept(rig, body, side)
        fw = np.zeros((nv, 6))
        for i in keep:
            for g in me.vertices[i].groups:
                name = groups[g.group]
                if not name.endswith(X):
                    continue
                k = 5
                for f, finger in enumerate(FINGERS):
                    if name.startswith("f_" + finger) or (finger == "thumb" and name in ("thumb.02" + X, "thumb.03" + X)):
                        k = f
                fw[i, k] += g.weight
        fw /= np.maximum(fw.sum(1, keepdims=True), 1e-9)
        for lt in me.loop_triangles:
            vi = list(lt.vertices)
            if not all(i in keep for i in vi):
                continue
            (x0, y0), (x1, y1), (x2, y2) = (px(uv_of(me, li)) for li in lt.loops)
            den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
            if abs(den) < 1e-9:
                continue
            ia, ib = max(0, int(min(x0, x1, x2)) - 1), min(W, int(max(x0, x1, x2)) + 2)
            ja, jb = max(0, int(min(y0, y1, y2)) - 1), min(H, int(max(y0, y1, y2)) + 2)
            if ia >= ib or ja >= jb:
                continue
            gx, gy = np.meshgrid(np.arange(ia, ib) + 0.5, np.arange(ja, jb) + 0.5)
            l0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / den
            l1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / den
            l2 = 1 - l0 - l1
            inside = (l0 >= -0.03) & (l1 >= -0.03) & (l2 >= -0.03)
            if not inside.any():
                continue
            lam = np.stack([l0, l1, l2], -1)[inside]
            jj, ii = np.nonzero(inside)
            jj += ja
            ii += ia
            cover[jj, ii] = True
            P[jj, ii] = lam @ co[vi]
            N[jj, ii] = lam @ no[vi]
            F[jj, ii] = lam @ fw[vi]
            S[jj, ii] = side

        def at(name, tail=False):
            b = rig.data.bones[name + X]
            return np.array(list(mw @ (b.tail_local if tail else b.head_local))) * HAND_SCALE

        wrist = at("hand")
        mcp = [at(f"f_{n}.01") for n in FINGERS[1:]]
        along = mcp[1] - wrist
        along /= np.linalg.norm(along)
        # The palm's side: the side the sculpt's relaxed fingers bend to.
        k0, k1 = at("palm_middle"), at("palm_middle", True)
        way = (k1 - k0) / np.linalg.norm(k1 - k0)
        palm = at("f_middle.03", True) - k1
        palm -= way * palm.dot(way)
        palm -= along * palm.dot(along)
        palm /= np.linalg.norm(palm)
        across = np.cross(along, palm)
        if (mcp[3] - mcp[0]).dot(across) < 0:
            across = -across  # from the index finger to the little finger, on either hand
        joints = [[at("thumb.02"), at("thumb.02", True), at("thumb.03", True)]]
        joints += [[at(f"f_{n}.01"), at(f"f_{n}.01", True), at(f"f_{n}.02", True), at(f"f_{n}.03", True)] for n in FINGERS[1:]]
        frames[side] = (wrist, along, across, palm, mcp, joints)

    # ---- Which piece each spot is.
    FABRIC, LEATHER, PAD, STRAP, PATCH, GUSSET, PANEL = range(7)
    piece = np.zeros((H, W), np.int8)
    groove = np.zeros((H, W), bool)
    for side in (1, -1):
        wrist, along, across, palm, mcp, joints = frames[side]
        m = cover & (S == side)
        p, n, f = P[m], N[m], F[m]
        n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        rel = p - wrist
        x, y, nz = rel @ across, rel @ along, n @ palm
        which = f[:, :5].argmax(1)
        on_finger = f[:, :5].max(1) > f[:, 5]
        cls = np.where(nz > 0.12, LEATHER, FABRIC).astype(np.int8)
        ribs = np.zeros(len(p), bool)
        for k in range(5):
            sel = on_finger & (which == k)
            if not sel.any():
                continue
            q = p[sel]
            best = np.full(len(q), 1e9)
            t = np.zeros(len(q))
            run = 0.0
            for a, b in zip(joints[k], joints[k][1:]):
                d = b - a
                L = np.linalg.norm(d)
                s = np.clip(((q - a) @ d) / (L * L), 0, 1)
                dist = np.linalg.norm(q - (a + s[:, None] * d), axis=1)
                nearer = dist < best
                best = np.where(nearer, dist, best)
                t = np.where(nearer, run + s * L, t)
                run += L
            u = t / run
            side_z = nz[sel]
            c = np.where(side_z > 0.12, LEATHER, np.where(side_z > -0.4, GUSSET, FABRIC)).astype(np.int8)
            c[u > (0.62 if k == 0 else 0.8)] = LEATHER  # the fingertip's cap, all round
            if k > 0:
                strip = (side_z < -0.55) & (((u > 0.15) & (u < 0.36)) | ((u > 0.45) & (u < 0.64)))
                c[strip] = PAD
                r = np.zeros(len(q), bool)
                r[strip] = (t[strip] / 0.0034) % 1.0 < 0.24
                ribs[sel] = r
            cls[sel] = c
        hand = ~on_finger
        # The knuckle guard: within 12 mm of the line through the four knuckles, on the back.
        kx = [(k - wrist) @ across for k in mcp]
        ky = [(k - wrist) @ along - 0.004 for k in mcp]
        dist = np.full(len(p), 1e9)
        for i in range(3):
            ax, ay, bx, by = kx[i], ky[i], kx[i + 1], ky[i + 1]
            L2 = (bx - ax) ** 2 + (by - ay) ** 2
            s = np.clip(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2, 0, 1)
            dist = np.minimum(dist, np.hypot(x - (ax + s * (bx - ax)), y - (ay + s * (by - ay))))
        guard = hand & (nz < -0.25) & (dist < 0.0105)
        cls[guard] = PAD
        for i in range(3):
            ribs |= guard & (np.abs(x - (kx[i] + kx[i + 1]) / 2) < 0.0011)
        lo, hi = min(kx), max(kx)
        panel = hand & (nz < -0.4) & (y > 0.03) & (y < min(ky) - 0.02) & (x > lo + 0.003) & (x < hi - 0.003)
        cls[panel] = PANEL
        mid = (lo + hi) / 2
        cls[hand & (nz > 0.4) & (((x - mid) / 0.033) ** 2 + ((y - 0.04) / 0.022) ** 2 < 1)] = PATCH
        cls[hand & (y < 0.02)] = STRAP
        piece[m] = cls
        groove[m] = ribs

    # ---- Seams where two pieces meet, and the stitches beside them.
    def grow(mask, n):
        for _ in range(n):
            g = mask.copy()
            g[1:] |= mask[:-1]
            g[:-1] |= mask[1:]
            g[:, 1:] |= mask[:, :-1]
            g[:, :-1] |= mask[:, 1:]
            mask = g
        return mask

    edge = np.zeros((H, W), bool)
    for dj, di in ((0, 1), (1, 0)):
        a = piece[:H - dj, :W - di]
        b = piece[dj:, di:]
        both = cover[:H - dj, :W - di] & cover[dj:, di:] & (S[:H - dj, :W - di] == S[dj:, di:])
        edge[:H - dj, :W - di] |= both & (a != b)
    seam = grow(edge, 1) & cover
    jj, ii = np.mgrid[0:H, 0:W]
    stitch = grow(edge, 3) & ~grow(edge, 2) & cover & (piece != PAD) & ((ii + 2 * jj) % 6 < 4)

    # ---- The colours, the dullness and the relief of each piece.
    rng = np.random.default_rng(7)

    def blur(a, n):
        for _ in range(n):
            a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5
        return a

    fine = blur(rng.random((H, W)), 1)
    fine = (fine - fine.min()) / (fine.max() - fine.min())
    blotch = blur(rng.random((H, W)), 40)
    blotch = (blotch - blotch.min()) / (blotch.max() - blotch.min())
    weave = np.sin(ii * (2 * math.pi / 3.0)) * np.sin(jj * (2 * math.pi / 3.0))

    looks = {  # colour (sRGB), dullness, height
        FABRIC: ((0.300, 0.315, 0.265), 0.93, 0.00),
        GUSSET: ((0.225, 0.235, 0.205), 0.93, -0.08),
        PANEL: ((0.365, 0.380, 0.320), 0.90, 0.10),
        LEATHER: ((0.520, 0.405, 0.275), 0.60, 0.15),
        PATCH: ((0.440, 0.335, 0.225), 0.66, 0.50),
        PAD: ((0.085, 0.087, 0.092), 0.42, 1.00),
        STRAP: ((0.160, 0.165, 0.150), 0.84, 0.60),
    }
    color = np.zeros((H, W, 3))
    rough = np.zeros((H, W))
    height = np.zeros((H, W))
    for k, (c, r, h) in looks.items():
        m = piece == k
        color[m] = c
        rough[m] = r
        height[m] = h
    cloth = np.isin(piece, (FABRIC, GUSSET, PANEL, STRAP))
    hide = np.isin(piece, (LEATHER, PATCH))
    color[cloth] *= (1 + 0.10 * weave[cloth] + 0.10 * (blotch[cloth] - 0.5))[:, None]
    height[cloth] += 0.07 * weave[cloth]
    color[hide] *= (1 + 0.12 * (fine[hide] - 0.5) + 0.22 * (blotch[hide] - 0.5))[:, None]
    height[hide] += 0.06 * (fine[hide] - 0.5)
    rough[hide] += 0.12 * (blotch[hide] - 0.5)
    rubber = piece == PAD
    color[rubber] *= (1 + 0.08 * (fine[rubber] - 0.5))[:, None]
    color[groove] *= 0.6
    height[groove] -= 0.6
    rough[groove] = 0.7
    color[seam] *= 0.6
    height[seam] -= 0.45
    rough[seam] = 0.95
    color[stitch] = (0.60, 0.53, 0.40)
    height[stitch] += 0.25
    rough[stitch] = 0.85
    # Shade in the hollows: darker where a spot lies lower than what is round it.
    soft = blur(height, 6)
    color *= np.clip(1 - 0.55 * (soft - height), 0.6, 1.15)[:, :, None]

    def bleed(a, n):
        """Spread the painted part over the unpainted, so the edges of the layout don't show from far off."""
        have = cover.copy()
        a = a.copy()
        for _ in range(n):
            total = np.zeros_like(a)
            count = np.zeros((H, W))
            for dj, di in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                sh = np.roll(have, (dj, di), (0, 1))
                total += np.roll(a, (dj, di), (0, 1)) * (sh[..., None] if a.ndim == 3 else sh)
                count += sh
            new = ~have & (count > 0)
            if a.ndim == 3:
                a[new] = total[new] / count[new][:, None]
            else:
                a[new] = total[new] / count[new]
            have |= new
        return a

    color = np.clip(bleed(color, 16), 0, 1)
    rough = np.clip(bleed(rough, 16), 0, 1)
    height = blur(bleed(height, 16), 1)
    k = 2.6
    gx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / 2
    gy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / 2
    nrm = np.stack([-gx * k, gy * k, np.ones((H, W))], -1)
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    nrm = nrm * 0.5 + 0.5

    def save(name, rgb, space, fmt="WEBP", folder=out_dir):
        img = bpy.data.images.new(name, W, H, alpha=False)
        img.colorspace_settings.name = space
        rgba = np.ones((H, W, 4), np.float32)
        rgba[..., :3] = rgb if rgb.ndim == 3 else rgb[..., None]
        img.pixels.foreach_set(np.flipud(rgba).ravel())
        img.file_format = fmt
        path = os.path.join(folder, name + ("." + fmt.lower()))
        img.filepath_raw = path
        img.save(quality=92)
        print("written", path, os.path.getsize(path), "bytes")

    os.makedirs(out_dir, exist_ok=True)
    save("glove_color", color, "sRGB")
    save("glove_normal", nrm, "Non-Color")
    save("glove_rough", rough, "Non-Color")
    if preview:
        os.makedirs(preview, exist_ok=True)
        save("glove_color", color, "sRGB", "PNG", preview)
        save("glove_normal", nrm, "Non-Color", "PNG", preview)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    paint(argv[0], argv[1] if len(argv) > 1 else "")
