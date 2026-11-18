"""Build Attack and defend's field camp in Blender: the canvas tent, the camp's supply truck and the spawn truck.

Run (Blender 5, no window):
  blender -b --disable-autoexec -P tools/camp.py -- web/public/models/camp.glb [preview_dir]

Our own generic models in the look of a field army's kit, made from common sizes, no make, badge, insignia
or real unit marking:

- Tent: a canvas tent of the "general purpose, medium" kind, 5 m wide and 6 m long: walls 1.65 m at the eaves,
  a roof up to a ridge at 3 m on two centre poles, a door at the front gable tied open, the wall on its left
  rolled up and strapped, the others pegged down with guy ropes all round. The canvas sags between its poles,
  with tension folds from the pole tops and seams across the roof; a camouflage net hangs over its back half,
  a signal panel (the team's colour) is tied on the front half, a flag on a pole by the door. Inside: two cots,
  a folding table with benches, ammunition boxes and crates on a pallet; sandbags either side of the door, a
  stove pipe through the roof, a small generator behind it.
- SupplyTruck: a six-wheeled cargo truck of the classic 2.5 tonne kind (a bonnet, square fenders, a flat split
  windscreen, a canvas cab top), 6.8 m long: a slatted cargo bed under a tarp on five bows, the tarp sagging
  between them and lashed down, its side towards the camp's front rolled up and its rear flaps rolled up, the
  tailgate down, ammunition boxes and crates inside. A signal panel on the tarp, a band on the doors and a
  pennant on the antenna in the team's colour.
- SpawnTruck: a four-wheeled army truck with a shelter body (the spawn truck, a car of world/car.ts): 7.2 m
  long, 2.5 m wide, 3.3 m high, its axles where shared/assaultFields.mjs TRUCK's physics has them (front 2.35 m
  ahead of the middle, rear 2.1 m behind, 1.86 m track, 0.52 m tyres). A cab over the front axle with a split
  windscreen, a brush guard, a winch, mirrors on tubes, a roof hatch and an antenna with a pennant; the shelter
  with a door and folding steps at the rear, a ladder, a roof rack with a rolled camouflage net, a spare wheel
  and jerrycans; a fuel tank, a toolbox and jerrycans between the axles; leaf springs, axles and the frame
  showing underneath. Its wheels are pivots Wheel_FL ... Wheel_RR at their axles (the left ones turned round,
  as the Teslas'), "Far" a simple copy for far off. The team's colour is its material Paint (door panels, a
  band round the shelter, a roof panel, the pennant); the olive body is "Drab", whose colour comes from the
  vertices; the other material names are world/car.ts's (Trim, Glass, Interior, LightBar, TailLight,
  Reflector, Chrome).

Shading: matte olive drab and canvas, the shade each part gets from the rest (ambient occlusion) and dust and
mud from the ground up (the trucks' wheels and lower body, the tent's hem a little), the trucks' undersides
darker, all baked into a colour per corner ("Col", the only one exported). The camp's two models carry two
materials: "Lit" (the colour is the corner's) and "Team" (the corner's shade only; the game multiplies in the
team's colour). The far copies (TentFar, SupplyTruckFar, the spawn truck's Far) are a few hundred triangles.

Blender's +Y is each model's front (the game's -z), +X its right, the ground at z = 0, the origin in the
middle of its footprint. With preview_dir it renders small views there.
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector, noise
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else None
random.seed(18)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def lin(h):
    """A colour as '#rrggbb' (sRGB) in linear values."""
    h = h.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def mul(a, k):
    return tuple(x * k for x in a)


C = {
    "od": lin("#525a33"),       # olive drab paint
    "od_dark": lin("#3b4026"),  # the frame, the rack, steps: the same paint, darker and older
    "od_light": lin("#646c40"), # edge trims, a newer panel
    "canvas": lin("#646846"),   # the tent's canvas: olive, faded
    "canvas_in": lin("#4f5238"),
    "tarp": lin("#5c6040"),
    "seam": lin("#4a4d33"),
    "mud": lin("#6c5d45"),
    "dust": lin("#857860"),
    "rubber": lin("#1c1c1b"),
    "metal": lin("#30322d"),
    "steel": lin("#5b5d58"),
    "wood": lin("#7a5c3b"),
    "wood_old": lin("#6a5a44"),
    "wood_dark": lin("#4e3f2e"),
    "rope": lin("#a99a78"),
    "strap": lin("#3a3d29"),
    "sand": lin("#a39470"),
    "camo": (lin("#33402a"), lin("#56592f"), lin("#6b5636"), lin("#2a2f22")),
    "cot": lin("#59603b"),
    "glass": lin("#1b2127"),
    "glass_top": lin("#56626c"),
    "lens": lin("#e6e2c8"),
    "red": lin("#7a1814"),
    "white": (1.0, 1.0, 1.0),
    "black": lin("#151514"),
}

# ---- Materials: by the names the game reads. Their colour in the previews only.
PREVIEW_COLOUR = {
    "Lit": (1, 1, 1), "Team": lin("#4fa3e0"), "Drab": (1, 1, 1), "Paint": lin("#4fa3e0"), "Trim": lin("#101112"),
    "Glass": lin("#07080a"), "Interior": lin("#1a1a1c"), "LightBar": lin("#e4ecf5"), "TailLight": lin("#5a0a0d"),
    "Reflector": lin("#8a0f12"), "Chrome": lin("#e6e7ea"),
}
VERTEX_COLOURED = {"Lit", "Team", "Drab", "Paint", "Trim", "Interior"}
MATS = {}


def material(name):
    if name not in MATS:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        p = m.node_tree.nodes["Principled BSDF"]
        p.inputs["Base Color"].default_value = (*PREVIEW_COLOUR[name], 1)
        p.inputs["Roughness"].default_value = 0.85 if name not in ("Glass", "Chrome") else 0.08
        if name == "Chrome":
            p.inputs["Metallic"].default_value = 1.0
        if name == "LightBar":
            p.inputs["Emission Color"].default_value = (1, 1, 0.95, 1)
            p.inputs["Emission Strength"].default_value = 2.0
        MATS[name] = m
    return MATS[name]


def link(obj):
    scene.collection.objects.link(obj)
    return obj


# ---- Building: each part a small mesh of its own (one material, a base colour on its corners), joined per model.

class Model:
    """The parts of one model; `join` makes them one mesh object."""

    def __init__(self, name):
        self.name = name
        self.parts = []

    def add(self, bm, mat, col, M=None):
        """A part from bmesh `bm` (freed here), moved by M, in material `mat`; `col` a colour or a function of
        the corner's place."""
        if M is not None:
            bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new(f"{self.name}_part")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(material(mat))
        attr = me.color_attributes.new("Base", "FLOAT_COLOR", "POINT")
        for i, v in enumerate(me.vertices):
            c = col(v.co) if callable(col) else col
            attr.data[i].color = (*c, 1.0)
        obj = link(bpy.data.objects.new(f"{self.name}_part", me))
        self.parts.append(obj)
        return obj

    # Shapes ---------------------------------------------------------------------------------------------

    def hexa(self, corners, mat, col, bevel=0.0, slices=0.0, M=None):
        """A six-sided solid from its 8 corners, corner i at x = i & 1, y = i >> 1 & 1, z = i >> 2 & 1; edges
        bevelled by `bevel`; cut every `slices` m in height (corners for the dirt's gradient)."""
        bm = bmesh.new()
        vs = [bm.verts.new(c) for c in corners]
        for f in ((0, 4, 6, 2), (1, 3, 7, 5), (0, 1, 5, 4), (2, 6, 7, 3), (0, 2, 3, 1), (4, 5, 7, 6)):
            bm.faces.new([vs[i] for i in f])
        if bevel > 0:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect="EDGES", profile=0.5, clamp_overlap=True)
        if slices > 0:
            z0 = min(c[2] for c in corners)
            z1 = max(c[2] for c in corners)
            z = z0 + slices
            while z < z1 - 0.02:
                bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), dist=1e-4,
                                       plane_co=(0, 0, z), plane_no=(0, 0, 1))
                z += slices
        return self.add(bm, mat, col, M)

    def box(self, lo, hi, mat, col, bevel=0.0, slices=0.0, M=None):
        """An axis-aligned box from corner `lo` to corner `hi`."""
        return self.hexa([(hi[0] if i & 1 else lo[0], hi[1] if i >> 1 & 1 else lo[1], hi[2] if i >> 2 & 1 else lo[2]) for i in range(8)],
                         mat, col, bevel, slices, M)

    def cyl(self, a, b, r, mat, col, segs=12, r2=None, M=None):
        """A capped cylinder (a cone with r2) from point a to point b."""
        a, b = Vector(a), Vector(b)
        d = b - a
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r if r2 is None else r2, depth=d.length)
        rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
        bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @ rot, verts=bm.verts)
        return self.add(bm, mat, col, M)

    def tube(self, pts, r, mat, col, segs=6, M=None, caps=True):
        """A round tube along a polyline (ropes, rails, bows)."""
        pts = [Vector(p) for p in pts]
        bm = bmesh.new()
        rings = []
        up = Vector((0, 0, 1))
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            a = t.cross(up)
            if a.length < 1e-3:
                a = t.cross(Vector((1, 0, 0)))
            a.normalize()
            b = t.cross(a)
            rings.append([bm.verts.new(p + (a * math.cos(2 * math.pi * k / segs) + b * math.sin(2 * math.pi * k / segs)) * r) for k in range(segs)])
        for r0, r1 in zip(rings, rings[1:]):
            for k in range(segs):
                bm.faces.new((r0[k], r0[(k + 1) % segs], r1[(k + 1) % segs], r1[k]))
        if caps:
            bm.faces.new(list(reversed(rings[0])))
            bm.faces.new(rings[-1])
        return self.add(bm, mat, col, M)

    def surface(self, fn, nu, nv, mat, col, M=None, both=0.0):
        """A sheet of (nu + 1) x (nv + 1) corners at fn(u, v), u and v from 0 to 1; with `both`, a second sheet
        behind it that far back, so a single-sided material shows it from both sides (a flag)."""
        bm = bmesh.new()
        grid = [[bm.verts.new(fn(i / nu, j / nv)) for j in range(nv + 1)] for i in range(nu + 1)]
        for i in range(nu):
            for j in range(nv):
                bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
        if both:
            bm.normal_update()
            back = [[bm.verts.new(v.co - v.normal * both) for v in row] for row in grid]
            for i in range(nu):
                for j in range(nv):
                    bm.faces.new((back[i][j], back[i][j + 1], back[i + 1][j + 1], back[i + 1][j]))
        bm.normal_update()
        bmesh.ops.transform(bm, matrix=M or Matrix(), verts=bm.verts)
        # Not recalc_face_normals: it could turn a sheet over. The winding as built faces out.
        me = bpy.data.meshes.new(f"{self.name}_part")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(material(mat))
        attr = me.color_attributes.new("Base", "FLOAT_COLOR", "POINT")
        for i, v in enumerate(me.vertices):
            c = col(v.co) if callable(col) else col
            attr.data[i].color = (*c, 1.0)
        obj = link(bpy.data.objects.new(f"{self.name}_part", me))
        self.parts.append(obj)
        return obj

    def lathe(self, profile, segs, mat, col, M=None):
        """A closed solid of revolution about the x axis: `profile` is (x, r) round its outline."""
        bm = bmesh.new()
        rings = [[bm.verts.new((x, r * math.cos(2 * math.pi * k / segs), r * math.sin(2 * math.pi * k / segs))) for k in range(segs)] for x, r in profile]
        n = len(rings)
        for i in range(n):
            r0, r1 = rings[i], rings[(i + 1) % n]
            for k in range(segs):
                bm.faces.new((r0[k], r1[k], r1[(k + 1) % segs], r0[(k + 1) % segs]))
        return self.add(bm, mat, col, M)

    def join(self):
        bpy.ops.object.select_all(action="DESELECT")
        for o in self.parts:
            o.select_set(True)
        bpy.context.view_layer.objects.active = self.parts[0]
        bpy.ops.object.join()
        obj = self.parts[0]
        obj.name = obj.data.name = self.name
        me = obj.data
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(38))
        self.parts = []
        return obj


