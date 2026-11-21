"""Build the woods' undergrowth (web/src/world/undergrowth.ts) as real plants, in Blender.

Run (Blender 5, no window):
  blender -b -P tools/undergrowth.py -- <out.glb> [preview_dir]

  e.g. blender -b -P tools/undergrowth.py -- web/public/models/undergrowth.glb

What grows on the floor of a Flemish wood at the end of November, at the plants' real sizes, built
here in code (no image, no cut-out: every leaflet is a few small opaque triangles, coloured on its
corners):

- Bracken (Pteridium aquilinum), 0.6 to 1.2 m: a frond is a triangular blade on a stalk, divided
  twice, pairs of side leaflets (pinnae) that get shorter towards the tip, each cut into small
  oblong lobes almost to its middle. By late November most fronds are dead: russet brown, arching
  over or collapsed flat. BrackenGreen (upright, yellow-green, the last live ones), BrackenArch
  (brown, arching over), BrackenFlat (brown, collapsed on the ground).
- Bramble (Rubus fruticosus): purple-red thorny canes of 1 to 2 m that arch out and come back to the
  ground, half bare by late November; leaves of three or five leaflets, dark green, many turned red
  and purple, a few dead; a tangle about 0.4 to 0.8 m high.
  Bramble1, Bramble2.
- Shrubs of about 1.2 m: Holly (dense, dark evergreen, wavy spiny leaves, a few red berries),
  Hazel (several straight stems from one foot, nearly bare, a few yellow leaves and the catkins
  already formed for the spring), Beech (a young one, thin, keeping its dry coppery leaves through
  the winter in flat sprays).
- Fallen wood: Branch (a fallen branch with side twigs), Log (a short cut log), Stump; patches of
  moss on the wood where it lies.

Each in a near and a far level of detail. The far one (<name>Far) is the same plant, for beyond
about 12 m: built from the same random numbers, its stalks with fewer sides, its thin twigs left
out, and one leaf in three or four kept as a bigger diamond of two triangles, so its outline and
colour stay those of the near one in a tenth of the triangles.

One GLB, one object per model, each standing on its origin (the plant's foot on the ground), with
no normals (the game works them out) and no texture coordinates: the colours are on the corners
(COLOR_0), baked here; the game tints each copy a little.
"""
import json
import math
import os
import random
import struct
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

UP = Vector((0, 0, 1))


def lin(h):
    """'#rrggbb' to linear RGB, as glTF's vertex colours are."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def scale(c, k):
    return tuple(min(1.0, x * k) for x in c)


def vary(c, rng, amount):
    """A colour a little lighter or darker and a little warmer or cooler."""
    k = 1 + (rng.random() * 2 - 1) * amount
    w = (rng.random() * 2 - 1) * amount * 0.5
    return tuple(min(1.0, max(0.0, x * k * (1 + w * s))) for x, s in zip(c, (1, 0, -1)))


# One material for all (the preview reads the corners' colours; the game uses its own).
MATERIAL = bpy.data.materials.new("Undergrowth")
MATERIAL.use_nodes = True
_bsdf = MATERIAL.node_tree.nodes["Principled BSDF"]
_attr = MATERIAL.node_tree.nodes.new("ShaderNodeVertexColor")
_attr.layer_name = "Col"
MATERIAL.node_tree.links.new(_attr.outputs["Color"], _bsdf.inputs["Base Color"])
_bsdf.inputs["Roughness"].default_value = 0.9
MATERIAL.use_backface_culling = False


class Mesh:
    """Corners with their colours and faces; `obj` makes it a Blender object. `near` or far: a far
    mesh keeps a leaf with chance `keep`, `grow` times as big, and leaves out stalks thinner than
    `thin` m (its own random numbers, so the plant's own stay those of the near one)."""

    def __init__(self, name, near, keep=0.3, grow=1.7, thin=0.008, seed=0):
        self.name = name
        self.near = near
        self.keep = keep
        self.grow = grow
        self.thin = thin
        self.pick = random.Random(seed * 7919 + 13)
        self.verts = []
        self.cols = []
        self.faces = []

    def v(self, p, c):
        self.verts.append((p[0], p[1], p[2]))
        self.cols.append(c)
        return len(self.verts) - 1

    def face(self, ids, toward=None):
        """A face; with `toward`, wound so that its normal points that way (a leaf's upper side)."""
        ids = list(ids)
        if toward is not None:
            a, b, c = (Vector(self.verts[i]) for i in ids[:3])
            if (b - a).cross(c - a).dot(toward) < 0:
                ids.reverse()
        self.faces.append(ids)

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)

    def obj(self):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.verts, [], self.faces)
        me.update()
        attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        for i, c in enumerate(self.cols):
            attr.data[i].color = (*c, 1.0)
        me.color_attributes.active_color = attr
        me.materials.append(MATERIAL)
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def ground(p, lift=0.012):
    """Kept just above the ground: a plant lying down rests on it."""
    return Vector((p.x, p.y, max(p.z, lift)))


def tube(m, pts, radii, sides, col, cap=False, far_sides=3, far_fat=1.3):
    """A tube along `pts` (radius per point), its rings carried along without twisting; `col(p, d, t)`
    the colour at point p facing d, t along the tube (0..1). Wound outwards. Far: `far_sides` sides,
    every other point, `far_fat` times as thick; left out if thinner than the mesh's `thin`."""
    if not m.near:
        if max(radii) < m.thin:
            return None
        keep = list(range(0, len(pts), 2))
        if keep[-1] != len(pts) - 1:
            keep.append(len(pts) - 1)
        pts = [pts[i] for i in keep]
        radii = [radii[i] * far_fat for i in keep]
        sides = far_sides
    n = len(pts)
    t = (pts[1] - pts[0]).normalized()
    ref = UP if abs(t.z) < 0.9 else Vector((1, 0, 0))
    nrm = t.cross(ref).normalized()
    rings = []
    for i, p in enumerate(pts):
        if i > 0:
            tn = (pts[min(i + 1, n - 1)] - pts[i - 1]).normalized()
            nrm = t.rotation_difference(tn) @ nrm
            t = tn
        b = t.cross(nrm)
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            d = nrm * math.cos(a) + b * math.sin(a)
            q = p + d * radii[i]
            ring.append(m.v(q, col(q, d, i / (n - 1))))
        rings.append(ring)
    for i in range(n - 1):
        for k in range(sides):
            k1 = (k + 1) % sides
            m.face((rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]))
    if cap and sides > 2:
        m.face(rings[-1])
    return rings


