"""Build sanitary fittings in Blender: a bath, bowl basins and their mixers, pill mirrors, a shower set, two vanities and a
recessed downlight.

Run (Blender 5, no window):
  blender -b --disable-autoexec -P tools/fittings.py -- <out.glb> [preview_dir]

Our own models of common fittings at common catalogue sizes, without brands or logos:

- Bath: a back-to-wall bath, 180 x 80 cm and 58 cm high, square at the end that goes against a side wall (on the left,
  seen from the front) and round at the free end. A soft rounded rim about 4 cm wide round an oval basin that curves
  down into a flat bottom.
- BathMixer: a wall-mounted bath set in brushed gold: a spout, two round controls and a hand shower standing in its
  holder, its hose hanging in a loop. Its origin is on the wall at the height of the controls, at the spout; the
  controls and the hand shower follow to the right (12, 24 and 38 cm).
- ShowerSet: the same hand shower and holder, with three round controls to its right (24, 36 and 48 cm), a longer hose.
- RainShower: a round head 30 cm across on an arm from the wall (its centre 36 cm out); origin at the arm's foot.
- BowlBasin (light grey-beige stone look) and BowlBasinWhite (white ceramic): a round bowl to stand on a top, 40 cm
  across and 14 cm high, with a thin lip; origin at its foot.
- BasinMixer: a tall single-lever mixer for a bowl basin, 27 cm high, its spout reaching 15 cm; origin at its foot.
- PillMirror (60 x 120 cm) and PillMirrorSmall (45 x 90 cm): frameless mirrors with round ends, 1 cm off the wall, with
  a thin polished edge; origin on the wall at the bottom.
- DoubleVanity: a floor-standing vanity in walnut with vertical grain, 180 x 54 cm and 86 cm high, five doors with
  shadow gaps over a recessed plinth, a pale stone top 3 cm thick.
- DrawerVanity: a wall-hung vanity in pale pink lacquer, 90 x 55 cm, two drawers with a grip channel above each, a
  white top 2 cm thick at 85 cm; origin on the floor at the wall.
- Downlight: a recessed round downlight, a white trim 11 cm across round a glowing disc (one material: the glow comes
  from a two-colour emissive texture, so each light is one draw call); origin on the ceiling.

Every piece's origin is at the GLB's origin, its back against the wall at z = 0 and reaching out along +z (Blender -Y),
up along +y; the game picks a piece by its name (web/src/world/props.ts, `part`). Materials match the game's: the gold
is the tint of the house's brass. With preview_dir it also renders the pieces in a row and two close-ups there.
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, rough=0.5, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(color), 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True  # exported single-sided
    return m


def image(name, pixels, closest=False):
    """A packed image from an (h, w, 3) array of sRGB values 0..1 (row 0 at the bottom, as Blender stores it)."""
    h, w, _ = pixels.shape
    img = bpy.data.images.new(name, w, h)
    rgba = np.concatenate([pixels, np.ones((h, w, 1))], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def textured(name, img, rough, emit=None, closest=False):
    """A material whose colour (or, with emit, glow) comes from an image."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nodes = m.node_tree.nodes
    p = nodes["Principled BSDF"]
    t = nodes.new("ShaderNodeTexImage")
    t.image = img
    uvmap = nodes.new("ShaderNodeUVMap")  # named, so the exporter finds the UV set (texCoord 0)
    uvmap.uv_map = "UVMap"
    m.node_tree.links.new(uvmap.outputs["UV"], t.inputs["Vector"])
    if closest:
        t.interpolation = "Closest"
    p.inputs["Roughness"].default_value = rough
    if emit is None:
        m.node_tree.links.new(t.outputs["Color"], p.inputs["Base Color"])
    else:
        p.inputs["Base Color"].default_value = (*srgb("#f2f1ee"), 1)
        m.node_tree.links.new(t.outputs["Color"], p.inputs["Emission Color"])
        p.inputs["Emission Strength"].default_value = emit
    m.use_backface_culling = True
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def modify(obj, kind, **props):
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)
    return obj


def from_bmesh(name, bm, mats, recalc=True):
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats if isinstance(mats, (list, tuple)) else [mats]:
        me.materials.append(m)
    return link(bpy.data.objects.new(name, me))


def join(name, parts, sharp=40):
    """One object of these parts, smooth where the faces meet at less than `sharp` degrees."""
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    obj = parts[0]
    obj.name = obj.data.name = name
    obj.data.set_sharp_from_angle(angle=math.radians(sharp))
    obj.select_set(False)
    return obj