# ---- Shade: the ambient occlusion and the dirt, baked into "Col".

def _hemisphere(n):
    out = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        r = math.sqrt((i + 0.5) / n)
        a = golden * i
        out.append(Vector((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r)))))
    return out


def smooth(v):
    v = min(1.0, max(0.0, v))
    return v * v * (3 - 2 * v)


def bake(obj, blockers=(), rays=40, reach=1.0, lo=0.35, dirt=None, team_white=True, ground=True, skip=("Glass", "LightBar", "TailLight", "Chrome")):
    """The shade each corner gets from the model itself and the ground (rays over its half sphere), times its
    base colour, with dust and mud mixed in by `dirt(position, normal)` (0 none .. 1 caked), as "Col".
    Team parts keep white times their shade (the game multiplies in the team's colour)."""
    verts, polys = [], []
    for o in (obj, *blockers):
        me = o.data
        M = o.matrix_world
        base = len(verts)
        verts += [M @ v.co for v in me.vertices]
        names = [m.name if m else "" for m in me.materials]
        for p in me.polygons:
            if names and names[p.material_index] in skip:
                continue
            polys.append([base + i for i in p.vertices])
    if ground:
        base = len(verts)
        verts += [Vector((-40, -40, 0)), Vector((40, -40, 0)), Vector((40, 40, 0)), Vector((-40, 40, 0))]
        polys.append([base, base + 1, base + 2, base + 3])
    tree = BVHTree.FromPolygons(verts, polys)
    dirs = _hemisphere(rays)
    me = obj.data
    M = obj.matrix_world
    names = [m.name for m in me.materials]
    acc = [Vector() for _ in me.vertices]
    mat_of = [None] * len(me.vertices)
    for p in me.polygons:
        for i in p.vertices:
            acc[i] += p.normal * p.area
            mat_of[i] = names[p.material_index]
    vals = []
    nrm = []
    for v in me.vertices:
        n = (M.to_3x3() @ (acc[v.index] if acc[v.index].length > 1e-12 else v.normal)).normalized()
        nrm.append(n)
        p = M @ v.co + n * 0.004
        t = Vector((1, 0, 0)) if abs(n.x) < 0.9 else Vector((0, 1, 0))
        a = n.cross(t).normalized()
        b = n.cross(a)
        hit = 0.0
        for d in dirs:
            w = a * d.x + b * d.y + n * d.z
            loc, _, _, dist = tree.ray_cast(p, w, reach)
            if loc is not None:
                hit += 1 - 0.5 * dist / reach
        vals.append(1 - hit / rays)
    nbrs = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nbrs[a].append(b)
        nbrs[b].append(a)
    for _ in range(3):
        vals = [0.5 * v + 0.5 * (sum(vals[j] for j in nb) / len(nb)) if nb else v for v, nb in zip(vals, nbrs)]
    vals = [lo + (1 - lo) * smooth((v - 0.2) / 0.65) for v in vals]
    src = me.color_attributes["Base"]
    out = me.color_attributes.new("Col", "BYTE_COLOR", "POINT")
    for i, v in enumerate(me.vertices):
        base_c = tuple(src.data[i].color[:3])
        if mat_of[i] == "Team" and team_white:
            c = (1.0, 1.0, 1.0)
        else:
            c = base_c
            if dirt and mat_of[i] not in ("Glass", "LightBar", "TailLight", "Chrome", "Reflector"):
                w = M @ v.co
                k = dirt(w, nrm[i])
                if k > 0:
                    grime = mix(C["dust"], C["mud"], min(1.0, k * 1.3))
                    c = mix(c, grime, min(0.85, k))
                if nrm[i].z < -0.4:  # the underside: oil and road grime
                    c = mul(c, 0.6)
        c = mul(c, vals[i])
        out.data[i].color = (*c, 1.0)
    me.color_attributes.remove(src)
    me.color_attributes.active_color = out
    me.color_attributes.render_color_index = me.color_attributes.active_color_index


def truck_dirt(top):
    """Dust from the ground up to `top` m, mud thicker low down and in splashes, a little dust on top faces."""
    def f(p, n):
        h = smooth((top - p.z) / top)
        splash = 0.5 + 0.5 * noise.noise(Vector((p.x * 2.1, p.y * 2.1, p.z * 3.0)))
        k = h * (0.55 + 0.45 * splash)
        if n.z > 0.7:
            k = max(k, 0.12 + 0.1 * noise.noise(p * 1.7))
        return k
    return f


def canvas_dirt(p, n):
    """A tent's hem: damp and dirty only the last 25 cm, kept subtle."""
    return 0.45 * smooth((0.25 - p.z) / 0.25)