def leaf(m, base, fwd, side, length, profile, col, tip_col=None, curl=0.0, wave=0.0, fold=0.0, base_id=None):
    """A leaf from `base` along `fwd`, its outline `profile` [(u, half width, lift)] as fractions of
    `length`: a strip of 2 x len(profile) triangles. `curl` bends its tip down, `wave` lifts the left
    side's points and lowers the right's (holly), `fold` lifts both edges. `base_id`: a corner to
    share (a compound leaf's leaflets meet at their stalk). Far: one in `keep` as a bigger diamond."""
    fwd = fwd.normalized()
    side = (side - fwd * side.dot(fwd)).normalized()
    up = side.cross(fwd).normalized()
    tip_col = tip_col or col
    if not m.near:
        if m.pick.random() > m.keep:
            return up
        length *= m.grow
        u, w, _ = max(profile, key=lambda q: q[1])
        profile = [(u, w, 0.0)]
        wave = 0.0
        base_id = None

    def at(u, w, z):
        return base + fwd * (u * length) + side * (w * length) + up * ((z - curl * u * u) * length)

    b = base_id if base_id is not None else m.v(base, col)
    tip = m.v(at(1.0, 0.0, 0.0), tip_col)
    left = [m.v(at(u, w, z + wave * w + fold * w), mix(col, tip_col, u)) for u, w, z in profile]
    right = [m.v(at(u, -w, z - wave * w + fold * w), mix(col, tip_col, u)) for u, w, z in profile]
    m.face((b, left[0], right[0]), up)
    for i in range(len(profile) - 1):
        m.face((left[i], left[i + 1], right[i]), up)
        m.face((right[i], left[i + 1], right[i + 1]), up)
    m.face((left[-1], tip, right[-1]), up)
    return up