def box(name, x0, x1, y0, y1, z0, z1, mat, bevel=0.0, uv=None):
    """A box; uv=(tile_u, tile_v, offset_u, offset_v) projects UVs per face in metres (u along the face, v up)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(((x0 + x1) / 2 + v.co.x * (x1 - x0), (y0 + y1) / 2 + v.co.y * (y1 - y0), (z0 + z1) / 2 + v.co.z * (z1 - z0)))
    if uv:
        tu, tv, ou, ov = uv
        layer = bm.loops.layers.uv.new("UVMap")
        bm.normal_update()
        for f in bm.faces:
            n = f.normal
            for lp in f.loops:
                c = lp.vert.co
                if abs(n.z) > 0.5:
                    a, b = c.x, c.y
                elif abs(n.x) > 0.5:
                    a, b = c.y, c.z
                else:
                    a, b = c.x, c.z
                lp[layer].uv = (a / tu + ou, b / tv + ov)
    obj = from_bmesh(name, bm, mat)
    if bevel:
        modify(obj, "BEVEL", width=bevel, segments=2, limit_method="ANGLE", angle_limit=math.radians(40))
    return obj


def revolve(name, profile, mat, seg=48, at=(0.0, 0.0, 0.0)):
    """Turn a (r, z) profile round the vertical axis; a point with r = 0 becomes a pole."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        if r < 1e-6:
            rings.append([bm.verts.new((at[0], at[1], at[2] + z))])
        else:
            rings.append([bm.verts.new((at[0] + r * math.cos(2 * math.pi * k / seg), at[1] + r * math.sin(2 * math.pi * k / seg), at[2] + z))
                          for k in range(seg)])
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        for k in range(seg):
            if len(a) == 1:
                bm.faces.new((a[0], b[k], b[(k + 1) % seg]))
            elif len(b) == 1:
                bm.faces.new((a[k], a[(k + 1) % seg], b[0]))
            else:
                bm.faces.new((a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]))
    return from_bmesh(name, bm, mat)


def bend(points, radius, steps=6):
    """A polyline through the points with each inner corner rounded by an arc of this radius."""
    out = [Vector(points[0])]
    for i in range(1, len(points) - 1):
        p0, p1, p2 = Vector(points[i - 1]), Vector(points[i]), Vector(points[i + 1])
        d0, d1 = (p1 - p0).normalized(), (p2 - p1).normalized()
        ang = d0.angle(d1)
        if ang < 1e-3:
            out.append(p1)
            continue
        cut = radius * math.tan(ang / 2)
        a, b = p1 - d0 * cut, p1 + d1 * cut
        for k in range(steps + 1):
            t = k / steps
            # A quadratic curve through the corner: close enough to an arc for these small bends.
            out.append(a * (1 - t) ** 2 + p1 * 2 * t * (1 - t) + b * t * t)
    out.append(Vector(points[-1]))
    return out


def tube(name, path, r, mat, sides=12, caps=True):
    """A round tube along a polyline, with flat caps."""
    path = [Vector(p) for p in path]
    bm = bmesh.new()
    rings = []
    t0 = (path[1] - path[0]).normalized()
    ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    n = t0.cross(ref).normalized()
    for i, p in enumerate(path):
        if i == 0:
            t = t0
        elif i == len(path) - 1:
            t = (path[i] - path[i - 1]).normalized()
        else:
            t = ((path[i] - path[i - 1]).normalized() + (path[i + 1] - path[i]).normalized()).normalized()
        n = (n - t * n.dot(t)).normalized()  # carried along the path (no twist)
        bmv = t.cross(n)
        rings.append([bm.verts.new(p + (n * math.cos(2 * math.pi * k / sides) + bmv * math.sin(2 * math.pi * k / sides)) * r)
                      for k in range(sides)])
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    if caps:
        bm.faces.new(rings[0])
        bm.faces.new(rings[-1])
    return from_bmesh(name, bm, mat)