def triangles(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def mottle(base, amount=0.06, scale=1.3):
    """A colour that wanders a little over a surface (paint and canvas are never one even tone)."""
    def f(p):
        k = 1 + amount * noise.noise(Vector((p.x * scale, p.y * scale, p.z * scale)))
        return mul(base, k)
    return f


def camo(p):
    """The camouflage net's patches: four tones by low-frequency noise."""
    v = noise.noise(Vector((p.x * 0.9, p.y * 0.9, p.z * 0.9))) + 0.5 * noise.noise(Vector((p.x * 2.3, p.y * 2.3, 5.0)))
    tones = C["camo"]
    if v < -0.35:
        return tones[3]
    if v < 0.05:
        return tones[0]
    if v < 0.4:
        return tones[1]
    return tones[2]


# ---- Shared pieces.

def jerrycan(m, x, y, z, mat="Drab", yaw=0.0, colour=None):
    """A 20 l jerrycan (34.5 x 16.5 x 47 cm) standing at (x, y, z), its narrow side along x."""
    col = colour or C["od"]
    R = Matrix.Translation((x, y, z)) @ Matrix.Rotation(yaw, 4, "Z")
    m.box((-0.0825, -0.1725, 0), (0.0825, 0.1725, 0.43), mat, col, bevel=0.015, M=R)
    m.box((-0.06, -0.15, 0.43), (0.06, 0.15, 0.47), mat, col, bevel=0.008, M=R)  # the handles' bridge
    m.cyl((0, 0.13, 0.43), (0, 0.17, 0.5), 0.025, mat, mul(col, 0.8), segs=8, M=R)  # the spout


def ammo_box(m, x, y, z, mat, yaw=0.0, colour=None):
    """A steel ammunition box (30 x 15 x 19 cm) with its lid's catch and handle."""
    col = colour or C["od"]
    R = Matrix.Translation((x, y, z)) @ Matrix.Rotation(yaw, 4, "Z")
    m.box((-0.15, -0.075, 0), (0.15, 0.075, 0.19), mat, col, bevel=0.01, M=R)
    m.box((-0.155, -0.08, 0.17), (0.155, 0.08, 0.2), mat, mul(col, 0.85), M=R)
    m.box((-0.06, -0.012, 0.2), (0.06, 0.012, 0.215), mat, C["metal"], M=R)


def crate(m, x, y, z, w, d, h, mat, yaw=0.0):
    """A wooden crate with battens round its ends."""
    R = Matrix.Translation((x, y, z)) @ Matrix.Rotation(yaw, 4, "Z")
    m.box((-w / 2, -d / 2, 0), (w / 2, d / 2, h), mat, mottle(C["wood"], 0.1, 4), bevel=0.01, M=R)
    for s in (-1, 1):
        m.box((s * w / 2 - 0.04 * s - 0.03, -d / 2 - 0.012, -0.005), (s * w / 2 - 0.04 * s + 0.03, d / 2 + 0.012, h + 0.012), mat, C["wood_dark"], M=R)
    m.box((-w / 2 - 0.005, -d / 2 - 0.006, h * 0.5), (w / 2 + 0.005, d / 2 + 0.006, h * 0.5 + 0.03), mat, C["wood_dark"], M=R)


def pallet(m, x, y, z, w, d, mat):
    for k in range(5):
        px = -w / 2 + 0.05 + k * (w - 0.1) / 4
        m.box((x + px - 0.05, y - d / 2, z + 0.1), (x + px + 0.05, y + d / 2, z + 0.13), mat, C["wood_old"])
    for k in (-1, 0, 1):
        m.box((x - w / 2, y + k * (d / 2 - 0.05) - 0.05, z), (x + w / 2, y + k * (d / 2 - 0.05) + 0.05, z + 0.1), mat, C["wood_dark"])


def tyre(m, cx, cy, cz, R, W, mat, segs=28, lugs=20, axis="x", rim=None, rim_mat=None, coarse=False):
    """An off-road tyre with deep blocky tread (two staggered rows of lugs) and a steel disc wheel, its axle
    along x (or z: lying flat). Outward is +x."""
    base = Matrix.Translation((cx, cy, cz)) @ (Matrix.Rotation(math.pi / 2, 4, "Y") if axis == "z" else Matrix())
    hw = W / 2
    rr = R * 0.6
    body = R - 0.035
    prof = [(hw - 0.05, rr), (hw - 0.01, rr + 0.03), (hw, R * 0.78), (hw - 0.005, R * 0.87), (hw - 0.02, body - 0.01), (hw - 0.05, body),
            (-hw + 0.05, body), (-hw + 0.02, body - 0.01), (-hw + 0.005, R * 0.87), (-hw, R * 0.78), (-hw + 0.01, rr + 0.03), (-hw + 0.05, rr)]
    if coarse:  # a parked prop's: fewer rings round the shoulders
        prof = [prof[i] for i in (0, 2, 4, 5, 6, 7, 9, 11)]
    rub = mix(C["rubber"], C["dust"], 0.18)
    m.lathe(prof, segs, mat, rub, M=base)
    for i in range(lugs):
        for row in (0, 1):
            a = 2 * math.pi * (i + 0.5 * row) / lugs
            x0, x1 = (0.01, hw - 0.012) if row == 0 else (-hw + 0.012, -0.01)
            skew = 0.045 if row == 0 else -0.045
            da = 0.42 * math.pi / lugs
            cs = []
            for k in range(8):
                x = x1 if k & 1 else x0
                aa = a + (da if k >> 1 & 1 else -da) + (skew if x == (x1 if row == 0 else x0) else 0)
                r = R if k >> 2 & 1 else body - 0.006
                cs.append((x, r * math.cos(aa), r * math.sin(aa)))
            m.hexa(cs, mat, mix(C["rubber"], C["dust"], 0.3), M=base)
    if rim is not False:
        rc = rim or C["od"]
        rm = rim_mat or mat
        m.cyl((hw - 0.09, 0, 0), (hw - 0.04, 0, 0), rr + 0.005, rm, rc, segs=segs, M=base)  # the disc's rim
        m.cyl((hw - 0.045, 0, 0), (hw - 0.025, 0, 0), rr * 0.82, rm, mul(rc, 0.85), segs=segs, M=base)  # the dish
        m.cyl((hw - 0.03, 0, 0), (hw + 0.02, 0, 0), R * 0.2, rm, mul(rc, 0.9), segs=12, M=base)  # the hub
        for k in range(0 if coarse else 8):
            a = 2 * math.pi * k / 8
            m.cyl((hw + 0.01, R * 0.14 * math.cos(a), R * 0.14 * math.sin(a)), (hw + 0.035, R * 0.14 * math.cos(a), R * 0.14 * math.sin(a)), 0.016, rm, C["metal"], segs=6, M=base)
        for k in range(0 if coarse else 6):  # the disc's holes, dark
            a = 2 * math.pi * (k + 0.5) / 6
            m.cyl((hw - 0.03, R * 0.36 * math.cos(a), R * 0.36 * math.sin(a)), (hw - 0.022, R * 0.36 * math.cos(a), R * 0.36 * math.sin(a)), 0.035, rm, C["black"], segs=8, M=base)
        m.cyl((-hw + 0.04, 0, 0), (-hw + 0.06, 0, 0), rr + 0.005, rm, mul(rc, 0.6), segs=segs, M=base)  # its inside


# =====================================================================================================
# TENT
# =====================================================================================================
TW, TL = 5.0, 6.0          # wide (x), long (y)
EAVE, RIDGE = 1.65, 3.0
HX, HY = TW / 2, TL / 2
POLES_Y = (-HY, -HY / 2, 0.0, HY / 2, HY)   # where the eave poles and guy ropes pull (every 1.5 m)
CENTRE_Y = (-1.5, 1.5)                        # the centre poles under the ridge


def between(y, pts):
    """0 at the nearest support in `pts`, 1 half way to the next: how far the canvas hangs free there."""
    best = 1.0
    for a, b in zip(pts, pts[1:]):
        if a <= y <= b:
            t = (y - a) / (b - a)
            best = math.sin(math.pi * t)
    return best


def roof(s, u, y):
    """A point on the roof's slope on side s (-1 left, 1 right): u from the ridge (0) to the eave (1) and
    beyond (to 1.06, the eave's fly), y along. The canvas sags between the eave poles and the centre poles,
    with tension folds fanning out from the eave poles' tops."""
    x = s * HX * u
    z = RIDGE - (RIDGE - EAVE) * u
    if u > 1:
        z -= (u - 1) * 2.2  # the fly drops past the eave
    sag_eave = between(y, POLES_Y)
    sag_ridge = between(y, (-HY, *CENTRE_Y, HY))
    z -= 0.07 * sag_eave * min(u, 1) ** 1.5 + 0.05 * sag_ridge * (1 - min(u, 1)) * min(u, 1) * 4 * 0.5
    z -= 0.035 * math.sin(math.pi * min(u, 1))  # the belly of each panel
    # Folds from each eave pole's top, up into the panel.
    for py in POLES_Y:
        d = y - py
        w = max(0.0, 1 - min(u, 1)) + 0.05
        r2 = d * d + (1 - min(u, 1)) ** 2 * 2.0
        if r2 < 0.9:
            ang = math.atan2(d, w * 1.6)
            z += 0.012 * math.cos(ang * 7) * (1 - r2 / 0.9) ** 2
    return Vector((x, y, z))


def wall_point(s, y, h, rolled=False):
    """A point on the long wall on side s: y along, h from the ground (0) to the eave (1). The wall bellies
    out a little between its poles; vertical folds hang from the eave's pull; the hem flares on the grass."""
    z = h * EAVE
    out = 0.035 * between(y, POLES_Y) * math.sin(math.pi * h) + 0.006 * math.sin(y * 2 * math.pi / 0.37) * (1 - h) ** 0.5
    if h < 0.1:
        out += 0.06 * (0.1 - h) / 0.1
    return Vector((s * (HX + out), y, z))


def gable_point(e, x, h_top, h):
    """A point on a gable end (e -1 back, 1 front): x across, h from the ground to the roof line above x."""
    z = h * h_top
    out = 0.03 * math.sin(math.pi * h) * math.cos(math.pi * x / TW) + 0.005 * math.sin(x * 2 * math.pi / 0.41) * (1 - h)
    if h < 0.1 / max(h_top, 0.3):
        out += 0.04
    return Vector((x, e * (HY + out), z))


def roof_z(x):
    return RIDGE - (RIDGE - EAVE) * min(1.0, abs(x) / HX)


def build_tent():
    m = Model("Tent")
    canvas = mottle(C["canvas"], 0.07, 0.9)

    def seamed(p):
        c = canvas(p)
        # Seams across the roof every 1.5 m and along it at mid-slope.
        if p.z > EAVE - 0.05 and (min(abs(p.y - k) for k in (-2.25, -0.75, 0.75, 2.25)) < 0.05 or abs(abs(p.x) - HX * 0.5) < 0.05):
            c = mul(c, 0.82)
        return c

    # The roof, both slopes, with its fly past the eaves.
    for s in (-1, 1):
        if s > 0:
            m.surface(lambda u, v, s=s: roof(s, u * 1.06, -HY - 0.06 + v * (TL + 0.12)), 10, 36, "Lit", seamed)
        else:
            m.surface(lambda u, v, s=s: roof(s, (1 - u) * 1.06, -HY - 0.06 + v * (TL + 0.12)), 10, 36, "Lit", seamed)
    # A ridge cap strip.
    m.surface(lambda u, v: Vector(((u - 0.5) * 0.24, -HY - 0.08 + v * (TL + 0.16), RIDGE + 0.012 - abs(u - 0.5) * 0.06 - 0.04 * between(-HY + v * TL, (-HY, *CENTRE_Y, HY)) * 0)), 2, 24, "Lit", mul(C["canvas"], 0.85))

    # The right wall, down and pegged.
    m.surface(lambda u, v: wall_point(1, -HY + u * TL, v), 36, 6, "Lit", seamed)
    # The left wall rolled up under the eave and strapped: a roll of canvas along it, straps hanging.
    m.tube([(-HX - 0.06, -HY + 0.1 + k * (TL - 0.2) / 12, EAVE - 0.18 - 0.015 * math.sin(k * 0.9)) for k in range(13)], 0.11, "Lit", mul(C["canvas"], 0.9), segs=8)
    for py in (-2.2, -0.75, 0.75, 2.2):
        m.tube([(-HX - 0.07, py, EAVE - 0.02), (-HX - 0.19, py, EAVE - 0.18), (-HX - 0.07, py, EAVE - 0.33), (-HX + 0.02, py, EAVE - 0.24)], 0.012, "Lit", C["strap"], segs=4)
        m.tube([(-HX + 0.02, py + 0.03, EAVE - 0.24), (-HX + 0.01, py + 0.05, EAVE - 0.55)], 0.01, "Lit", C["strap"], segs=4, caps=True)

    # The back gable, closed; the front with its door tied open either side.
    for e in (-1, 1):
        def gp(u, v, e=e):
            x = -HX + u * TW
            return gable_point(e, x, roof_z(x) - 0.02, v)
        if e < 0:
            m.surface(lambda u, v: gp(u, v), 20, 8, "Lit", seamed)
        else:
            # Either side of the door (x beyond +-0.95), and the gable's top above it (z > 1.95).
            for lo, hi in ((-HX, -0.95), (0.95, HX)):
                def side(u, v, lo=lo, hi=hi):
                    x = lo + u * (hi - lo)
                    return gable_point(1, x, roof_z(x) - 0.02, 1 - v)
                m.surface(side, 10, 10, "Lit", seamed)

            def top(u, v):
                x = -0.95 + u * 1.9
                zt = roof_z(x) - 0.02
                z = 1.95 + (zt - 1.95) * (1 - v)
                return Vector((x, HY + 0.02 * math.sin(math.pi * (1 - v)), z))
            m.surface(top, 8, 4, "Lit", seamed)
            # The door's flaps, bunched and tied back at each side.
            for s in (-1, 1):
                pts = [(s * (0.98 + 0.05 * math.sin(k)), HY + 0.12, 0.05 + k * 1.9 / 8) for k in range(9)]
                m.tube(pts, 0.1, "Lit", mul(C["canvas"], 0.92), segs=7)
                m.tube([(s * 0.86, HY + 0.12, 1.15), (s * 1.0, HY + 0.24, 1.18), (s * 1.12, HY + 0.12, 1.15)], 0.012, "Lit", C["strap"], segs=4)
    # Poles: two centre poles, eave poles, ridge pole and the door's frame.
    pole = C["wood_dark"]
    for cy in CENTRE_Y:
        m.cyl((0, cy, 0), (0, cy, RIDGE - 0.02), 0.04, "Lit", pole, segs=8)
    m.cyl((0, -HY + 0.05, RIDGE - 0.08), (0, HY - 0.05, RIDGE - 0.08), 0.03, "Lit", pole, segs=6)
    for s in (-1, 1):
        for py in POLES_Y:
            m.cyl((s * (HX - 0.04), py, 0), (s * (HX - 0.04), py, EAVE - 0.02), 0.025, "Lit", pole, segs=6)
        m.cyl((s * 0.95, HY - 0.03, 0), (s * 0.95, HY - 0.03, 1.97), 0.025, "Lit", pole, segs=6)
    m.cyl((-0.95, HY - 0.03, 1.97), (0.95, HY - 0.03, 1.97), 0.022, "Lit", pole, segs=6)
    for e in (-1, 1):
        m.cyl((0, e * (HY - 0.04), 0), (0, e * (HY - 0.04), RIDGE - 0.05), 0.035, "Lit", pole, segs=8)

    # Guy ropes to pegs all round: from each eave pole's top out to the side, from the ridge's ends along it.
    def guy(a, b):
        a, b = Vector(a), Vector(b)
        mid = (a + b) / 2 - Vector((0, 0, 0.03))
        m.tube([a, mid, b], 0.007, "Lit", C["rope"], segs=4, caps=False)
        m.cyl(b - Vector((0, 0, 0.12)), b + Vector((0, 0, 0.06)), 0.018, "Lit", C["metal"], segs=5)  # the peg
        t = a + (b - a) * 0.72
        m.box((t.x - 0.02, t.y - 0.02, t.z - 0.03), (t.x + 0.02, t.y + 0.02, t.z + 0.03), "Lit", C["wood_dark"])  # the runner
    for s in (-1, 1):
        for py in (-1.5, 0.0, 1.5):
            guy((s * (HX + 0.05), py, EAVE + 0.02), (s * (HX + 1.0), py, 0.03))
        for e in (-1, 1):
            guy((s * (HX + 0.05), e * HY, EAVE + 0.02), (s * (HX + 0.6), e * (HY + 0.7), 0.03))
    guy((0, -HY - 0.04, RIDGE - 0.05), (0, -HY - 1.3, 0.03))
    for s in (-1, 1):  # the front's ropes go out beside the door
        guy((s * 0.95, HY + 0.05, 1.97), (s * 1.5, HY + 1.3, 0.03))
    # Pegged hem loops along the closed walls.
    for k in range(13):
        py = -HY + 0.25 + k * (TL - 0.5) / 12
        m.cyl((HX + 0.12, py, -0.05), (HX + 0.12, py, 0.08), 0.012, "Lit", C["metal"], segs=4)

    # The stove's pipe through the back of the roof, with its rain cap and the roof's fire ring.
    sx, sy = 1.05, -2.0
    rz = roof(1, sx / HX, sy).z
    m.cyl((sx, sy, rz - 0.6), (sx, sy, rz + 0.55), 0.065, "Lit", C["metal"], segs=10)
    m.cyl((sx, sy, rz + 0.55), (sx, sy, rz + 0.62), 0.13, "Lit", C["metal"], segs=10, r2=0.02)
    m.cyl((sx, sy, rz - 0.01), (sx, sy, rz + 0.025), 0.2, "Lit", mul(C["metal"], 1.3), segs=12)

    # The camouflage net over the back half: it drapes over the roof, 10 to 25 cm above the canvas in lumps
    # where it lies on its own folds, and hangs down the sides with a ragged edge.
    # Down the sides to about 0.9 m: u runs past 1 on both sides.
    def draped(u, v):
        a = -1.16 + 2.32 * u
        y = -HY - 0.35 + v * 3.3
        s = 1 if a >= 0 else -1
        au = abs(a)
        lump = 0.06 + 0.08 * (0.5 + 0.5 * noise.noise(Vector((u * 7, v * 6, 1.3))))
        if au <= 1.0:
            p = roof(s, au, y)
            p.z += lump
        else:
            e = roof(s, 1.0, y)
            drop = (au - 1.0) / 0.16
            rag = 0.12 * noise.noise(Vector((y * 3.1, 4.0, 0.5)))
            p = Vector((e.x + s * (0.12 + 0.05 * drop), y, e.z + lump - drop * (0.75 + rag)))
        if y < -HY:  # the back's edge droops off the gable
            p.z -= (-HY - y) * 1.6
        return p
    m.surface(draped, 28, 14, "Lit", camo)

    # The signal panel on the front half of the roof, both slopes, in the team's colour.
    for s in (-1, 1):
        def panel(u, v, s=s):
            p = roof(s, 0.12 + u * 0.62, 0.35 + v * 1.9)
            p.z += 0.03
            return p
        m.surface(panel if s > 0 else (lambda u, v, s=s: panel(1 - u, v, s)), 6, 8, "Team", C["white"])
    # Its tie cords at the corners.
    for s in (-1, 1):
        for uy in (0.35, 2.25):
            a = roof(s, 0.74, uy) + Vector((0, 0, 0.03))
            b = roof(s, 1.0, uy) + Vector((s * 0.03, 0, 0.0))
            m.tube([a, b], 0.006, "Lit", C["rope"], segs=4, caps=False)

    # Inside: two cots along the right wall, a folding table with benches by the open side, a pallet of
    # ammunition boxes and crates at the back.
    for cy in (-1.6, 0.6):
        R = Matrix.Translation((1.55, cy, 0))
        m.box((-0.33, -0.95, 0.38), (0.33, 0.95, 0.42), "Lit", C["cot"], M=R)
        for sx in (-1, 1):
            m.cyl((sx * 0.33, -0.98, 0.4), (sx * 0.33, 0.98, 0.4), 0.017, "Lit", C["metal"], segs=5, M=R)
        for ly in (-0.85, 0, 0.85):
            m.tube([(-0.33, ly, 0.4), (0.33, ly + 0.05, 0.0)], 0.012, "Lit", C["metal"], segs=4, M=R)
            m.tube([(0.33, ly, 0.4), (-0.33, ly + 0.05, 0.0)], 0.012, "Lit", C["metal"], segs=4, M=R)
        m.box((-0.3, -0.9, 0.42), (0.3, -0.3, 0.52), "Lit", mul(C["cot"], 0.75), bevel=0.04, M=R)  # a rolled sleeping bag
    table = Matrix.Translation((-1.2, 1.1, 0))
    m.box((-0.9, -0.38, 0.72), (0.9, 0.38, 0.76), "Lit", C["od"], M=table)
    for sx in (-0.8, 0.8):
        for sy in (-0.3, 0.3):
            m.cyl((sx, sy, 0), (sx, sy, 0.72), 0.018, "Lit", C["metal"], segs=5, M=table)
    for by in (-0.7, 0.7):
        m.box((-0.85, by - 0.14, 0.42), (0.85, by + 0.14, 0.45), "Lit", C["od"], M=table)
        for sx in (-0.75, 0.75):
            m.box((sx - 0.02, by - 0.12, 0), (sx + 0.02, by + 0.12, 0.42), "Lit", C["metal"], M=table)
    ammo_box(m, -1.5, 1.0, 0.76, "Lit", yaw=0.3)
    m.box((-0.95, 0.95, 0.76), (-0.6, 1.2, 0.98), "Lit", lin("#3d4430"), bevel=0.01)  # a field radio
    m.cyl((-0.65, 1.15, 0.98), (-0.62, 1.12, 1.6), 0.006, "Lit", C["black"], segs=4)
    m.cyl((-1.9, 1.25, 0.76), (-1.9, 1.25, 0.95), 0.06, "Lit", C["metal"], segs=8)  # a lantern, unlit
    pallet(m, -1.35, -2.0, 0, 1.2, 1.0, "Lit")
    for i, (ax, ay) in enumerate(((-0.35, -0.3), (0.0, -0.3), (0.35, -0.3), (-0.35, 0.05), (0.0, 0.05), (0.35, 0.05))):
        ammo_box(m, -1.35 + ax, -2.0 + ay, 0.13, "Lit", yaw=math.pi / 2)
        if i < 3:
            ammo_box(m, -1.35 + ax, -2.0 + ay, 0.32, "Lit", yaw=math.pi / 2)
    crate(m, -1.35, -1.75, 0.13, 1.1, 0.4, 0.35, "Lit")
    crate(m, -1.35, -1.75, 0.48, 1.1, 0.4, 0.3, "Lit", yaw=0.04)
    # Sandbags either side of the door, two layers.
    for s in (-1, 1):
        for layer in range(2):
            for k in range(3 - layer):
                x = s * (1.25 + 0.42 * k + 0.21 * layer)
                y = HY + 0.55 + random.uniform(-0.03, 0.03)
                z = 0.16 * layer
                yaw = random.uniform(-0.08, 0.08)
                R = Matrix.Translation((x, y, z)) @ Matrix.Rotation(yaw, 4, "Z")
                m.hexa([((0.2 if i & 1 else -0.2), (0.14 if i >> 1 & 1 else -0.14), (0.17 if i >> 2 & 1 else 0.0)) for i in range(8)],
                       "Lit", mottle(C["sand"], 0.08, 5), bevel=0.06, M=R)
    # The flag on its pole by the door's right, in the team's colour.
    fx, fy = 2.0, HY + 1.1
    m.cyl((fx, fy, 0), (fx, fy, 4.6), 0.03, "Lit", C["metal"], segs=6)
    m.cyl((fx, fy, 4.6), (fx, fy, 4.66), 0.05, "Lit", C["metal"], segs=6)

    def flag(u, v):
        x = u * 1.05
        return Vector((fx + 0.03 + x, fy + 0.09 * math.sin(u * 5.0 + 0.4) * u, 4.55 - v * 0.68 - 0.06 * u))
    m.surface(flag, 10, 4, "Team", C["white"], both=0.01)
    # A small generator behind it, on its frame.
    gx, gy = -1.6, -HY - 0.9
    m.box((gx - 0.4, gy - 0.28, 0.05), (gx + 0.4, gy + 0.28, 0.55), "Lit", C["od"], bevel=0.02)
    for s in (-1, 1):
        m.tube([(gx - 0.45, gy + s * 0.32, 0.02), (gx - 0.45, gy + s * 0.32, 0.62), (gx + 0.45, gy + s * 0.32, 0.62), (gx + 0.45, gy + s * 0.32, 0.02)], 0.018, "Lit", C["metal"], segs=5)
    m.cyl((gx + 0.25, gy, 0.55), (gx + 0.25, gy, 0.66), 0.06, "Lit", C["metal"], segs=8)
    m.tube([(gx + 0.4, gy, 0.3), (gx + 1.0, gy + 0.3, 0.02), (gx + 2.6, gy + 0.6, 0.02)], 0.01, "Lit", C["black"], segs=4, caps=False)

    tent = m.join()
    bake(tent, reach=2.4, rays=40, lo=0.3, dirt=canvas_dirt)
    return tent


def build_tent_far():
    m = Model("TentFar")
    can = C["canvas"]
    m.box((-HX, -HY, 0), (HX, HY, EAVE), "Lit", mul(can, 0.85))
    for s in (-1, 1):
        # A slope from the ridge to past the eave, 3 cm thick.
        m.hexa([(s * (HX + 0.06) if i & 1 else 0.0, (HY + 0.06) if i >> 1 & 1 else -HY - 0.06,
                 (EAVE - 0.06 if i & 1 else RIDGE) + (0.03 if i >> 2 & 1 else 0)) for i in range(8)], "Lit", can)
        # Its team panel, and the net over its back half.
        m.hexa([(s * HX * (0.74 if i & 1 else 0.12), 0.35 + (1.9 if i >> 1 & 1 else 0),
                 roof_z(HX * (0.74 if i & 1 else 0.12)) + (0.07 if i >> 2 & 1 else 0.04)) for i in range(8)], "Team", C["white"])
        m.hexa([(s * (HX + 0.12) if i & 1 else 0.0, -0.3 if i >> 1 & 1 else -HY - 0.3,
                 (EAVE - 0.5 if i & 1 else RIDGE) + (0.13 if i >> 2 & 1 else 0.08)) for i in range(8)], "Lit", C["camo"][0])
    for e in (-1, 1):  # the gables' triangles
        m.hexa([(0.0 if i >> 2 & 1 else (HX if i & 1 else -HX), e * HY + (0.01 if i >> 1 & 1 else 0), RIDGE - 0.02 if i >> 2 & 1 else EAVE) for i in range(8)], "Lit", can)
    m.box((-0.9, HY - 0.02, 0), (0.9, HY + 0.01, 1.9), "Lit", mul(can, 0.25))
    far = m.join()
    bake(far, reach=2.0, rays=24, lo=0.4)
    return far


# =====================================================================================================
# SUPPLY TRUCK (six wheels, a canvas-covered cargo bed)
# =====================================================================================================
SL = 6.8
S_R, S_W, S_X = 0.5, 0.32, 0.9
S_AXLES = (2.15, -1.05, -2.3)
BED_Y0, BED_Y1, BED_Z = -3.35, 0.72, 1.18
BOWS = (0.68, -0.35, -1.37, -2.38, -3.3)


def tarp_profile(t):
    """The tarp's cross-section over a bow: t from 0 (bottom of the left side) round the arch to 1 (bottom of
    the right side). Returns (x, z) and the inward normal."""
    hw = 1.24
    side_bot, side_top, crown = 1.62, 2.62, 3.08
    lens = [side_top - side_bot, math.pi * hw / 2 * 1.02, side_top - side_bot]
    total = sum(lens)
    d = t * total
    if d <= lens[0]:
        return (-hw, side_bot + d), (1, 0)
    d -= lens[0]
    if d <= lens[1]:
        a = math.pi - (d / lens[1]) * math.pi
        x = hw * math.cos(a)
        z = side_top + (crown - side_top) * math.sin(a)
        n = Vector((-math.cos(a) / hw, -math.sin(a) / (crown - side_top))).normalized()
        return (x, z), (n.x, n.y)
    d -= lens[1]
    return (hw, side_top - d), (-1, 0)


def build_supply():
    m = Model("SupplyTruck")
    od = mottle(C["od"], 0.08, 1.1)
    # Frame, axles, springs, the drive line.
    for s in (-1, 1):
        m.box((s * 0.4 - 0.05, -3.3, 0.6), (s * 0.4 + 0.05, 3.2, 0.86), "Lit", C["od_dark"])
    for cy in (2.8, 1.0, -0.2, -1.7, -3.1):
        m.box((-0.4, cy - 0.05, 0.64), (0.4, cy + 0.05, 0.82), "Lit", C["od_dark"])
    for ay in S_AXLES:
        m.cyl((-0.78, ay, S_R), (0.78, ay, S_R), 0.06, "Lit", C["od_dark"], segs=8)
        m.cyl((0, ay - 0.2, S_R), (0, ay + 0.2, S_R), 0.17, "Lit", C["od_dark"], segs=10)
        for s in (-1, 1):
            m.hexa([(s * 0.5 + (0.05 if i & 1 else -0.05), ay + (0.6 if i >> 1 & 1 else -0.6), 0.66 + (0.06 if i >> 2 & 1 else 0)) for i in range(8)], "Lit", C["metal"])
    m.cyl((0, 1.4, 0.75), (0, -2.2, 0.55), 0.045, "Lit", C["metal"], segs=6)
    # Tyres and wheels.
    for ay in S_AXLES:
        for s in (-1, 1):
            mm = Model("tmp")
            tyre(mm, 0, 0, 0, S_R, S_W, "Lit", segs=16, lugs=10, coarse=True)
            R = Matrix.Translation((s * S_X, ay, S_R)) @ (Matrix.Rotation(math.pi, 4, "Z") if s < 0 else Matrix())
            for o in mm.parts:
                o.data.transform(R)
                m.parts.append(o)
    # Front bumper with a winch and shackles; the bonnet; its grille behind a brush guard; headlights.
    m.box((-1.2, 3.18, 0.55), (1.2, 3.4, 0.86), "Lit", od, bevel=0.02)
    m.cyl((-0.32, 3.3, 0.97), (0.32, 3.3, 0.97), 0.11, "Lit", C["metal"], segs=12)
    m.box((-0.42, 3.18, 0.86), (-0.34, 3.4, 1.1), "Lit", C["od_dark"])
    m.box((0.34, 3.18, 0.86), (0.42, 3.4, 1.1), "Lit", C["od_dark"])
    for s in (-1, 1):
        m.tube([(s * 0.85, 3.4, 0.62), (s * 0.85, 3.5, 0.66), (s * 0.85, 3.5, 0.76), (s * 0.85, 3.4, 0.8)], 0.025, "Lit", C["od_dark"], segs=6)
    m.hexa([((0.62 if i & 1 else -0.62) * (0.9 if i >> 2 & 1 else 1), 1.95 if not i >> 1 & 1 else 3.12 - (0.03 if i >> 2 & 1 else 0), 0.95 if not i >> 2 & 1 else 1.62) for i in range(8)],
           "Lit", od, bevel=0.03, slices=0.25)
    m.box((-0.58, 3.12, 0.95), (0.58, 3.16, 1.58), "Lit", C["od_dark"])
    for k in range(7):
        z = 1.0 + k * 0.08
        m.box((-0.52, 3.15, z), (0.52, 3.19, z + 0.04), "Lit", C["black"])
    for x in (-0.6, -0.25, 0.25, 0.6):
        m.tube([(x, 3.38, 0.86), (x, 3.3, 1.7)], 0.025, "Lit", C["od_dark"], segs=6)
    m.tube([(-0.6, 3.3, 1.7), (0.6, 3.3, 1.7)], 0.025, "Lit", C["od_dark"], segs=6)
    # Fenders, square, over the front wheels; headlights on them.
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.62, s * 1.22))
        m.box((x0, 1.55, 1.12), (x1, 2.85, 1.17), "Lit", od, bevel=0.01)
        m.hexa([(x1 if i & 1 else x0, (2.85 if not i >> 1 & 1 else 3.2), (1.12 if not i >> 1 & 1 else 0.86) + (0.05 if i >> 2 & 1 else 0)) for i in range(8)], "Lit", od)
        m.box((x0, 1.5, 0.75), (x1, 1.56, 1.17), "Lit", C["od_dark"])
        m.cyl((s * 0.9, 2.95, 1.31), (s * 0.9, 3.1, 1.31), 0.12, "Lit", C["od_dark"], segs=12)
        m.cyl((s * 0.9, 3.1, 1.31), (s * 0.9, 3.115, 1.31), 0.1, "Lit", C["lens"], segs=12)
        m.tube([(s * 0.78, 3.0, 1.17), (s * 0.78, 3.15, 1.45), (s * 1.02, 3.15, 1.45), (s * 1.02, 3.0, 1.17)], 0.012, "Lit", C["od_dark"], segs=4)
        m.box((s * 1.05 - 0.04, 3.05, 1.18), (s * 1.05 + 0.04, 3.1, 1.22), "Lit", C["red"])  # a marker lamp
    # The cab: a steel tub, a flat split windscreen in its frame, the canvas top.
    m.box((-1.1, 0.95, 1.0), (1.1, 1.95, 1.75), "Lit", od, bevel=0.03, slices=0.25)
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.04, s * 1.0))
        m.box((x0, 1.9, 1.78), (x1, 1.93, 2.32), "Lit", C["glass"])
        m.box((x0, 1.88, 2.15), (x1, 1.935, 2.32), "Lit", C["glass_top"])
    m.box((-1.08, 1.86, 1.74), (1.08, 1.9, 2.38), "Lit", C["od_dark"])
    for x0, x1 in ((-1.08, -1.0), (-0.04, 0.04), (1.0, 1.08)):
        m.box((x0, 1.85, 1.74), (x1, 1.95, 2.38), "Lit", C["od_dark"])
    m.box((-1.08, 1.85, 2.32), (1.08, 1.95, 2.39), "Lit", C["od_dark"])
    def soft_top(u, v):
        x = -1.06 + u * 2.12
        y = 0.95 + v * 0.92
        z = 2.4 - 0.03 * math.sin(math.pi * u) * math.sin(math.pi * v)
        return Vector((x, y, z))
    m.surface(soft_top, 8, 5, "Lit", C["tarp"])
    for s in (-1, 1):
        m.surface(lambda u, v, s=s: Vector((s * (1.07 + 0.01 * math.sin(math.pi * v)), 0.95 + (u if s > 0 else 1 - u) * 0.9, 1.75 + v * 0.64)), 6, 3, "Lit", C["tarp"])
        m.box((s * 1.075 - 0.01, 1.3, 1.95), (s * 1.075 + 0.01, 1.8, 2.25), "Lit", C["glass"])
    m.surface(lambda u, v: Vector((-1.07 + u * 2.14, 0.95, 1.75 + v * 0.64)), 6, 3, "Lit", C["tarp"])
    # Team band on the doors.
    for s in (-1, 1):
        m.box((s * 1.104 - 0.004, 1.05, 1.2), (s * 1.104 + 0.004, 1.85, 1.6), "Team", C["white"])
    # Mirrors on tubular arms, a step, the antenna with its pennant, the exhaust.
    for s in (-1, 1):
        m.tube([(s * 1.08, 1.9, 2.0), (s * 1.38, 1.98, 2.0), (s * 1.38, 1.98, 2.35)], 0.014, "Lit", C["od_dark"], segs=5)
        m.box((s * 1.38 - 0.08, 1.94, 2.05), (s * 1.38 + 0.08, 2.0, 2.4), "Lit", C["black"], bevel=0.01)
        m.box((s * 1.05 - 0.1, 0.98, 0.62), (s * 1.05 + 0.1, 1.45, 0.66), "Lit", C["metal"])
    m.cyl((-0.95, 1.0, 2.4), (-0.95, 1.0, 4.4), 0.008, "Lit", C["black"], segs=4)
    m.surface(lambda u, v: Vector((-0.95 + 0.006, 1.0 - u * 0.5, 4.35 - v * 0.28 * (1 - u * 0.8) - 0.03 * u + 0.02 * math.sin(u * 4))), 6, 2, "Team", C["white"], both=0.008)
    m.cyl((1.0, 0.86, 0.9), (1.0, 0.86, 2.75), 0.055, "Lit", C["black"], segs=8)
    m.cyl((1.0, 0.86, 2.75), (1.0, 0.86, 2.8), 0.075, "Lit", C["black"], segs=8)
    # Fuel tank and a toolbox between the axles.
    m.cyl((-1.0, -0.4, 0.82), (-1.0, 0.85, 0.82), 0.24, "Lit", od, segs=14)
    for ty in (-0.2, 0.65):
        m.cyl((-1.0, ty, 0.82), (-1.0, ty + 0.04, 0.82), 0.25, "Lit", C["metal"], segs=14)
    m.box((0.7, -0.4, 0.6), (1.18, 0.6, 1.06), "Lit", od, bevel=0.02)
    jerrycan(m, 1.02, 0.85, 0.62, "Lit")
    # The cargo bed: floor, slatted sides on stakes, the front's headboard; the tailgate let down.
    m.box((-1.22, BED_Y0, BED_Z - 0.1), (1.22, BED_Y1, BED_Z), "Lit", C["od_dark"])
    m.box((-1.18, BED_Y0 + 0.02, BED_Z), (1.18, BED_Y1 - 0.02, BED_Z + 0.02), "Lit", C["wood_old"])
    for s in (-1, 1):
        for k in range(3):
            z = BED_Z + 0.05 + k * 0.15
            m.box((s * 1.2 - 0.025, BED_Y0, z), (s * 1.2 + 0.025, BED_Y1, z + 0.12), "Lit", od)
        for k in range(6):
            y = BED_Y0 + 0.05 + k * (BED_Y1 - BED_Y0 - 0.1) / 5
            m.box((s * 1.2 - 0.04, y - 0.04, BED_Z - 0.1), (s * 1.2 + 0.04, y + 0.04, BED_Z + 0.55), "Lit", C["od_dark"])
        # Stake pockets and tie hooks under the bed's edge.
        for k in range(7):
            y = BED_Y0 + 0.3 + k * 0.58
            m.box((s * 1.24 - 0.02, y - 0.03, BED_Z - 0.16), (s * 1.24 + 0.02, y + 0.03, BED_Z - 0.1), "Lit", C["metal"])
    m.box((-1.2, BED_Y1 - 0.05, BED_Z), (1.2, BED_Y1, BED_Z + 0.8), "Lit", od)
    m.hexa([((1.18 if i & 1 else -1.18), BED_Y0 - (0.04 if i >> 1 & 1 else 0.0) - 0.0, (BED_Z - 0.05) - (0.55 if i >> 2 & 1 else 0)) for i in range(8)], "Lit", od)
    m.hexa([((1.18 if i & 1 else -1.18), BED_Y0 - 0.02 - (0.04 if i >> 1 & 1 else 0.0), (BED_Z - 0.05) - (0.55 if i >> 2 & 1 else 0)) for i in range(8)], "Lit", od)
    for s in (-1, 1):
        m.tube([(s * 1.1, BED_Y0, BED_Z + 0.4), (s * 1.12, BED_Y0 - 0.06, BED_Z), (s * 1.1, BED_Y0 - 0.05, BED_Z - 0.5)], 0.008, "Lit", C["metal"], segs=4, caps=False)
    # The bows.
    for by in BOWS:
        pts = []
        for k in range(15):
            (x, z), _ = tarp_profile(k / 14)
            pts.append((x * 0.985, by, z - 0.03))
        m.tube(pts, 0.022, "Lit", C["od_dark"], segs=5)
    # The tarp: over the bows, sagging between them; its side towards +x (the camp's front) rolled up to the
    # bows' shoulder, the rear's flaps rolled up; lashed down along the left side.
    roll_t = 0.80  # the profile's t where the rolled side ends

    def tarp_at(t, y):
        """A point of the tarp at the profile's t, y along, and its inward normal."""
        (x, z), (nx, nz) = tarp_profile(t)
        sag = between(y, sorted(BOWS + (BED_Y1 + 0.03, BED_Y0 - 0.0)))
        depth = 0.055 if z > 2.6 else 0.03
        x += nx * depth * sag
        z += nz * depth * sag
        # Wrinkles running down from the bows, and the lashing's pull at the bottom edge.
        x += 0.006 * math.sin(y * 17.0) * (1 if t < 0.3 else 0)
        if t < 0.04:
            z += 0.05 * sag
        return Vector((x, y, z)), Vector((nx, 0, nz))

    def tarp(u, v):
        return tarp_at(u * roll_t, BED_Y0 + v * (BED_Y1 - BED_Y0 + 0.03))[0]
    tc = mottle(C["tarp"], 0.08, 1.2)
    m.surface(tarp, 20, 28, "Lit", tc)
    # The rolled side.
    (rx, rz), _ = tarp_profile(roll_t)
    m.tube([(rx + 0.07, BED_Y1 + 0.02 - k * (BED_Y1 - BED_Y0) / 10, rz - 0.04 - 0.02 * math.sin(k)) for k in range(11)], 0.11, "Lit", mul(C["tarp"], 0.92), segs=8)
    for k in range(4):
        y = BED_Y1 - 0.4 - k * 1.1
        m.tube([(rx - 0.02, y, rz + 0.08), (rx + 0.2, y, rz - 0.02), (rx + 0.1, y, rz - 0.17), (rx - 0.02, y, rz - 0.1)], 0.012, "Lit", C["strap"], segs=4)
    # The front panel (closed) and the rear's top arch above the rolled flaps.
    def end_panel(y, z_from, flip):
        def f(u, v):
            (x, z), _ = tarp_profile(1 - u if flip else u)
            return Vector((x * 0.99, y, z_from + max(0.0, z - z_from) * v))
        return f
    m.surface(end_panel(BED_Y1 + 0.04, 1.65, True), 20, 3, "Lit", tc)
    m.surface(end_panel(BED_Y0, 2.68, False), 20, 2, "Lit", tc)
    m.tube([(-1.1 + k * 0.22, BED_Y0 - 0.06, 2.62 + 0.03 * math.sin(k * 1.3)) for k in range(11)], 0.1, "Lit", mul(C["tarp"], 0.9), segs=8)
    # Lashing: ropes from the tarp's bottom edge to the hooks, on the closed side.
    for k in range(7):
        y = BED_Y0 + 0.3 + k * 0.58
        m.tube([(-1.25, y, 1.64), (-1.255, y, 1.3), (-1.24, y, BED_Z - 0.13)], 0.008, "Lit", C["rope"], segs=4, caps=False)
    m.tube([(-1.26, BED_Y1, 1.7), (-1.26, BED_Y0, 1.7)], 0.008, "Lit", C["rope"], segs=4, caps=False)
    # The team's signal panel on the tarp's roof.
    def tpanel(u, v):
        p, n = tarp_at(0.42 + 0.3 * u, -2.6 + 1.9 * v)
        return p - n * 0.025
    m.surface(tpanel, 8, 8, "Team", C["white"])
    # The load: a pallet of ammunition boxes, crates, jerrycans.
    pallet(m, 0.2, -0.5, BED_Z + 0.02, 1.1, 1.1, "Lit")
    for i in range(3):
        for j in range(2):
            for k in range(2 if (i + j) % 2 == 0 else 1):
                ammo_box(m, -0.12 + i * 0.32, -0.75 + j * 0.45, BED_Z + 0.15 + k * 0.2, "Lit", yaw=0.0)
    crate(m, 0.35, -1.6, BED_Z + 0.02, 1.2, 0.5, 0.42, "Lit", yaw=math.pi / 2)
    crate(m, -0.35, -1.65, BED_Z + 0.02, 1.2, 0.5, 0.42, "Lit", yaw=math.pi / 2)
    crate(m, 0.0, -1.62, BED_Z + 0.44, 1.2, 0.5, 0.36, "Lit", yaw=math.pi / 2 + 0.05)
    for i in range(3):
        jerrycan(m, -0.85 + i * 0.2, -2.8, BED_Z + 0.02, "Lit")
    crate(m, 0.5, -2.75, BED_Z + 0.02, 0.8, 0.6, 0.5, "Lit")
    for i in range(4):
        ammo_box(m, 0.15 + (i % 2) * 0.32, -0.0 + (i // 2) * 0.2 + 0.05, BED_Z + 0.02, "Lit", yaw=math.pi / 2 * 0)
    # Rear: bumper, lamps, the pintle hook; mud flaps.
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.6, s * 1.15))
        m.box((x0, -3.42, 0.62), (x1, -3.3, 0.86), "Lit", C["od_dark"])
        m.box((s * 0.95 - 0.08, -3.44, 0.7), (s * 0.95 + 0.08, -3.42, 0.8), "Lit", C["red"])
        m.box((x0, -2.78, 0.22), (x1, -2.76, 0.95), "Lit", C["black"])
        m.box((x0, 1.48, 0.25), (x1, 1.5, 0.75), "Lit", C["black"])
    m.cyl((0, -3.3, 0.72), (0, -3.52, 0.72), 0.06, "Lit", C["metal"], segs=8)

    truck = m.join()
    bake(truck, reach=1.2, rays=36, lo=0.32, dirt=truck_dirt(1.4))
    return truck