def berry(m, centre, r, col, dark):
    """A berry: a small octahedron (near only)."""
    if not m.near:
        return
    ids = [m.v(centre + Vector(d) * r, dark if d[2] < 0 else col)
           for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
    for a, b in ((0, 2), (2, 1), (1, 3), (3, 0)):
        for c in (4, 5):
            tri = (ids[a], ids[b], ids[c])
            mid = sum((Vector(m.verts[i]) for i in tri), Vector()) / 3
            m.face(tri, mid - centre)


def spine(start, heading, parts, rng=None, wobble=0.0):
    """Points along a stalk that climbs and bends in the upright plane through `heading`:
    parts [(length, pitch at start, pitch at end, steps)], pitch in degrees above level."""
    pts = [start.copy()]
    p = start.copy()
    for length, p0, p1, steps in parts:
        for i in range(steps):
            a = math.radians(p0 + (p1 - p0) * (i + 0.5) / steps)
            h = heading
            if rng and wobble:
                h = Matrix.Rotation((rng.random() - 0.5) * wobble, 3, "Z") @ heading
            p = p + (h * math.cos(a) + UP * math.sin(a)) * (length / steps)
            pts.append(p.copy())
    return pts


def at_along(pts, u):
    """The point and direction a fraction `u` along a polyline."""
    lengths = [(pts[i + 1] - pts[i]).length for i in range(len(pts) - 1)]
    goal = u * sum(lengths)
    for i, seg in enumerate(lengths):
        if goal <= seg or i == len(lengths) - 1:
            f = min(1.0, goal / seg) if seg else 0.0
            return pts[i].lerp(pts[i + 1], f), (pts[i + 1] - pts[i]).normalized()
        goal -= seg
    return pts[-1], (pts[-1] - pts[-2]).normalized()


# --------------------------------------------------------------------------------------------- bracken
BRACKEN = {
    # The live ones: yellow-green, the pinnae's ends yellowing; their stalks green-brown.
    "green": dict(leaf=lin("#667a2c"), tip=lin("#9c963e"), turn=lin("#8c6a32"), stalk=lin("#6a6634")),
    # Dead: russet and ginger, paler towards the ends, the stalks dark brown.
    "arch": dict(leaf=lin("#74441f"), tip=lin("#a07448"), turn=lin("#5e3a1e"), stalk=lin("#463020")),
    # Collapsed and wet: darker, duller brown.
    "flat": dict(leaf=lin("#5c381e"), tip=lin("#856044"), turn=lin("#4a2e1c"), stalk=lin("#3a2a1e")),
}


def frond(m, rng, base, heading, look, stipe, blade, pitch, droop, roll, flat=False):
    """One bracken frond: a stalk (`stipe` m) and a triangular blade (`blade` m long), pitch
    [stalk start, stalk end, blade start, blade end] in degrees; `droop` how far the pinnae hang,
    `roll` the blade's tilt about its midrib (radians)."""
    pal = BRACKEN[look]
    s0, s1, b0, b1 = pitch
    stalk = spine(base, heading, [(stipe, s0, s1, 4)])
    mid = spine(stalk[-1], heading, [(blade, b0, b1, 6)])
    if flat:
        stalk = [ground(p, 0.01 + 0.02 * i / len(stalk)) for i, p in enumerate(stalk)]
        mid = [ground(p, 0.03) for p in mid]
    leaf_c = vary(pal["leaf"], rng, 0.12)
    tip_c = vary(pal["tip"], rng, 0.1)
    stalk_c = pal["stalk"]
    side0 = UP.cross(heading).normalized()
    if m.near:
        # The stalk dark at its foot, paler and straw-coloured up towards the blade.
        tube(m, stalk, [0.006 - 0.0015 * i / (len(stalk) - 1) for i in range(len(stalk))], 3,
             lambda p, d, t: scale(mix(stalk_c, mix(stalk_c, tip_c, 0.6), t), 0.8 + 0.3 * t))
        tube(m, mid, [0.0042 - 0.0032 * i / (len(mid) - 1) for i in range(len(mid))], 3,
             lambda p, d, t: scale(mix(stalk_c, leaf_c, 0.4), 0.85 + 0.2 * t))
    else:
        # Far: the stalk a flat strip turned across the frond, the midrib left to the pinnae.
        ids = []
        for i, p in enumerate(stalk[::2] + ([stalk[-1]] if len(stalk) % 2 == 0 else [])):
            ids.append((m.v(p - side0 * 0.009, stalk_c), m.v(p + side0 * 0.009, stalk_c)))
        for i in range(len(ids) - 1):
            m.face((ids[i][0], ids[i][1], ids[i + 1][1], ids[i + 1][0]), heading)
    pairs = 8
    far = {-1: [], 1: []}
    for i in range(pairs):
        u = 0.03 + 0.84 * i / pairs
        a, t = at_along(mid, u)
        # The pinnae: the lowest pair longest (the blade is a triangle), held out wide, nearer the
        # midrib's line towards the tip.
        plen = blade * (0.5 * (1 - u) ** 1.05 + 0.05) * (0.9 + 0.2 * rng.random())
        s = Matrix.Rotation(roll + (rng.random() - 0.5) * 0.2, 3, t) @ side0
        s = (s - t * s.dot(t)).normalized()
        n = t.cross(s).normalized()  # the blade's upper side
        if n.z < 0:
            n = -n
        ang = math.radians(64 - 20 * u)
        # Late in the year a few pinnae on a live frond have turned already.
        turned = look == "green" and rng.random() < 0.22
        for sign in (-1, 1):
            fwd = (t * math.cos(ang) + s * sign * math.sin(ang)).normalized()
            base_c = vary(pal["turn"] if turned else leaf_c, rng, 0.08)
            pin_tip = vary(tip_c, rng, 0.08)
            hang = droop * (0.7 + 0.6 * rng.random())
            sub = random.Random(rng.random())
            if m.near:
                pinna(m, sub, a + s * sign * 0.003, fwd, n, plen, hang, base_c, pin_tip, flat)
            else:
                far[sign].append((a, a + fwd * plen - n * (hang * plen), base_c, pin_tip, n))
    if not m.near:
        # Far: the blade filled from the midrib out to each pinna's drooping end, notched halfway to the next
        # one, so a stand seen from 20 m reads as a russet mass with a ragged edge, not a few slim splinters.
        # A little lighter than the near copy: the light through its leaflets is not there to lift it.
        for side in far.values():
            for i, (a, p_tip, base_c, pin_tip, n) in enumerate(side):
                a2 = side[i + 1][0] if i + 1 < len(side) else at_along(mid, 0.9)[0]
                nxt = side[i + 1][1] if i + 1 < len(side) else a2
                notch = a2.lerp(p_tip.lerp(nxt, 0.5), 0.55)
                pts = [a, p_tip, notch, a2]
                if flat:
                    pts = [ground(p, 0.025) for p in pts]
                ids = [m.v(pts[0], scale(base_c, 0.95)), m.v(pts[1], scale(pin_tip, 1.15)), m.v(pts[2], scale(base_c, 1.1)), m.v(pts[3], scale(base_c, 0.95))]
                m.face((ids[0], ids[1], ids[2]), n)
                m.face((ids[0], ids[2], ids[3]), n)
    # The blade's tip: a last small lobe.
    a, t = at_along(mid, 0.88)
    keep, m.keep = m.keep, 1.0
    leaf(m, a, t, side0, blade * (0.14 if m.near else 0.09), [(0.4, 0.16, 0.0)], leaf_c, tip_c, curl=droop * 0.3)
    m.keep = keep


def pinna(m, rng, base, fwd, n, length, hang, col, tip_col, flat):
    """A pinna, near: its axis drooping by `hang`, its lobes on both sides cut almost to the axis,
    leaning towards its end and narrowing; the dead ones' lobes curl under."""
    lobes = max(2, round(9 * min(1.0, length / 0.26) ** 0.8))
    axis = []
    for j in range(lobes + 1):
        v = j / lobes
        p = base + fwd * (length * v) - n * (hang * length * v * v)
        axis.append(ground(p, 0.02) if flat else p)
    ids = [m.v(p, scale(mix(col, tip_col, j / lobes), 0.75)) for j, p in enumerate(axis)]
    side = n.cross(fwd).normalized()
    curl = 0.12 + 0.4 * hang
    dead = hang > 0.25
    for j in range(lobes):
        v = (j + 0.5) / lobes
        a, b = axis[j], axis[j + 1]
        t = (b - a).normalized()
        nn = t.cross(side).normalized()
        if nn.dot(n) < 0:
            nn = -nn
        l0 = length * 0.2 * (1 - v) ** 0.5 + 0.007
        c0 = mix(col, tip_col, v * 0.8 + 0.2 * rng.random())
        for sign in (-1, 1):
            # Dead lobes shrivel unevenly: shorter or longer, curled more or less, the odd one broken off.
            l = l0 * ((0.6 + 0.65 * rng.random()) if dead else (0.9 + 0.2 * rng.random()))
            cu = curl * ((0.4 + 1.2 * rng.random()) if dead else 1.0)
            c = vary(c0, rng, 0.14 if dead else 0.07)
            ang = math.radians(62 + rng.uniform(-9, 9))
            if dead and rng.random() < 0.07:
                continue
            out = (side * sign * math.sin(ang) + t * math.cos(ang)).normalized()
            o1 = a + out * l - nn * (cu * l)
            o2 = a.lerp(b, 0.72) + out * (l * 0.86) - nn * (cu * l * 1.15)
            if flat:
                o1, o2 = ground(o1, 0.018), ground(o2, 0.018)
            q1 = m.v(o1, c)
            q2 = m.v(o2, scale(c, 1.06))
            m.face((ids[j], q1, q2, ids[j + 1]), nn)


def bracken(look, seed, near):
    rng = random.Random(seed)
    m = Mesh(f"Bracken{look.capitalize()}", near, seed=seed)
    for f in range(3):
        a = 2 * math.pi * (f + rng.random() * 0.6) / 3
        r = 0.05 + 0.18 * rng.random()
        base = Vector((math.cos(a) * r, math.sin(a) * r, 0))
        heading = Vector((math.cos(a + rng.uniform(-0.5, 0.5)), math.sin(a + rng.uniform(-0.5, 0.5)), 0)).normalized()
        k = 0.85 + 0.3 * rng.random()
        roll = rng.uniform(-0.3, 0.3)
        if look == "green":
            # Upright on its stalk (as long as the blade or longer: 1 to 1.5 m in a stand), the blade held out
            # almost level, arching a little at its tip.
            frond(m, rng, base, heading, look, 0.74 * k, 0.62 * k, (86, 68, 16, -22), 0.16, roll)
        elif look == "arch":
            # Dead, the stalk bent over, the blade hanging down towards the ground.
            frond(m, rng, base, heading, look, 0.68 * k, 0.62 * k, (82, 40, 2, -58), 0.45, roll * 1.6)
        else:
            # Collapsed: lying on the floor, the pinnae flattened and crumpled.
            frond(m, rng, base, heading, look, 0.4 * k, 0.62 * k, (30, 6, 0, -4), 0.6, roll, flat=True)
    return m


# --------------------------------------------------------------------------------------------- bramble
BRAMBLE_LEAF = [lin("#2c4320"), lin("#34502a"), lin("#3a5226"), lin("#2a3c1e")]
BRAMBLE_TURNED = [lin("#5a2626"), lin("#4a2434"), lin("#664022"), lin("#53302a")]
BRAMBLE_DEAD = [lin("#5e4a30"), lin("#4e3a26")]  # the odd leaf dead on its cane, dull brown
LEAFLET = [(0.4, 0.3, 0.0)]  # ovate, broadest below the middle, pointed


def bramble(seed, near):
    """A bramble at the end of November: a tangle of purple-red canes arching out and back down to root at their
    tips, thorny, and half bare: the old leaves low on the canes fallen, the rest dark green, many turned red and
    purple, some dead. Far: the same arches, thick enough to stay on screen, and one leaf in five as a bigger
    diamond; no solid heap under it (that read as a flat dark green mound from every distance)."""
    rng = random.Random(seed)
    m = Mesh(f"Bramble{seed}", near, keep=0.2, grow=1.45, thin=0.02, seed=seed)

    def thorns(pts, radius):
        """Prickles along a cane (near only): small hooked triangles every 6 cm, turning round it, pale red."""
        if not m.near:
            return
        length = sum((pts[i + 1] - pts[i]).length for i in range(len(pts) - 1))
        count = int(length / 0.06)
        for k in range(count):
            u = (k + 0.5) / count
            p, t = at_along(pts, u)
            ref = UP if abs(t.z) < 0.9 else Vector((1, 0, 0))
            a = k * 2.4
            out = (t.cross(ref).normalized() * math.cos(a) + t.cross(t.cross(ref)).normalized() * math.sin(a)).normalized()
            r = radius * (1.0 - 0.5 * u)
            base = p + out * (r * 0.8)
            col = lin("#a0605a")
            ids = [m.v(base - t * 0.003, scale(col, 0.8)), m.v(base + t * 0.003, scale(col, 0.8)),
                   m.v(base + out * 0.005 - t * 0.0025, col)]
            m.face(ids, out.cross(t))

    def compound(p, t, sign, size, turned):
        """A leaf of three or five leaflets on a short stalk out to the side and up, turned to the light."""
        side = t.cross(UP)
        side = side.normalized() if side.length > 1e-4 else Vector((1, 0, 0))
        out = (side * sign + UP * 0.5).normalized()
        centre = p + out * 0.045
        five = rng.random() < 0.45
        pick = rng.randrange(4)
        base_c = vary(BRAMBLE_DEAD[pick % 2] if turned == 2 else (BRAMBLE_TURNED if turned else BRAMBLE_LEAF)[pick], rng, 0.1)
        tip_c = scale(base_c, 1.18)
        fan = (side * sign * 0.7 + t * 0.5).normalized()
        fan.z = 0.1 + 0.25 * rng.random()
        fan.normalize()
        fan_side = fan.cross(UP).normalized()
        fan_up = fan_side.cross(fan).normalized()
        jit = [rng.uniform(-8, 8) for _ in range(5)]
        droop = [rng.uniform(-0.12, 0.04) for _ in range(5)]
        if not m.near:
            # Far: the whole leaf one diamond as big as its leaflets together.
            leaf(m, centre, fan, fan_side, 0.2 * size, [(0.45, 0.42, 0.0)], scale(base_c, 0.9), tip_c)
            return
        shared = m.v(centre, scale(base_c, 0.7))
        angles = [0, -58, 58, -110, 110] if five else [0, -62, 62]
        lens = [0.115, 0.095, 0.095, 0.06, 0.06]
        for li, ang in enumerate(angles):
            d = Matrix.Rotation(math.radians(ang + jit[li]), 3, fan_up) @ fan
            d.z += droop[li]
            leaf(m, centre, d, d.cross(UP), lens[li] * size, LEAFLET, scale(base_c, 0.85), tip_c,
                 curl=0.15, fold=0.2, base_id=shared)

    canes = []
    # Long canes arching out and back down to root at their tips, crossing one another; short ones in the middle,
    # the old canes of last year standing stiff and nearly bare.
    for c in range(11):
        a = 2 * math.pi * (c + rng.random() * 0.8) / 11
        canes.append((a, rng.uniform(0.7, 1.25), rng.uniform(0.4, 0.8), True))
    for c in range(5):
        canes.append((rng.random() * 2 * math.pi, rng.uniform(0.15, 0.4), rng.uniform(0.35, 0.65), False))
    for a, reach, height, long in canes:
        h = Vector((math.cos(a), math.sin(a), 0))
        # Each arch swings a little sideways along its length: the canes cross and tangle.
        swing = Vector((-h.y, h.x, 0)) * rng.uniform(-0.25, 0.25)
        start = h * rng.uniform(0.0, 0.12)
        segs = 6
        pts = []
        for i in range(segs + 1):
            s = i / segs
            # Up steeply, over and down: a long cane's end bends back to the ground; a short one stays up.
            z = height * math.sin(math.pi * (s * 0.94 + 0.03 if long else s * 0.55)) ** 0.7
            pts.append(start + h * (reach * s) + swing * (s * s) + Vector((0, 0, z + 0.005)))
        cane_c = vary(lin("#5a3434") if rng.random() < 0.75 else lin("#46522c"), rng, 0.1)
        cane_col = lambda p, d, t, c=cane_c: scale(c, 0.75 + 0.3 * t)  # noqa: E731
        if m.near:
            tube(m, pts, [0.009 - 0.005 * i / segs for i in range(segs + 1)], 3, cane_col)
            thorns(pts, 0.009)
        elif long:
            # Far: the long canes as three-sided arches, thick enough to stay on screen; the longest of three pieces
            # (two read as stiff legs), the others of two.
            m.near = True
            if reach > 0.95:
                tube(m, [pts[0], pts[2], pts[4], pts[6]], [0.02, 0.017, 0.013, 0.009], 3, cane_col)
            else:
                tube(m, [pts[0], pts[3], pts[6]], [0.02, 0.015, 0.009], 3, cane_col)
            m.near = False
        # The leaves: one every 10 cm or so along the cane, alternately to either side. Half bare: low on the cane
        # (the older part) most have fallen, on its outer half more stay.
        length = sum((pts[i + 1] - pts[i]).length for i in range(segs))
        count = max(2, int(length * 0.85 / 0.1))
        turned_cane = rng.random() < 0.4
        for k in range(count):
            u = 0.1 + 0.88 * (k + 0.5) / count
            p, t = at_along(pts, u)
            stays = rng.random() < (0.25 + 0.5 * u if long else 0.3)
            r = rng.random()
            turned = 2 if r < 0.12 else 1 if (turned_cane and r < 0.65) or r < 0.25 else 0
            size = rng.uniform(0.85, 1.15) * (1.0 if long else 0.85)
            if stays:
                compound(p, t, 1 if k % 2 else -1, size, turned)
        if not long:
            continue
        # Side shoots near the top of the arch, their leaves bunched: what is left of the mound's crown.
        for k in range(2):
            p, t = at_along(pts, 0.3 + 0.16 * k)
            sd = (t.cross(UP).normalized() * (1 if k else -1) + UP * 0.8 + t * 0.3).normalized()
            shoot = [p, p + sd * 0.12, p + sd * 0.22 + Vector((0, 0, -0.03))]
            tube(m, shoot, [0.005, 0.004, 0.003], 3, cane_col)
            for j in range(3):
                q, tt = at_along(shoot, 0.35 + 0.3 * j)
                stays = rng.random() < 0.7
                turned = 1 if turned_cane and rng.random() < 0.5 else 0
                size = rng.uniform(0.8, 1.05)
                if stays:
                    compound(q, tt, 1 if j % 2 else -1, size, turned)
    return m


# --------------------------------------------------------------------------------------------- shrubs
HOLLY_LEAF = [lin("#1c3018"), lin("#22381c"), lin("#2a4220"), lin("#1a2c16")]
SPINY = [(0.3, 0.3, 0.07), (0.66, 0.27, -0.06)]
OVAL = [(0.25, 0.32, 0.0), (0.62, 0.32, 0.0)]


def holly(seed, near):
    rng = random.Random(seed)
    m = Mesh("Holly", near, keep=0.17, grow=2.0, thin=0.012, seed=seed)
    bark = lin("#4e5040")
    height = 1.25
    stem = spine(Vector((0, 0, 0)), Vector((1, 0, 0)), [(height, 86, 82, 6)], rng, 0.3)
    tube(m, stem, [0.022 - 0.016 * i / 6 for i in range(7)], 4, lambda p, d, t: scale(bark, 0.8 + 0.3 * t), far_fat=1.0)
    branches = 17
    for b in range(branches):
        u = 0.1 + 0.88 * b / branches
        p, _ = at_along(stem, u)
        a = b * 2.4 + rng.uniform(-0.3, 0.3)
        h = Vector((math.cos(a), math.sin(a), 0))
        # A cone: long branches low down, short ones near the top, all reaching up.
        reach = (0.48 * (1 - u) + 0.1) * rng.uniform(0.85, 1.15)
        pts = spine(p, h, [(reach, 40 + 25 * u, 18 + 30 * u, 4)])
        tube(m, pts, [0.009 - 0.006 * i / 4 for i in range(5)], 3, lambda q, d, t: scale(bark, 0.9))
        # Leaves all round the branch, thickest towards its end, and on two side twigs.
        twigs = [pts]
        for k in range(2):
            q, t = at_along(pts, 0.4 + 0.3 * k)
            d = (t + t.cross(UP).normalized() * (1 if k else -1) * 0.9 + UP * 0.2).normalized()
            tw = [q, q + d * reach * 0.25, q + d * reach * 0.45]
            tube(m, tw, [0.005, 0.004, 0.003], 3, lambda q, dd, t: scale(bark, 0.9))
            twigs.append(tw)
        for tw in twigs:
            tl = sum((tw[i + 1] - tw[i]).length for i in range(len(tw) - 1))
            count = int(tl / 0.03) + 1
            for k in range(count):
                v = 0.12 + 0.88 * k / count
                q, t = at_along(tw, v)
                ang = k * 2.4 + rng.uniform(-0.3, 0.3)
                side = t.cross(UP).normalized()
                out = (side * math.cos(ang) + UP * math.sin(ang) * 0.6 + t * 0.5).normalized()
                col = vary(HOLLY_LEAF[rng.randrange(4)], rng, 0.12)
                ln = rng.uniform(0.065, 0.09)
                leaf(m, q, out, out.cross(UP + Vector((0.01, 0, 0))), ln, SPINY, col, scale(col, 1.3), curl=0.05, wave=0.3)
        # Now and then a few berries, close against the branch.
        if rng.random() < 0.4:
            q, _ = at_along(pts, rng.uniform(0.4, 0.8))
            for _ in range(rng.randint(2, 4)):
                c = q + Vector((rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.0)))
                berry(m, c, 0.0055, lin("#a8141a"), lin("#6a0c10"))
    return m