def disc_y(name, x, z, r, y0, y1, mat, seg=24, bevel=0.0):
    """A short cylinder on an axis out from the wall (Blender Y), from y0 to y1."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=seg, radius=r, depth=abs(y1 - y0), location=(x, (y0 + y1) / 2, z),
                                        rotation=(math.pi / 2, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    if bevel:
        modify(obj, "BEVEL", width=bevel, segments=2, limit_method="ANGLE", angle_limit=math.radians(40))
    return obj


def ray_hit(poly, c, ang):
    """Distance from c along the angle to where it leaves the closed outline poly (star-shaped round c)."""
    d = (math.cos(ang), math.sin(ang))
    best = 1e9
    for (ax, ay), (bx, by) in zip(poly, poly[1:] + poly[:1]):
        ex, ey = bx - ax, by - ay
        den = d[0] * ey - d[1] * ex
        if abs(den) < 1e-12:
            continue
        t = ((ax - c[0]) * ey - (ay - c[1]) * ex) / den
        s = ((ax - c[0]) * d[1] - (ay - c[1]) * d[0]) / den
        if t > 0 and -1e-9 <= s <= 1 + 1e-9:
            best = min(best, t)
    return best


def arc(cx, cy, r, a0, a1, n):
    return [(cx + r * math.cos(a0 + (a1 - a0) * k / n), cy + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]


def capsule(cx, cy, half, r, n=16):
    """Outline of an oval with straight sides: its ends' centres `half - r` either side of (cx, cy)."""
    a = half - r
    return arc(cx + a, cy, r, -math.pi / 2, math.pi / 2, n)[:-1] + arc(cx - a, cy, r, math.pi / 2, 3 * math.pi / 2, n)[:-1]


bpy.ops.wm.read_factory_settings(use_empty=True)

# Brushed gold: not wholly metal, so it keeps its colour in a room, where little bright is round it to mirror.
GOLD = material("BrushedGold", "#cfa862", 0.32, 0.75)
WHITE = material("BathWhite", "#f3f2ee", 0.12)
STONE_BOWL = material("StoneBowl", "#d5cec3", 0.45)
WHITE_BOWL = material("WhiteBowl", "#f4f3ef", 0.15)
# The glass of the mirrors: the game draws a room in it by its name (web/src/world/mirrorLook.ts); this is its look
# without that, a pale, glossy grey.
MIRROR = material("Mirror", "#e4e7e7", 0.12, 0.0)
EDGE = material("MirrorEdge", "#8f9496", 0.35, 0.6)
STONE_TOP = material("StoneTop", "#e6e1d8", 0.4)
GAP = material("ShadowGap", "#2b241f", 0.9)
PINK = material("PinkLacquer", "#dfc3b6", 0.5)
PINK_SHADE = material("PinkShade", "#b99e93", 0.6)
WHITE_TOP = material("WhiteTop", "#f2f1ed", 0.3)


def walnut_pixels(w=256, h=512, seed=7):
    """Walnut veneer with a vertical grain, 0.5 m wide and 1 m tall a tile: dark and light streaks that waver a little."""
    rng = np.random.default_rng(seed)

    def noise1d(n, cell):
        k = n // cell
        v = rng.random(k)
        t = np.arange(n) / cell
        i = np.floor(t).astype(int)
        f = t - i
        f = f * f * (3 - 2 * f)
        return v[i % k] * (1 - f) + v[(i + 1) % k] * f

    fine = 4 * w
    streak = 0.35 * noise1d(fine, 4 * 32) + 0.4 * noise1d(fine, 4 * 8) + 0.25 * noise1d(fine, 4 * 2)
    y = np.arange(h)[:, None]
    x = np.arange(w)[None, :]
    warp = 1.4 * np.sin(2 * np.pi * (y / h) * 2 + 0.7) + 0.8 * np.sin(2 * np.pi * (y / h) * 5 + x / w * 6.0)
    xi = ((x + warp) * 4).astype(int) % fine
    lo, hi = np.percentile(streak, 4), np.percentile(streak, 96)
    f = 0.15 + 0.7 * np.clip((streak[xi] - lo) / (hi - lo), 0, 1) ** 1.2
    # Fine dark lines of the grain, a few pixels apart, here and there stronger.
    lines = noise1d(fine, 4 * 1)
    f = f * (0.85 + 0.15 * np.clip((lines[xi] - 0.2) / 0.6, 0, 1))
    dark, light = np.array(srgb("#4a2f20")) ** (1 / 2.2), np.array(srgb("#9c7453")) ** (1 / 2.2)
    col = dark + (light - dark) * f[..., None]
    grain = 0.95 + 0.06 * rng.random((h, w))[..., None]
    return np.clip(col * grain, 0, 1)