def build_supply_far():
    m = Model("SupplyTruckFar")
    od = C["od"]
    m.box((-1.2, 1.95, 0.55), (1.2, 3.4, 1.62), "Lit", od)
    m.box((-1.1, 0.95, 0.75), (1.1, 1.95, 2.4), "Lit", od)
    m.box((-1.0, 1.95, 1.78), (1.0, 1.97, 2.32), "Lit", C["glass"])
    m.box((-1.22, BED_Y0, 0.75), (1.22, BED_Y1, 1.7), "Lit", od)
    pts = [tarp_profile(k / 6)[0] for k in range(7)]
    bm = bmesh.new()
    front = [bm.verts.new((x, BED_Y1 + 0.03, z)) for x, z in pts]
    back = [bm.verts.new((x, BED_Y0, z)) for x, z in pts]
    for k in range(6):
        bm.faces.new((front[k], front[k + 1], back[k + 1], back[k]))
    bm.faces.new(list(reversed(front)))
    bm.faces.new(back)
    m.add(bm, "Lit", C["tarp"])
    m.box((-0.8, -2.6, 2.9), (0.8, -0.9, 3.12), "Team", C["white"])
    for ay in S_AXLES:
        for s in (-1, 1):
            m.cyl((s * (S_X - S_W / 2), ay, S_R), (s * (S_X + S_W / 2), ay, S_R), S_R, "Lit", C["rubber"], segs=10)
    far = m.join()
    bake(far, reach=1.0, rays=20, lo=0.4, dirt=truck_dirt(1.2))
    return far