def hazel(seed, near):
    rng = random.Random(seed)
    m = Mesh("Hazel", near, keep=0.5, grow=1.4, thin=0.007, seed=seed)
    bark = lin("#564a3e")
    young = lin("#664c36")
    yellow = [lin("#b39a3a"), lin("#c2a446"), lin("#a88a34"), lin("#8c6a2e")]
    for s in range(7):
        a = 2 * math.pi * (s + rng.random() * 0.5) / 7
        h = Vector((math.cos(a), math.sin(a), 0))
        tall = rng.uniform(1.0, 1.55)
        lean = rng.uniform(56, 78)
        base = h * rng.uniform(0.02, 0.07)
        pts = spine(base, h, [(tall, lean, lean - 16, 4)], rng, 0.15)
        tube(m, pts, [0.018 - 0.013 * i / 4 for i in range(5)], 4, lambda p, d, t: mix(bark, young, t * 0.7), far_fat=1.5)
        # Side twigs on the upper half, zigzagging out, with twiglets of their own.
        for k in range(rng.randint(4, 6)):
            u = rng.uniform(0.35, 0.95)
            p, t = at_along(pts, u)
            out = Matrix.Rotation(rng.uniform(0, 6.28), 3, t) @ t.cross(UP).normalized()
            d = (t * 0.55 + out * 0.8).normalized()
            zig = Matrix.Rotation(rng.uniform(0.2, 0.4) * (1 if k % 2 else -1), 3, out) @ d
            tl = rng.uniform(0.25, 0.45)
            twig = [p, p + d * tl * 0.5, p + d * tl * 0.5 + zig * tl * 0.5]
            tube(m, twig, [0.0045, 0.0032, 0.0018], 3, lambda q, dd, tt: young)
            q, tt = at_along(twig, 0.6)
            sd = (tt + out * rng.uniform(-0.8, 0.8) + UP * 0.3).normalized()
            tube(m, [q, q + sd * 0.07, q + sd * 0.13], [0.0025, 0.002, 0.0012], 3, lambda q, dd, tt: young)
            # Catkins already formed for the spring, hanging in pairs.
            if rng.random() < 0.45:
                for c in range(2):
                    top = twig[-1] + Vector((0.01 * c, 0, 0))
                    tube(m, [top, top + Vector((0.004, 0, -0.012)), top + Vector((0.006, 0, -0.026))],
                         [0.003, 0.004, 0.003], 3, lambda q, dd, tt: lin("#8a8050"))
            # The last yellow leaves, round with a point.
            if rng.random() < 0.6:
                col = vary(yellow[rng.randrange(4)], rng, 0.12)
                leaf(m, twig[-1], (d + Vector((0, 0, -0.35))).normalized(), d.cross(UP), rng.uniform(0.08, 0.11), OVAL,
                     col, scale(col, 1.1), curl=0.2, fold=0.15)
    return m