WALNUT = textured("Walnut", image("WalnutVeneer", walnut_pixels()), 0.55)
glow = np.zeros((4, 8, 3))  # left half dark (the trim), right half the lamps' warm white (the lens)
glow[:, 4:] = np.array(srgb("#fff3e0")) ** (1 / 2.2)
LAMP = textured("Downlight", image("DownlightGlow", glow), 0.4, emit=3.0, closest=True)

pieces = []

# ---------------------------------------------------------------- Bath
L, W_, H = 1.80, 0.80, 0.58
# In plan: the back along the wall (y = 0), the square end at -x, the free end's front corner rounded off.
outer = [(-L / 2, 0.0), (-L / 2, -W_)] + arc(L / 2 - 0.40, -0.40, 0.40, -math.pi / 2, 0, 12) + [(L / 2, 0.0)]
C = (0.0, -0.40)
inner = capsule(0.0, -0.40, 0.86, 0.36, 20)
N = 96
angles = [2 * math.pi * k / N for k in range(N)]
t_out = [ray_hit(outer, C, a) for a in angles]
t_in = [ray_hit(inner, C, a) for a in angles]
bm = bmesh.new()


def ring(ts, z, dt=0.0):
    return [bm.verts.new((C[0] + (t + dt) * math.cos(a), C[1] + (t + dt) * math.sin(a), z)) for t, a in zip(ts, angles)]


rings = [ring(t_out, 0.0), ring(t_out, H - 0.016), ring(t_out, H - 0.004, -0.005), ring(t_out, H, -0.014),
         ring(t_in, H, 0.012), ring(t_in, H - 0.004, 0.004), ring(t_in, H - 0.014)]
DEEP, REACH = 0.40, 0.22  # the basin: its depth under the rim's inner edge, and how far its walls come in at the bottom
inner_tilted = []
for k in range(1, 9):
    th = (math.pi / 2) * k / 8
    d = REACH * (1 - math.cos(th))
    z = H - 0.014 - DEEP * math.sin(th)
    # The ends come in a little more than the sides: an oval basin, deeper towards the middle.
    rings.append([bm.verts.new((C[0] + (t - d * (1.25 if abs(math.cos(a)) > 0.7 else 1.0)) * math.cos(a),
                                C[1] + (t - d * (1.25 if abs(math.cos(a)) > 0.7 else 1.0)) * math.sin(a), z))
                  for t, a in zip(t_in, angles)])
bottom_z = H - 0.014 - DEEP
for a, b in zip(rings, rings[1:]):
    for k in range(N):
        bm.faces.new((a[k], a[(k + 1) % N], b[(k + 1) % N], b[k]))
pole_low = bm.verts.new((C[0], C[1], 0.0))
pole_basin = bm.verts.new((C[0], C[1], bottom_z))
for k in range(N):
    bm.faces.new((rings[0][(k + 1) % N], rings[0][k], pole_low))
    bm.faces.new((rings[-1][k], rings[-1][(k + 1) % N], pole_basin))
bath = from_bmesh("Bath", bm, WHITE)
# The waste in the basin's bottom, towards the square end (where the taps are not).
waste = revolve("Waste", [(0.0, 0.003), (0.034, 0.003), (0.036, 0.0015), (0.036, 0.0)], GOLD, 24, (-0.55, -0.40, bottom_z))
pieces.append(join("Bath", [bath, waste], 60))


# ---------------------------------------------------------------- Taps and showers (brushed gold)
def rosette(x, z, r=0.032, depth=0.008):
    return disc_y("Rosette", x, z, r, 0.0, -depth, GOLD, 24, 0.0025)


def control(x, z):
    knob = disc_y("Knob", x, z, 0.019, -0.008, -0.050, GOLD, 20, 0.003)
    return [rosette(x, z), knob]


def hand_shower(x, hose_drop):
    """A hand shower standing in its holder at (x, 0), the hose hanging from its foot in a loop to an outlet beside it."""
    parts = [rosette(x, 0.0, 0.028), tube("Stub", [(x, 0.0, 0.0), (x, -0.045, 0.0)], 0.011, GOLD, 16),
             revolve("Holder", [(0.0, -0.022), (0.016, -0.022), (0.016, 0.024), (0.0, 0.024)], GOLD, 20, (x, -0.058, 0.0)),
             revolve("Handset", [(0.0, -0.075), (0.010, -0.075), (0.012, -0.065), (0.012, 0.14), (0.0155, 0.16),
                                 (0.0155, 0.205), (0.013, 0.21), (0.0, 0.21)], GOLD, 20, (x, -0.058, 0.0))]
    ox = x + 0.065
    parts.append(rosette(ox, -0.05, 0.022, 0.006))
    path = bend([(x, -0.058, -0.075), (x, -0.058, -hose_drop), (ox, -0.05, -hose_drop), (ox, -0.05, -0.08), (ox, -0.004, -0.05)], 0.03, 6)
    parts.append(tube("Hose", path, 0.0065, GOLD, 8, caps=False))
    return parts