# =====================================================================================================
# SPAWN TRUCK (four wheels, a shelter body; a car of world/car.ts)
# =====================================================================================================
L, W, H = 7.2, 2.5, 3.3                 # shared/assaultFields.mjs TRUCK
WR, WW, WX = 0.52, 0.36, 0.93           # the wheels: radius, width, the middle of each from the truck's
F_AX, R_AX = 2.35, -2.1                 # the axles (Blender y: + forward); the game's TRUCK physics' spots
CAB_Y0, CAB_Y1 = 1.5, 3.36
CAB_Z0, BELT, CAB_TOP = 1.15, 1.95, 2.9
BOX_Y0, BOX_Y1, BOX_Z0 = -3.3, 1.42, 1.28


def cab_slant_y(z):
    """The cab's front face: upright below the belt line, leaning back 10 cm to the roof."""
    return CAB_Y1 if z <= BELT else CAB_Y1 - 0.1 * (z - BELT) / (CAB_TOP - BELT)


def cab_side_x(z):
    return 1.2 if z <= BELT else 1.2 - 0.07 * (z - BELT) / (CAB_TOP - BELT)


def build_spawn():
    m = Model("SpawnBody")
    od = mottle(C["od"], 0.07, 1.0)
    dk = C["od_dark"]
    # The frame and its cross members; axles with their differentials; leaf springs, shock absorbers; the
    # engine and gearbox under the cab; the drive shafts.
    for s in (-1, 1):
        m.box((s * 0.47 - 0.05, -3.3, 0.6), (s * 0.47 + 0.05, 3.3, 0.88), "Drab", dk)
    for cy in (3.0, 1.3, 0.0, -1.3, -2.9):
        m.box((-0.45, cy - 0.05, 0.64), (0.45, cy + 0.05, 0.84), "Drab", dk)
    for ay in (F_AX, R_AX):
        m.cyl((-0.74, ay, WR), (0.74, ay, WR), 0.065, "Drab", dk, segs=10)
        m.cyl((0.12, ay - 0.22, WR), (0.12, ay + 0.22, WR), 0.18, "Drab", dk, segs=12)
        m.cyl((0.12 - 0.22, ay, WR), (0.12 + 0.22, ay, WR), 0.2, "Drab", dk, segs=12)
        for s in (-1, 1):
            for k in range(3):
                z = WR + 0.07 + k * 0.03
                ln = 0.7 - k * 0.15
                m.hexa([(s * 0.47 + (0.045 if i & 1 else -0.045), ay + (ln if i >> 1 & 1 else -ln), z + (0.025 if i >> 2 & 1 else 0)) for i in range(8)], "Drab", C["metal"])
            m.cyl((s * 0.62, ay + 0.28, WR - 0.02), (s * 0.55, ay + 0.45, 0.84), 0.035, "Drab", C["metal"], segs=6)
    m.box((-0.42, 1.0, 0.72), (0.42, 3.0, 1.12), "Drab", C["metal"], bevel=0.03)
    m.cyl((0.12, 1.0, 0.75), (0.12, R_AX + 0.25, WR), 0.05, "Drab", C["metal"], segs=6)
    m.cyl((0.12, 1.5, 0.72), (0.12, F_AX - 0.25, WR), 0.05, "Drab", C["metal"], segs=6)
    # Front bumper, the winch on it and the shackles; the apron behind it.
    m.box((-1.22, 3.38, 0.58), (1.22, 3.6, 0.92), "Drab", od, bevel=0.02, slices=0.2)
    m.box((-0.62, 3.1, 0.88), (0.62, 3.38, 1.18), "Drab", dk)
    m.cyl((-0.3, 3.5, 1.04), (0.3, 3.5, 1.04), 0.12, "Drab", C["metal"], segs=14)
    for s in (-1, 1):
        m.box((s * 0.34 - 0.04, 3.38, 0.92), (s * 0.34 + 0.04, 3.6, 1.2), "Drab", dk)
        m.tube([(s * 0.85, 3.6, 0.64), (s * 0.85, 3.68, 0.68), (s * 0.85, 3.68, 0.82), (s * 0.85, 3.6, 0.86)], 0.026, "Drab", dk, segs=6)
    # The cab, over the front axle: a lower box and a glass-house leaning in, edges rounded.
    m.box((-1.2, CAB_Y0, CAB_Z0), (1.2, CAB_Y1, BELT), "Drab", od, bevel=0.04, slices=0.2)
    m.hexa([(cab_side_x(z) * (1 if i & 1 else -1), (cab_slant_y(z) if i >> 1 & 1 else CAB_Y0), z) for i in range(8) for z in [BELT if not i >> 2 & 1 else CAB_TOP]],
           "Drab", od, bevel=0.05)
    # Split windscreen: dark behind (the cab's inside), glass over it, the frame's centre post.
    def front_pane(x0, x1, z0, z1, off, mat, col):
        cs = []
        for i in range(8):
            z = z1 if i >> 2 & 1 else z0
            y = cab_slant_y(z) + off + (0.006 if i >> 1 & 1 else 0)
            cs.append((x1 if i & 1 else x0, y, z))
        m.hexa(cs, mat, col)
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.05, s * 1.04))
        front_pane(x0, x1, 2.05, 2.78, 0.0, "Interior", C["white"])
        front_pane(x0, x1, 2.05, 2.78, 0.006, "Glass", C["white"])
    # Side windows, the doors' lines and handles, the team's panel on each door.
    for s in (-1, 1):
        def side_pane(y0, y1, z0, z1, off, mat):
            cs = []
            for i in range(8):
                z = z1 if i >> 2 & 1 else z0
                x = s * (cab_side_x(z) + off + (0.006 if i & 1 else 0))
                cs.append((x, y1 if i >> 1 & 1 else y0, z))
            m.hexa(cs, mat, C["white"])
        side_pane(2.05, 3.15, 2.06, 2.74, 0.0, "Interior")
        side_pane(2.05, 3.15, 2.06, 2.74, 0.006, "Glass")
        side_pane(1.6, 1.92, 2.06, 2.74, 0.0, "Interior")
        side_pane(1.6, 1.92, 2.06, 2.74, 0.006, "Glass")
        xs = s * 1.2
        for y in (1.98, 3.22):
            m.box((xs - 0.006, y - 0.006, CAB_Z0 + 0.05), (xs + 0.006, y + 0.006, BELT), "Trim", C["white"])
        m.box((xs - 0.006, 1.98, CAB_Z0 + 0.05), (xs + 0.006, 3.22, CAB_Z0 + 0.062), "Trim", C["white"])
        hx0, hx1 = sorted((xs - s * 0.004, xs + s * 0.02))
        m.box((hx0, 2.0, 1.82), (hx1, 2.14, 1.86), "Trim", C["white"])
        x0, x1 = sorted((xs, xs + s * 0.005))
        m.box((x0, 2.12, 1.25), (x1, 3.12, 1.78), "Paint", C["white"])
    # Grille, headlights in their housings, marker lamps; the brush guard.
    for k in range(6):
        z = 1.24 + k * 0.1
        m.box((-0.58, CAB_Y1, z), (0.58, CAB_Y1 + 0.03, z + 0.05), "Trim", C["white"])
    for s in (-1, 1):
        m.cyl((s * 0.88, CAB_Y1 - 0.02, 1.4), (s * 0.88, CAB_Y1 + 0.07, 1.4), 0.135, "Trim", C["white"], segs=16)
        m.cyl((s * 0.88, CAB_Y1 + 0.07, 1.4), (s * 0.88, CAB_Y1 + 0.085, 1.4), 0.11, "LightBar", C["white"], segs=16)
        m.box((s * 0.88 - 0.06, CAB_Y1, 1.2), (s * 0.88 + 0.06, CAB_Y1 + 0.04, 1.25), "Reflector", C["white"])
        m.box((s * 1.1 - 0.05, CAB_Y1 - 0.12, CAB_TOP - 0.02), (s * 1.1 + 0.05, CAB_Y1 - 0.04, CAB_TOP + 0.04), "Reflector", C["white"])
    for x in (-1.1, -0.68, 0.68, 1.1):
        m.tube([(x, 3.55, 0.92), (x, 3.52, 1.25), (x, 3.47, 1.68)], 0.028, "Drab", dk, segs=6)
    m.tube([(-1.1, 3.47, 1.68), (1.1, 3.47, 1.68)], 0.028, "Drab", dk, segs=6)
    m.tube([(-0.68, 3.5, 1.4), (0.68, 3.5, 1.4)], 0.022, "Drab", dk, segs=6)
    # Square fenders over the front wheels, rubber flaps behind them.
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.64, s * 1.23))
        m.box((x0, F_AX - 0.72, 1.1), (x1, F_AX + 0.72, 1.15), "Drab", od, bevel=0.01)
        m.box((x0, F_AX - 0.74, 0.62), (x1, F_AX - 0.72, 1.12), "Trim", C["white"])
        m.box((x0, F_AX + 0.72, 0.92), (x1, F_AX + 0.76, 1.15), "Drab", od)
    # Mirrors on tubes; a step under each door; a grab handle; the roof's hatch ring and antenna with pennant;
    # the roof's team panel; the exhaust stack behind the cab.
    for s in (-1, 1):
        m.tube([(s * 1.18, 3.2, 2.45), (s * 1.48, 3.3, 2.45), (s * 1.48, 3.3, 2.15)], 0.016, "Drab", dk, segs=6)
        m.box((s * 1.48 - 0.07, 3.27, 2.15), (s * 1.48 + 0.07, 3.33, 2.62), "Trim", C["white"], bevel=0.01)
        m.box((s * 1.48 - 0.06, 3.265, 2.17), (s * 1.48 + 0.06, 3.27, 2.6), "Chrome", C["white"])
        x0, x1 = sorted((s * 0.95, s * 1.22))
        for z in (0.55, 0.85):
            m.box((x0, 1.38, z), (x1, 1.72, z + 0.04), "Drab", C["metal"])
        m.box((x1 - 0.02 if s > 0 else x0, 1.38, 0.5), (x1 if s > 0 else x0 + 0.02, 1.72, 0.92), "Drab", dk)
        m.tube([(s * 1.21, 1.52, 1.35), (s * 1.24, 1.52, 1.45), (s * 1.24, 1.52, 2.55), (s * 1.21, 1.52, 2.65)], 0.016, "Drab", dk, segs=6)
    m.cyl((0.45, 2.15, CAB_TOP - 0.02), (0.45, 2.15, CAB_TOP + 0.1), 0.34, "Drab", dk, segs=18)
    m.cyl((0.45, 2.15, CAB_TOP + 0.1), (0.45, 2.15, CAB_TOP + 0.13), 0.3, "Drab", od, segs=18)
    m.box((-0.95, 2.35, CAB_TOP - 0.01), (0.05, 3.15, CAB_TOP + 0.012), "Paint", C["white"])
    m.cyl((-1.0, 1.62, CAB_TOP), (-1.0, 1.62, CAB_TOP + 0.12), 0.04, "Drab", C["metal"], segs=8)
    m.cyl((-1.0, 1.62, CAB_TOP + 0.12), (-1.0, 1.62, CAB_TOP + 2.1), 0.009, "Trim", C["white"], segs=5)
    m.surface(lambda u, v: Vector((-1.0 + 0.004, 1.62 - u * 0.55, CAB_TOP + 2.02 - v * 0.3 * (1 - u * 0.85) - 0.04 * u + 0.02 * math.sin(u * 4))), 6, 2, "Paint", C["white"], both=0.008)
    m.cyl((1.05, 1.47, 1.0), (1.05, 1.47, 3.2), 0.06, "Trim", C["white"], segs=8)
    m.cyl((1.05, 1.47, 3.2), (1.05, 1.47, 3.26), 0.08, "Trim", C["white"], segs=8)
    m.box((0.98, 1.38, 1.6), (1.12, 1.4, 2.6), "Drab", dk)
    # The shelter: its subframe, the box itself with raised edge trims and corner castings, the team's band
    # round it, a vent, the air conditioner over the cab.
    m.box((-1.0, BOX_Y0, 1.12), (1.0, BOX_Y1, BOX_Z0), "Drab", dk)
    m.box((-1.22, BOX_Y0, BOX_Z0), (1.22, BOX_Y1, H), "Drab", od, bevel=0.03, slices=0.22)
    for x in (-1.225, 1.225):
        for y in (BOX_Y0 + 0.02, BOX_Y1 - 0.02):
            m.box((x - 0.03, y - 0.03, BOX_Z0), (x + 0.03, y + 0.03, H), "Drab", C["od_light"])
            for z in (BOX_Z0 + 0.06, H - 0.06):
                m.box((x - 0.06, y - 0.06, z - 0.06), (x + 0.06, y + 0.06, z + 0.06), "Drab", dk)
    for s in (-1, 1):
        m.box((-1.225, (BOX_Y0 if s < 0 else BOX_Y1) - 0.03, H - 0.05), (1.225, (BOX_Y0 if s < 0 else BOX_Y1) + 0.03, H + 0.01), "Drab", C["od_light"])
        x0, x1 = sorted((s * 1.22, s * 1.226))
        m.box((x0, BOX_Y0 + 0.25, 2.0), (x1, BOX_Y1 - 0.25, 2.48), "Paint", C["white"])
        m.box((s * 1.22 - 0.03, BOX_Y0, H - 0.05), (s * 1.22 + 0.03, BOX_Y1, H + 0.01), "Drab", C["od_light"])
    for k in range(6):
        m.box((1.222, 0.5, 2.62 + k * 0.06), (1.236, 1.0, 2.65 + k * 0.06), "Trim", C["white"])
    m.box((-0.5, BOX_Y1, 2.95), (0.5, BOX_Y1 + 0.22, 3.25), "Drab", od, bevel=0.02)
    for k in range(5):
        m.box((-0.4 + k * 0.2 - 0.06, BOX_Y1 + 0.22, 3.0), (-0.4 + k * 0.2 + 0.06, BOX_Y1 + 0.23, 3.2), "Trim", C["white"])
    # The rear: the door (a little proud, hinges, handle, small window),
    # folding steps with rails down to the ground, a ladder to the roof, the bumper with the tail lamps.
    ry = BOX_Y0
    m.box((-0.88, ry - 0.025, BOX_Z0 + 0.08), (0.06, ry, 3.0), "Drab", C["od_light"], bevel=0.01)
    m.box((-0.6, ry - 0.03, 2.4), (-0.22, ry - 0.025, 2.75), "Interior", C["white"])
    m.box((-0.6, ry - 0.034, 2.4), (-0.22, ry - 0.03, 2.75), "Glass", C["white"])
    for z in (1.5, 2.3, 2.85):
        m.box((-0.92, ry - 0.04, z), (-0.84, ry, z + 0.1), "Drab", dk)
    m.box((-0.05, ry - 0.06, 2.0), (0.0, ry - 0.025, 2.2), "Chrome", C["white"])
    for s in (-1, 1):
        x = -0.41 + s * 0.48
        m.tube([(x, ry - 0.03, BOX_Z0 + 0.04), (x, ry - 0.34, 0.42)], 0.025, "Drab", C["metal"], segs=6)
        m.tube([(x, ry - 0.03, 2.65), (x, ry - 0.09, 2.6), (x, ry - 0.09, 1.55), (x, ry - 0.03, 1.5)], 0.018, "Drab", dk, segs=6)
    for k in range(3):
        t = (k + 0.5) / 3
        y = ry - 0.03 - 0.31 * t
        z = BOX_Z0 + 0.04 + (0.42 - BOX_Z0 - 0.04) * t
        m.box((-0.87, y - 0.09, z - 0.02), (0.05, y + 0.09, z + 0.02), "Drab", C["metal"])
    for x in (0.62, 0.98):
        m.cyl((x, ry - 0.08, BOX_Z0 + 0.1), (x, ry - 0.08, H + 0.35), 0.02, "Drab", dk, segs=6)
        m.box((x - 0.02, ry - 0.08, BOX_Z0 + 0.1), (x + 0.02, ry, BOX_Z0 + 0.14), "Drab", dk)
    for k in range(7):
        z = BOX_Z0 + 0.35 + k * 0.28
        m.cyl((0.62, ry - 0.08, z), (0.98, ry - 0.08, z), 0.014, "Drab", dk, segs=5)
    for s in (-1, 1):
        x0, x1 = (-1.22, -0.92) if s < 0 else (0.12, 1.22)
        m.box((x0, ry - 0.14, 0.62), (x1, ry, 0.92), "Drab", od, slices=0.1)
        lx = s * 1.02
        m.box((lx - 0.1, ry - 0.155, 0.72), (lx + 0.1, ry - 0.14, 0.86), "TailLight", C["white"])
        m.box((lx - 0.05 - s * 0.17, ry - 0.155, 0.74), (lx + 0.05 - s * 0.17, ry - 0.14, 0.84), "Reflector", C["white"])
    m.box((-0.5, ry - 0.2, 0.55), (-0.3, ry, 0.65), "Drab", C["metal"])
    # Rear fenders and mud flaps; between the axles a fuel tank on the left, a toolbox and two jerrycans in
    # their rack on the right.
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.66, s * 1.2))
        m.box((x0, R_AX - 0.66, 1.1), (x1, R_AX + 0.66, 1.14), "Drab", od)
        m.box((x0, R_AX - 0.66, 0.24), (x1, R_AX - 0.63, 1.1), "Trim", C["white"])
    m.cyl((-1.02, -0.9, 0.85), (-1.02, 0.7, 0.85), 0.24, "Drab", od, segs=16)
    for ty in (-0.6, 0.4):
        m.cyl((-1.02, ty, 0.85), (-1.02, ty + 0.04, 0.85), 0.25, "Drab", C["metal"], segs=16)
    m.cyl((-1.02, 0.45, 1.09), (-1.02, 0.45, 1.13), 0.05, "Drab", C["metal"], segs=8)
    m.box((0.72, -1.25, 0.6), (1.2, -0.35, 1.06), "Drab", od, bevel=0.02)
    m.box((1.2, -1.15, 0.85), (1.215, -0.45, 0.9), "Drab", dk)
    jerrycan(m, 1.0, 0.05, 0.62)
    jerrycan(m, 1.0, 0.45, 0.62)
    m.tube([(0.8, -0.18, 0.6), (1.2, -0.18, 0.6), (1.2, 0.68, 0.6), (0.8, 0.68, 0.6)], 0.015, "Drab", dk, segs=5, caps=False)
    m.tube([(1.2, -0.18, 0.95), (1.2, 0.68, 0.95)], 0.015, "Drab", dk, segs=5)
    # The roof rack: posts, the rail round it, slats; on it the rolled camouflage net, the spare wheel lying
    # flat, two jerrycans and the team's signal panel.
    rz = H + 0.12
    for y in (BOX_Y0 + 0.15, -1.6, 0.0, BOX_Y1 - 0.15):
        for s in (-1, 1):
            m.box((s * 1.1 - 0.025, y - 0.025, H), (s * 1.1 + 0.025, y + 0.025, rz), "Drab", dk)
        m.box((-1.1, y - 0.03, rz - 0.03), (1.1, y + 0.03, rz), "Drab", dk)
    m.tube([(-1.1, BOX_Y0 + 0.15, rz + 0.1), (1.1, BOX_Y0 + 0.15, rz + 0.1), (1.1, BOX_Y1 - 0.15, rz + 0.1), (-1.1, BOX_Y1 - 0.15, rz + 0.1), (-1.1, BOX_Y0 + 0.15, rz + 0.1)], 0.02, "Drab", dk, segs=6, caps=False)
    for k in range(8):
        y = BOX_Y0 + 0.3 + k * (BOX_Y1 - BOX_Y0 - 0.6) / 7
        for s in (-1, 1):
            m.cyl((s * 1.1, y, rz - 0.01), (s * 1.1, y, rz + 0.1), 0.012, "Drab", dk, segs=4)
    for k in range(10):
        x = -1.0 + k * 0.222
        m.box((x - 0.04, BOX_Y0 + 0.15, rz - 0.005), (x + 0.04, BOX_Y1 - 0.15, rz + 0.01), "Drab", dk)
    pts = [(-0.55 + 0.02 * math.sin(k * 1.7), BOX_Y0 + 0.4 + k * 0.26, rz + 0.22 + 0.015 * math.sin(k * 2.3)) for k in range(10)]
    m.tube(pts, 0.21, "Drab", camo, segs=10)
    for k in (1, 4, 8):
        m.cyl((pts[k][0], pts[k][1] - 0.025, pts[k][2]), (pts[k][0], pts[k][1] + 0.025, pts[k][2]), 0.222, "Drab", C["strap"], segs=10)
    mm = Model("spare")
    tyre(mm, 0, 0, 0, WR, WW, "Drab", segs=24, lugs=18)
    R = Matrix.Translation((0.45, -2.0, rz + 0.2)) @ Matrix.Rotation(math.pi / 2, 4, "Y")
    for o in mm.parts:
        o.data.transform(R)
        m.parts.append(o)
    jerrycan(m, 0.3, -0.95, rz, yaw=math.pi / 2)
    jerrycan(m, 0.75, -0.95, rz, yaw=math.pi / 2)
    m.box((-1.0, -0.3, rz + 0.012), (0.95, 1.1, rz + 0.025), "Paint", C["white"])
    body = m.join()
    return body