def beech(seed, near):
    rng = random.Random(seed)
    m = Mesh("Beech", near, keep=0.22, grow=1.9, thin=0.01, seed=seed)
    bark = lin("#64625a")
    twig_c = lin("#6a5040")
    leaves = [lin("#8a4a22"), lin("#9c5a28"), lin("#7a421e"), lin("#a8743e"), lin("#8e5a2c")]
    height = 1.35
    stem = spine(Vector((0, 0, 0)), Vector((1, 0, 0)), [(height, 87, 80, 6)], rng, 0.35)
    tube(m, stem, [0.016 - 0.011 * i / 6 for i in range(7)], 4, lambda p, d, t: scale(bark, 0.85 + 0.2 * t), far_fat=1.2)
    # Branches in tiers, held out nearly level, each a flat spray of twigs and leaves in two rows.
    tiers = 6
    for b in range(tiers * 2):
        u = 0.28 + 0.7 * (b // 2) / tiers + rng.uniform(-0.03, 0.03)
        p, _ = at_along(stem, u)
        a = (b // 2) * 1.9 + (b % 2) * math.pi + rng.uniform(-0.4, 0.4)
        h = Vector((math.cos(a), math.sin(a), 0))
        reach = (0.45 * (1 - u) + 0.16) * rng.uniform(0.85, 1.2)
        pts = spine(p, h, [(reach, 22, 2, 3)], rng, 0.4)
        spray_up = (UP + h * 0.2).normalized()
        tube(m, pts, [0.006, 0.0045, 0.003, 0.002], 3, lambda q, d, t: twig_c)
        twigs = [pts]
        for k in range(2):
            q, t = at_along(pts, 0.35 + 0.3 * k)
            side = t.cross(spray_up).normalized() * (1 if k % 2 else -1)
            d = (t * 0.7 + side * 0.7).normalized()
            tw = [q, q + d * reach * 0.22, q + d * reach * 0.4]
            tube(m, tw, [0.003, 0.0022, 0.0015], 3, lambda q, dd, t: twig_c)
            twigs.append(tw)
        for tw in twigs:
            tl = sum((tw[i + 1] - tw[i]).length for i in range(len(tw) - 1))
            count = int(tl / 0.04) + 2
            for k in range(count):
                v = 0.12 + 0.88 * k / count
                q, t = at_along(tw, v)
                sign = 1 if k % 2 else -1
                side = t.cross(spray_up).normalized()
                d = (side * sign + t * 0.8).normalized()
                d.z += rng.uniform(-0.15, 0.1)
                col = vary(leaves[rng.randrange(5)], rng, 0.1)
                # Dry leaves curl and twist a little.
                leaf(m, q, d, d.cross(spray_up), rng.uniform(0.065, 0.09), OVAL, scale(col, 0.85), scale(col, 1.1),
                     curl=rng.uniform(0.1, 0.35), fold=rng.uniform(0.1, 0.35))
    return m


# --------------------------------------------------------------------------------------------- fallen wood
BARK = lin("#56483c")
BARK_GREY = lin("#6a6256")
MOSS = lin("#4a6624")
WOOD_END = lin("#a08060")


def mossy(rng, base, amount):
    """Bark coloured by its place: lichen-grey streaks, and moss in patches on the upper side."""
    phase = rng.uniform(0, 6.28)

    def col(p, d, t):
        n = 0.5 + 0.5 * math.sin(p.x * 9 + phase) * math.sin(p.y * 7 - phase)
        c = mix(base, BARK_GREY, 0.35 * n)
        patch = max(0.0, n - 0.45) / 0.55
        if d.z > 0.3:
            c = mix(c, MOSS, min(0.9, amount * patch * d.z))
        return scale(c, 0.72 + 0.28 * max(0.0, d.z) + 0.1 * n)

    return col


def branch(seed, near):
    rng = random.Random(seed)
    m = Mesh("Branch", near, thin=0.012, seed=seed)
    length = 1.9
    segs = 8
    pts = []
    for i in range(segs + 1):
        s = i / segs - 0.5
        pts.append(Vector((s * length, 0.08 * math.sin(s * 4 + 1), 0)))
    radii = [0.055 - 0.03 * i / segs for i in range(segs + 1)]
    for i, p in enumerate(pts):
        p.z = radii[i] * 0.85
    col = mossy(rng, BARK, 0.8)
    tube(m, pts, radii, 6, col, cap=True, far_sides=4, far_fat=1.0)
    # Side branches: some along the ground, some sticking up into the air as a fallen branch's do.
    for b in range(5):
        u = 0.25 + 0.6 * b / 5 + rng.uniform(-0.04, 0.04)
        p, t = at_along(pts, u)
        side = Vector((0, 1 if b % 2 else -1, 0))
        up = rng.uniform(0.0, 0.9) if b % 3 else 0.0
        d = (t * 0.7 + side * 0.7 + UP * up).normalized()
        r0 = 0.024 * (1 - u * 0.5)
        lb = rng.uniform(0.35, 0.65)
        side_pts = [p, p + d * lb * 0.5, p + d * lb + Vector((0, 0, -0.04 if up < 0.3 else 0.02))]
        for q in side_pts:
            q.z = max(q.z, r0 * 0.8)
        tube(m, side_pts, [r0, r0 * 0.7, r0 * 0.35], 5, col, far_fat=1.0)
        for k in range(2):
            q, tt = at_along(side_pts, 0.5 + 0.35 * k)
            dd = (tt + Vector((rng.uniform(-0.8, 0.8), rng.uniform(-0.8, 0.8), rng.uniform(0.0, 0.6)))).normalized()
            tube(m, [q, q + dd * 0.12, q + dd * 0.22], [0.006, 0.004, 0.002], 3, col)
    return m


def log(seed, near):
    rng = random.Random(seed)
    m = Mesh("Log", near, seed=seed)
    length, r = 1.3, 0.16
    sides = 10 if near else 6
    segs = 5 if near else 1
    pts = [Vector((-length / 2 + length * i / segs, 0, r * 0.88)) for i in range(segs + 1)]
    radii = [r * (1 + 0.04 * math.sin(i * 2.1)) for i in range(segs + 1)]
    near_flag, m.near = m.near, True  # the log's own sides and segments above
    rings = tube(m, pts, radii, sides, mossy(rng, BARK, 1.0))
    m.near = near_flag
    # The cut ends: pale wood with its rings, a little weathered.
    for end, ring in ((0, rings[0]), (1, rings[-1])):
        centre = pts[-1 if end else 0]
        out = Vector((1 if end else -1, 0, 0))
        circles = [0.66, 0.33] if near else []
        ids_prev = [m.v(m.verts[i], scale(BARK, 0.8)) for i in ring]
        for k, f in enumerate(circles):
            shade = 0.95 if k % 2 == 0 else 0.78
            ids = [m.v(centre + (Vector(m.verts[i]) - centre) * f + out * 0.003, scale(WOOD_END, shade)) for i in ring]
            for i in range(sides):
                m.face((ids_prev[i], ids_prev[(i + 1) % sides], ids[(i + 1) % sides], ids[i]), out)
            ids_prev = ids
        c = m.v(centre + out * 0.005, scale(WOOD_END, 0.7))
        for i in range(sides):
            m.face((ids_prev[i], ids_prev[(i + 1) % sides], c), out)
    return m


def stump(seed, near):
    rng = random.Random(seed)
    m = Mesh("Stump", near, seed=seed)
    sides = 12 if near else 6
    height = 0.38
    rows = [(-0.05, 1.55), (0.04, 1.3), (0.14, 1.05), (height, 1.0)] if near else [(-0.05, 1.45), (height, 1.0)]
    r = 0.2
    col = mossy(rng, BARK, 0.9)
    rings = []
    for z, f in rows:
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            # The roots' flare in five lobes, strongest at the foot.
            lobe = 1 + (f - 1) * (0.55 + 0.45 * math.cos(5 * a + 0.7))
            p = Vector((math.cos(a) * r * lobe, math.sin(a) * r * lobe, z))
            ring.append(m.v(p, col(p, Vector((math.cos(a), math.sin(a), 0.6 if z < 0.1 else 0.1)), 0)))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(sides):
            k1 = (k + 1) % sides
            m.face((rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]))
    # The top: sawn long ago, grey at the rim, darker and rotting in the middle.
    top = [m.v(m.verts[i], scale(BARK_GREY, 0.75)) for i in rings[-1]]
    inner = [m.v(Vector(m.verts[i]) * Vector((0.8, 0.8, 1)) + Vector((0, 0, -0.005)), lin("#8a7058")) for i in rings[-1]]
    centre = m.v(Vector((0.01, 0, height - 0.03)), lin("#4a3a2c"))
    for k in range(sides):
        k1 = (k + 1) % sides
        m.face((top[k], top[k1], inner[k1], inner[k]), UP)
        m.face((inner[k], inner[k1], centre), UP)
    return m


# --------------------------------------------------------------------------------------------- all of them
BUILD = [
    ("BrackenGreen", lambda near: bracken("green", 11, near)),
    ("BrackenArch", lambda near: bracken("arch", 23, near)),
    ("BrackenFlat", lambda near: bracken("flat", 37, near)),
    ("Bramble1", lambda near: bramble(1, near)),
    ("Bramble2", lambda near: bramble(2, near)),
    ("Holly", lambda near: holly(5, near)),
    ("Hazel", lambda near: hazel(6, near)),
    ("Beech", lambda near: beech(7, near)),
    ("Branch", lambda near: branch(8, near)),
    ("Log", lambda near: log(9, near)),
    ("Stump", lambda near: stump(10, near)),
]

objs = []
for name, build in BUILD:
    for near in (True, False):
        mesh = build(near)
        mesh.name = name + ("" if near else "Far")
        ob = mesh.obj()
        objs.append(ob)
        print(f"undergrowth: {ob.name} {mesh.tris()} triangles, {len(mesh.verts)} corners")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
                          export_texcoords=False, export_normals=False, export_materials="NONE",
                          export_cameras=False, export_lights=False,
                          export_vertex_color="ACTIVE", export_all_vertex_colors=False)