def spout(x, z, reach):
    return [rosette(x, z), tube("Spout", bend([(x, 0.0, z), (x, -reach, z), (x, -reach, z - 0.07)], 0.035, 8), 0.011, GOLD, 16)]


parts = spout(0.0, 0.0, 0.19) + control(0.12, 0.0) + control(0.24, 0.0) + hand_shower(0.38, 0.17)
pieces.append(join("BathMixer", parts))
parts = hand_shower(0.0, 0.42) + control(0.24, 0.0) + control(0.36, 0.0) + control(0.48, 0.0)
pieces.append(join("ShowerSet", parts))
head = revolve("Head", [(0.0, -0.040), (0.140, -0.040), (0.148, -0.042), (0.150, -0.047), (0.148, -0.051), (0.140, -0.053), (0.0, -0.053)],
               GOLD, 48, (0.0, -0.36, 0.0))
arm = tube("Arm", bend([(0.0, 0.0, 0.0), (0.0, -0.36, 0.0), (0.0, -0.36, -0.042)], 0.03, 8), 0.010, GOLD, 16)
pieces.append(join("RainShower", [rosette(0.0, 0.0), arm, head]))

# Tall basin mixer: a round foot, a slim body, a straight spout with a slight drop at its end, a lever on its side.
body = revolve("MixerBody", [(0.0, 0.0), (0.024, 0.0), (0.024, 0.004), (0.020, 0.008), (0.0165, 0.012), (0.0165, 0.262),
                             (0.014, 0.269), (0.0, 0.270)], GOLD, 24)
spout_ = tube("MixerSpout", bend([(0.0, 0.0, 0.245), (0.0, -0.15, 0.245), (0.0, -0.162, 0.226)], 0.02, 6), 0.0085, GOLD, 14)
lever = tube("Lever", [(0.012, 0.0, 0.205), (0.062, 0.006, 0.222)], 0.0055, GOLD, 10)
pieces.append(join("BasinMixer", [body, spout_, lever]))


# ---------------------------------------------------------------- Bowl basins
def bowl(name, mat, scale=1.0):
    n = 10
    outer_p = [(0.075 + 0.125 * math.sin(t * math.pi / 2), 0.14 * (1 - math.cos(t * math.pi / 2))) for t in (k / n for k in range(n + 1))]
    inner_p = [(0.069 + 0.125 * math.sin(t * math.pi / 2), 0.022 + 0.118 * (1 - math.cos(t * math.pi / 2))) for t in (k / n for k in range(n + 1))]
    # From the inside's centre up the inner wall, over the thin lip, down the outside to the foot.
    prof = [(0.0, 0.022)] + inner_p[1:-1] + [(0.1945, 0.1395), (0.196, 0.1418), (0.1985, 0.1418), (0.2, 0.1395)] + outer_p[::-1][1:] + [(0.0, 0.0)]
    prof = [(r * scale, z * scale) for r, z in prof]
    return join(name, [revolve(name, prof, mat, 40)], 50)


pieces.append(bowl("BowlBasin", STONE_BOWL))
pieces.append(bowl("BowlBasinWhite", WHITE_BOWL, 0.95))


# ---------------------------------------------------------------- Pill mirrors
def pill(name, w, h, off=0.010, thick=0.005, edge=0.003):
    """A mirror with round ends, its back `off` from the wall: the glass face, a thin polished edge round it."""
    r = w / 2
    def outline(rr):
        return arc(0.0, h - r, rr, 0, math.pi, 24) + arc(0.0, r, rr, math.pi, 2 * math.pi, 24)
    bm = bmesh.new()
    yb, yf = -off, -off - thick
    rim = [bm.verts.new((x, yb, z)) for x, z in outline(r)]
    rim_f = [bm.verts.new((x, yf + 0.0012, z)) for x, z in outline(r)]
    face = [bm.verts.new((x, yf, z)) for x, z in outline(r - edge)]
    n = len(rim)
    for k in range(n):
        f = bm.faces.new((rim[k], rim[(k + 1) % n], rim_f[(k + 1) % n], rim_f[k]))
        f.material_index = 1
        f = bm.faces.new((rim_f[k], rim_f[(k + 1) % n], face[(k + 1) % n], face[k]))
        f.material_index = 1
    bm.faces.new(face).material_index = 0
    bm.faces.new(rim[::-1]).material_index = 1
    return join(name, [from_bmesh(name, bm, [MIRROR, EDGE])], 50)