def build_wheel():
    m = Model("TruckWheel")
    tyre(m, 0, 0, 0, WR, WW, "Drab", segs=28, lugs=20)
    return m.join()


def build_spawn_far():
    m = Model("Far")
    od = C["od"]
    m.box((-1.2, CAB_Y0, CAB_Z0), (1.2, CAB_Y1, CAB_TOP), "Drab", od)
    m.box((-1.0, CAB_Y1, 2.05), (1.0, CAB_Y1 + 0.01, 2.78), "Glass", C["white"])
    m.box((-1.22, 3.38, 0.58), (1.22, 3.6, 0.92), "Drab", od)
    m.box((-1.22, BOX_Y0, BOX_Z0), (1.22, BOX_Y1, H), "Drab", od)
    m.box((-1.0, BOX_Y0, 0.62), (1.0, 3.38, BOX_Z0), "Drab", C["od_dark"])
    for s in (-1, 1):
        x0, x1 = sorted((s * 1.22, s * 1.228))
        m.box((x0, BOX_Y0 + 0.25, 2.0), (x1, BOX_Y1 - 0.25, 2.48), "Paint", C["white"])
        m.box((x0, 2.12, 1.25), (x1, 3.12, 1.78), "Paint", C["white"])
        m.box((s * 0.88 - 0.11, CAB_Y1, 1.3), (s * 0.88 + 0.11, CAB_Y1 + 0.01, 1.5), "LightBar", C["white"])
        m.box((s * 1.02 - 0.1, BOX_Y0 - 0.01, 0.72), (s * 1.02 + 0.1, BOX_Y0, 0.86), "TailLight", C["white"])
        for ay in (F_AX, R_AX):
            m.cyl((s * (WX - WW / 2), ay, WR), (s * (WX + WW / 2), ay, WR), WR, "Drab", mix(C["rubber"], C["dust"], 0.2), segs=10)
    m.box((-1.0, -0.3, H), (0.95, 1.1, H + 0.03), "Paint", C["white"])
    far = m.join()
    bake(far, reach=1.0, rays=20, lo=0.4, dirt=truck_dirt(1.4))
    return far