def byte_colours(path):
    """The exporter writes the corners' colours as four 16-bit numbers; a byte each is plenty for a
    leaf's colour and saves a fifth of the file. Rewrites the GLB with each COLOR_0 as normalised bytes
    (glTF allows it), every other block as it was."""
    data = open(path, "rb").read()
    jlen = struct.unpack_from("<I", data, 12)[0]
    j = json.loads(data[20:20 + jlen])
    blen = struct.unpack_from("<I", data, 20 + jlen)[0]
    blob = data[28 + jlen:28 + jlen + blen]
    colours = {p["attributes"]["COLOR_0"] for me in j["meshes"] for p in me["primitives"] if "COLOR_0" in p["attributes"]}
    used = [a["bufferView"] for a in j["accessors"]]
    assert len(used) == len(set(used)) and not any("byteStride" in v for v in j["bufferViews"]), "one block per accessor"
    out = bytearray()
    for i, acc in enumerate(j["accessors"]):
        view = j["bufferViews"][acc["bufferView"]]
        raw = blob[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]]
        if i in colours:
            assert acc["componentType"] == 5123 and acc["type"] == "VEC4"
            values = struct.unpack(f"<{len(raw) // 2}H", raw)
            raw = bytes(min(255, (v * 255 + 32767) // 65535) for v in values)
            acc["componentType"] = 5121
            acc["normalized"] = True
            acc.pop("byteOffset", None)
        view["byteOffset"] = len(out)
        view["byteLength"] = len(raw)
        out += raw
        out += b"\0" * (-len(out) % 4)
    j["buffers"][0]["byteLength"] = len(out)
    text = json.dumps(j, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(out)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(text), 0x4E4F534A) + text)
        f.write(struct.pack("<II", len(out), 0x004E4942) + bytes(out))


byte_colours(OUT)
print(f"undergrowth: {os.path.getsize(OUT)} bytes")

# ---------------------------------------------------------------- previews: each kind, near in front, far behind
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 960, 480
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.7, 0.75, 0.82, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    floor = bpy.data.materials.new("Floor")
    floor.use_nodes = True
    floor.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*lin("#4a3a2a"), 1)
    bpy.context.active_object.data.materials.append(floor)
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 5))
    sun = bpy.context.active_object
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    cam.data.lens = 35
    os.makedirs(PREVIEW, exist_ok=True)
    groups = {
        "bracken": ["BrackenGreen", "BrackenArch", "BrackenFlat"],
        "bramble": ["Bramble1", "Bramble2"],
        "shrubs": ["Holly", "Hazel", "Beech"],
        "wood": ["Branch", "Log", "Stump"],
        "bracken_close": ["BrackenGreen", "BrackenArch"],
    }
    for label, names in groups.items():
        for o in objs:
            o.hide_render = True
        spacing = 2.8 if label in ("bramble", "wood") else 1.9
        for i, n in enumerate(names):
            for far, row in ((False, 0.0), (True, 2.6)):
                o = bpy.data.objects[n + ("Far" if far else "")]
                o.hide_render = label == "bracken_close" and far
                o.location = (i * spacing, row, 0)
        mid = (len(names) - 1) * spacing / 2
        if label == "bracken_close":
            cam.location = (0.3, -1.3, 1.5)
            target = Vector((0.4, 0.0, 0.2))
        else:
            cam.location = (mid + 1.0, -4.6, 2.4)
            target = Vector((mid, 1.0, 0.35))
        cam.rotation_euler = (target - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