pieces.append(pill("PillMirror", 0.60, 1.20))
pieces.append(pill("PillMirrorSmall", 0.45, 0.90))


# ---------------------------------------------------------------- Vanities
def double_vanity():
    w, d, top_z, top_t = 1.80, 0.54, 0.83, 0.03
    side = 0.018
    front = -(d - 0.005)  # the doors' and sides' faces; the top stands 5 mm proud of them
    parts = [box("Body", -w / 2 + side, w / 2 - side, front + 0.018, 0.0, 0.0, top_z, GAP)]
    for i, x0 in enumerate((-w / 2, w / 2 - side)):
        parts.append(box("Side", x0, x0 + side, front, 0.0, 0.0, top_z, WALNUT, uv=(0.5, 1.0, 0.13 + 0.41 * i, 0.07)))
    doors, gap = 5, 0.004
    span = (w - 2 * side - (doors + 1) * gap)
    dw = span / doors
    for i in range(doors):
        x0 = -w / 2 + side + gap + i * (dw + gap)
        parts.append(box("Door", x0, x0 + dw, front, front + 0.018, 0.035, top_z - 0.003, WALNUT, uv=(0.5, 1.0, 0.23 * i + 0.05, 0.31 * i)))
    parts.append(box("Top", -w / 2, w / 2, -d, 0.0, top_z, top_z + top_t, STONE_TOP, bevel=0.002))
    return join("DoubleVanity", parts, 30)


def drawer_vanity():
    w, d, z0, z1, top_t = 0.90, 0.55, 0.40, 0.83, 0.02
    front = -(d - 0.003)
    parts = [box("Body", -w / 2, w / 2, front + 0.018, 0.0, z0, z1, PINK)]
    grip = 0.028
    lower_top = z0 + (z1 - z0 - 2 * grip) / 2
    for a, b in ((z0, lower_top), (lower_top + grip, z1 - grip)):
        parts.append(box("Drawer", -w / 2, w / 2, front, front + 0.018, a, b, PINK, bevel=0.0015))
    for a in (lower_top, z1 - grip):
        parts.append(box("Grip", -w / 2 + 0.002, w / 2 - 0.002, front + 0.012, front + 0.0185, a, a + grip, PINK_SHADE))
    parts.append(box("Top", -w / 2, w / 2, -d, 0.0, z1, z1 + top_t, WHITE_TOP, bevel=0.002))
    return join("DrawerVanity", parts, 30)


pieces.append(double_vanity())
pieces.append(drawer_vanity())

# ---------------------------------------------------------------- Downlight
bm = bmesh.new()
uv = bm.loops.layers.uv.new("UVMap")
seg = 32
ring_out = [bm.verts.new((0.055 * math.cos(2 * math.pi * k / seg), 0.055 * math.sin(2 * math.pi * k / seg), -0.003)) for k in range(seg)]
ring_top = [bm.verts.new((0.055 * math.cos(2 * math.pi * k / seg), 0.055 * math.sin(2 * math.pi * k / seg), 0.0)) for k in range(seg)]
ring_in = [bm.verts.new((0.036 * math.cos(2 * math.pi * k / seg), 0.036 * math.sin(2 * math.pi * k / seg), -0.003)) for k in range(seg)]
ring_lens = [bm.verts.new((0.036 * math.cos(2 * math.pi * k / seg), 0.036 * math.sin(2 * math.pi * k / seg), -0.0015)) for k in range(seg)]
faces_trim = []
for k in range(seg):
    j = (k + 1) % seg
    # Wound to face out and down (the mesh is open at the top, so its normals are set by hand).
    faces_trim.append(bm.faces.new((ring_out[k], ring_out[j], ring_top[j], ring_top[k])))
    faces_trim.append(bm.faces.new((ring_in[k], ring_in[j], ring_out[j], ring_out[k])))
    faces_trim.append(bm.faces.new((ring_lens[k], ring_lens[j], ring_in[j], ring_in[k])))