# =====================================================================================================
# Build, shade, export.
# =====================================================================================================
tent = build_tent()
tent_far = build_tent_far()
supply = build_supply()
supply_far = build_supply_far()

body = build_spawn()
wheel_obj = build_wheel()
bake(wheel_obj, reach=0.35, rays=24, lo=0.45, ground=False, dirt=lambda p, n: 0.2)
wheel_me = wheel_obj.data
bpy.data.objects.remove(wheel_obj)
far = build_spawn_far()

root = link(bpy.data.objects.new("SpawnTruck", None))
body.parent = root
far.parent = root
wheels = []
for name, s, ay in (("Wheel_FL", -1, F_AX), ("Wheel_FR", 1, F_AX), ("Wheel_RL", -1, R_AX), ("Wheel_RR", 1, R_AX)):
    w = link(bpy.data.objects.new(name, wheel_me))
    w.location = (s * WX, ay, WR)
    if s < 0:
        w.rotation_euler = (0, 0, math.pi)  # the wheel's face looks out on the left too
    w.parent = root
    wheels.append(w)
bpy.context.view_layer.update()
bake(body, blockers=wheels, reach=1.2, rays=36, lo=0.32, dirt=truck_dirt(1.45))

for o, label in ((tent, "tent"), (tent_far, "tent far"), (supply, "supply truck"), (supply_far, "supply far"), (body, "spawn body"), (far, "spawn far")):
    print(f"camp: {label} {triangles(o)} triangles, {len(o.data.materials)} materials")