lens = bm.faces.new(ring_lens[::-1])
for f in faces_trim:
    for lp in f.loops:
        lp[uv].uv = (0.25, 0.5)
for lp in lens.loops:
    lp[uv].uv = (0.75, 0.5)
pieces.append(join("Downlight", [from_bmesh("Downlight", bm, LAMP, recalc=False)], 50))

# ---------------------------------------------------------------- Export
# Every piece as it stands, its transform applied (a cylinder made lying down keeps its turn otherwise, and the game
# sets each piece's turn about the vertical itself).
bpy.ops.object.select_all(action="DESELECT")
for o in pieces:
    o.select_set(True)
bpy.context.view_layer.objects.active = pieces[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
tris = {}
for o in pieces:
    o.data.calc_loop_triangles()
    tris[o.name] = len(o.data.loop_triangles)
print("fittings, triangles:", tris, "total", sum(tris.values()))
bpy.ops.object.select_all(action="DESELECT")
for o in pieces:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_image_format="JPEG", export_image_quality=85,
                          export_cameras=False, export_lights=False)
print(f"wrote {OUT}: {os.path.getsize(OUT) / 1024:.0f} KB")

# ---------------------------------------------------------------- Preview: the pieces in a row, and two close-ups
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    os.makedirs(PREVIEW, exist_ok=True)
    veneer = bpy.data.images["WalnutVeneer"]
    veneer.filepath_raw = os.path.join(PREVIEW, "walnut.png")
    veneer.file_format = "PNG"
    veneer.save()
    world = bpy.data.worlds.new("Room")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.55, 0.56, 1)
    scene.world = world
    row = {"DoubleVanity": (0.0, 0.0), "BowlBasin": (-0.45, 0.865), "BasinMixer": (-0.45, 0.865), "PillMirror": (-0.45, 1.10),
           "Bath": (2.4, 0.0), "BathMixer": (2.25, 0.78), "DrawerVanity": (4.2, 0.0), "BowlBasinWhite": (4.2, 0.855),
           "PillMirrorSmall": (4.2, 1.12), "ShowerSet": (5.5, 1.15), "RainShower": (6.4, 2.2), "Downlight": (3.0, 2.6)}
    for o in pieces:
        x, z = row[o.name]
        o.location = (x, 0.0, z)
    mixer = next(o for o in pieces if o.name == "BasinMixer")
    mixer.location = (-0.45, -0.06, 0.865)
    basin = next(o for o in pieces if o.name == "BowlBasin")
    basin.location = (-0.45, -0.27, 0.865)
    white = next(o for o in pieces if o.name == "BowlBasinWhite")
    white.location = (4.2, -0.28, 0.855)
    lamp = next(o for o in pieces if o.name == "Downlight")
    lamp.location = (3.0, -1.0, 2.6)
    wallm = material("Wall", "#e9e6e1", 0.8)
    floorm = material("Floor", "#bdb5aa", 0.6)
    bpy.ops.mesh.primitive_plane_add(size=12, location=(3, -6, 0))
    bpy.context.active_object.data.materials.append(floorm)
    bpy.ops.mesh.primitive_plane_add(size=12, location=(3, 0.0, 6), rotation=(math.pi / 2, 0, 0))
    bpy.context.active_object.data.materials.append(wallm)
    bpy.ops.object.light_add(type="AREA", location=(3.0, -3.0, 3.0))
    key = bpy.context.active_object
    key.data.energy, key.data.size = 900, 4.0
    key.rotation_euler = (Vector((3.0, 0.0, 0.6)) - key.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, loc, target, lens_mm, res in (("bath_row", (3.0, -6.2, 1.6), (3.0, 0.0, 0.9), 28, (1400, 700)),
                                             ("bath_vanity", (0.4, -1.9, 1.45), (-0.2, -0.2, 0.95), 35, (900, 800)),
                                             ("bath_tub", (1.4, -1.6, 1.5), (2.4, -0.4, 0.5), 35, (900, 800)),
                                             ("bath_small", (5.2, -1.9, 1.5), (4.8, -0.2, 1.1), 35, (900, 800))):
        scene.render.resolution_x, scene.render.resolution_y = res
        cam.location = loc
        cam.data.lens = lens_mm
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