print(f"camp: spawn wheel {triangles(wheels[0])} triangles each")

everything = [tent, tent_far, supply, supply_far, root, body, far, *wheels]
bpy.ops.object.select_all(action="DESELECT")
for o in everything:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False,
                          export_vertex_color="ACTIVE", export_all_vertex_colors=False)
print(f"camp: {os.path.getsize(OUT)} bytes")


# ---- Previews: each model alone under a plain sky, the sun and a grass-coloured ground.
if PREVIEW:
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 16
    scene.render.resolution_x, scene.render.resolution_y = 800, 450
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.65, 0.8, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(35)))
    bpy.context.active_object.data.energy = 3.5
    bpy.ops.mesh.primitive_plane_add(size=200)
    g = bpy.data.materials.new("Ground")
    g.use_nodes = True
    g.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*lin("#4a5a2c"), 1)
    bpy.context.active_object.data.materials.append(g)
    for name, mt in MATS.items():
        nt = mt.node_tree
        p = nt.nodes["Principled BSDF"]
        if name == "Glass":
            p.inputs["Alpha"].default_value = 0.86
            if hasattr(mt, "surface_render_method"):
                mt.surface_render_method = "BLENDED"
        if name not in VERTEX_COLOURED:
            continue
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = "Col"
        mx = nt.nodes.new("ShaderNodeMix")
        mx.data_type = "RGBA"
        mx.blend_type = "MULTIPLY"
        mx.inputs["Factor"].default_value = 1.0
        mx.inputs[6].default_value = p.inputs["Base Color"].default_value
        nt.links.new(attr.outputs["Color"], mx.inputs[7])
        nt.links.new(mx.outputs[2], p.inputs["Base Color"])
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    groups = {"tent": [tent], "tentfar": [tent_far], "supply": [supply], "supplyfar": [supply_far], "spawn": [body, *wheels], "spawnfar": [far]}
    views = {
        "tent": (("front3q", (7.5, 10.5, 3.2), (0, 0, 1.4), 35), ("left", (-9.5, 2.5, 2.4), (0, 0, 1.3), 35), ("air", (12, 14, 16), (0, 0, 1), 35), ("door", (0.6, 6.0, 1.7), (-0.4, 0, 1.0), 30)),
        "tentfar": (("front3q", (7.5, 10.5, 3.2), (0, 0, 1.4), 35),),
        "supply": (("front3q", (6.5, 8.5, 2.6), (0, 0, 1.4), 35), ("open", (7.5, -2.0, 2.4), (0, -1.2, 1.5), 35), ("rear3q", (-4.5, -8.5, 2.6), (0, -1, 1.4), 35), ("air", (10, 12, 14), (0, 0, 1), 35)),
        "supplyfar": (("front3q", (6.5, 8.5, 2.6), (0, 0, 1.4), 35),),
        "spawn": (("front3q", (6.5, 9.0, 2.6), (0, 0.3, 1.5), 35), ("rear3q", (-5.0, -9.0, 2.8), (0, -0.5, 1.5), 35), ("side", (11, 0, 1.8), (0, 0, 1.5), 40), ("under", (4.0, 1.0, 0.5), (0, 0, 0.7), 35), ("air", (10, 12, 14), (0, 0, 1), 35)),
        "spawnfar": (("front3q", (6.5, 9.0, 2.6), (0, 0.3, 1.5), 35),),
    }
    allobjs = [o for objs in groups.values() for o in objs]
    for key, objs in groups.items():
        for o in allobjs:
            o.hide_render = o not in objs
        for label, at, look, lens in views[key]:
            cam.location = at
            cam.data.lens = lens
            cam.rotation_euler = (Vector(look) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = os.path.join(PREVIEW, f"{key}-{label}.png")
            bpy.ops.render.render(write_still=True)
