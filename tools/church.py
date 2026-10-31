"""Build the Sint-Pharaïldiskerk of Smetlede (Lede, East Flanders) in Blender, for the walkthrough.

Run (Blender 5, no window), from the project root:
  blender -b -P tools/church.py -- <out.glb> [preview_dir [cameras.json [context.json]]]

Our own model of the parish church on the square of Smetlede (Smetlededorp 1). A neoclassical
cruciform church in red brick on a chamfered sandstone plinth under slate roofs: a square west
tower under a bell-cast octagonal slate spire with a small gable on each face, a single nave of four bays
(1825), a transept, a choir of one bay with a flat east end and a sacristy either side of it
(1897). Sources, used for measuring only (nothing of them is shipped):
- the plan: GRB building outline 9757729 (Digitaal Vlaanderen, WFS GRB:GBG, Lambert 72);
- the heights: DHM Vlaanderen II laser scan, 1 m, surface minus terrain: ridges at 12.45 m,
  eaves of nave, transept, choir and sacristies, the tower's top and the lower part of the spire;
- the design drawings for the enlargement of 1896 in the heritage image bank (Onroerend Erfgoed,
  KCML archive O0680, O0681, scale 1:100): tower 0.80 + 3.42 m deep, nave 9.55 m wide inside with
  four windows a side, transept 8.10 m with a 2.00 m window in each gable, sacristy windows;
- the inventory text (erfgoedobject 9162): segmental-arched windows in cement surrounds with
  ears and a curved drip moulding, bluestone sills, iron window armatures, a round-arched west
  door between Tuscan pilasters, paired round-arched belfry openings, quoins on the tower, a
  calvary chapel beside the tower;
- photos of the south side (Onroerend Erfgoed 2007; Wikimedia Commons 2011, 2012) with a camera
  solved on the plan: tower cornice 16.0 m, spire to 25.4 m, ball 26.4 m, weathercock 29.6 m,
  the window heights and spacing, the colours.
No clock faces: none of the photos shows one.

Model space (Blender): x along the church's axis towards the choir (east), y to the north, z up;
in the GLB (y up) that is x east, y up, z south. The origin is on the church's axis level with the
middle of the GRB outline, at the ground height there (29.99 m TAW). In Lambert 72 the origin is
at (119018.719, 184084.237) and the model's +x points along the bearing 6.40 degrees north of
grid east (model +y 6.40 degrees west of grid north). The ground falls about 0.9 m from the west
door to the south-east corner, so walls and plinth run down to z = -1.2 below the origin. In the
game's frame (tools/neighbours.py, model_frame) that puts the GLB at x 521.51, z -744.15, turned
by 2.5250 rad (144.67 degrees) about y; its ground is 5.99 m above the plot's (TAW 24.0 m).

Output: one GLB with one mesh per material, so six draw calls:
- church_brick, church_stone, church_trim: UVs in metres. Their glTF extras name a shared game
  texture and its tint ({"texture": "nb_brick", "tint": "#..."}); the base colour is the mean
  colour of the result, for a loader that keeps the GLB's own material.
- church_slate: roofs and spire, with its own 512 px slate texture (UVs in tiles of 1.2 m).
- church_glass: the leaded windows behind their iron armature, with a 128 px texture per panel.
- church_fittings: gutters and verge flashings painted wine red, doors, louvres, downpipes,
  crosses and the weathercock, coloured per vertex.
With preview_dir it renders daylight views from the square there under the game's sky photo, and
every camera in cameras.json (a list of {name, pos, yaw, pitch, roll, f_px, w, h, cx, cy}: the
position in model metres, the view direction in degrees, the focal length and principal point in
pixels) for side-by-side comparisons with photos. context.json can add the neighbouring
buildings as plain massing ({outline, eaves, ridge, rect, long, flat} each, in the same frame).
"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""
CAMERAS = argv[2] if len(argv) > 2 else ""
CONTEXT = argv[3] if len(argv) > 3 else ""
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------- measurements (metres)
GR = -1.2                    # walls and plinth start this far below the origin
PLINTH = 0.85                # top of the sandstone plinth
RIDGE = 12.45                # nave, transept and choir ridges (laser scan)
# Plan, from the GRB outline (local frame, axis on y = 0)
NAVE_X0, NAVE_HW = -16.15, 5.42
TR_X0, TR_X1, TR_HW = 0.38, 8.48, 8.49
CROSS_X = (TR_X0 + TR_X1) / 2
CH_X1, CH_HW = 14.62, 3.67
SA_X1, SA_Y1 = 14.15, 8.0
TW_X0, TW_X1, TW_HW = -18.18, -13.68, 2.25
TW_CX = (TW_X0 + TW_X1) / 2
AN_Y0, AN_Y1 = -NAVE_HW, -TW_HW          # the calvary chapel south of the tower
# Heights of the roof surface at the wall face (laser scan and photos)
NAVE_E, TR_E, CH_E, SA_E, SA_RIDGE = 7.2, 8.3, 8.75, 4.15, 5.95
AN_E, AN_TOP = 3.3, 5.95
TW_TOP, TW_GABLE, KINK, TIP = 16.0, 17.05, 18.4, 25.36
OVER = 0.3                   # eaves overhang
SLATE_TILE = 1.2             # metres per slate texture tile


def srgb(h):
    """'#rrggbb' to linear RGB."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


# ---------------------------------------------------------------- materials
bpy.ops.wm.read_factory_settings(use_empty=True)
# Shared game textures (web/public/textures, metres per tile in sizes.json) and the tint that gives
# the photos' colours: brick 138/84/66, plinth sandstone 140/133/111, cement surrounds 200/185/160.
SHARED = {
    "church_brick": ("nb_brick", "#905d4c", 1.0, "#73483a"),
    "church_stone": ("concrete", "#dcd4c8", 0.6, "#796e55"),
    "church_trim": ("plaster", "#cdbd9f", 0.35, "#c2b498"),
}
PAINT = {  # vertex colours of the fittings (sRGB)
    "wine": "#7e4c55", "wood": "#4a3326", "louvre": "#3e3a36", "metal": "#2e2f31", "zinc": "#8f918f",
    "gilt": "#a8843f", "dark": "#2a2624", "white": "#e9e5dc",
}
M = {}


def principled(name, color, rough, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True
    return m


for name, (tex, tint, nscale, mean) in SHARED.items():
    M[name] = principled(name, srgb(mean), 0.9)
    M[name]["texture"], M[name]["tint"], M[name]["normalScale"] = tex, tint, nscale


def image_material(name, pixels, size, rough, metal=0.0):
    """A material with a generated colour texture (sRGB pixels, rows from the bottom)."""
    img = bpy.data.images.new(name, size[0], size[1], alpha=False)
    rgba = np.concatenate([pixels, np.ones(pixels.shape[:2] + (1,), np.float32)], axis=2)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.pack()
    m = principled(name, (1, 1, 1), rough, metal)
    nt = m.node_tree
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    t.interpolation = "Linear"
    nt.links.new(t.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    return m


def slate_texture(n=512, seed=11):
    """Small dark blue-grey slates, 7 courses and 5 slates a course per 1.2 m tile, each a little
    lighter or darker, a shadow under each course and a thin joint between slates."""
    rng = np.random.default_rng(seed)
    rows, cols = 7, 5
    y, x = np.mgrid[0:n, 0:n] / n
    r = np.floor(y * rows).astype(int)
    fy = y * rows - r
    xs = x * cols + 0.5 * (r % 2)
    c = np.floor(xs).astype(int) % cols
    fx = xs - np.floor(xs)
    tone = rng.normal(0, 0.055, (rows, cols))[r, c] + rng.normal(0, 0.012, (n, n))
    base = np.array(srgb("#444345"))
    lum = 1 + tone
    lum *= 1 - 0.45 * np.clip((fy - 0.86) / 0.14, 0, 1) ** 2     # shadow under the next course's edge
    lum *= np.where((fx < 0.012) | (fx > 0.988), 0.6, 1.0)        # joints
    lum *= 1 + 0.08 * np.clip((0.1 - fy) / 0.1, 0, 1)            # a slate's lower edge catches a little light
    lin = np.clip(base[None, None, :] * lum[..., None], 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)


def glass_texture(n=128, seed=5):
    """One panel of a leaded window between its iron bars: diamond quarries of dark cathedral glass
    (greenish grey, each pane a little different) in lead cames, the light grey iron armature along
    the panel's bottom and left edge (the windows tile it, so the bars run between panels)."""
    rng = np.random.default_rng(seed)
    y, x = (np.mgrid[0:n, 0:n] + 0.5) / n
    a, b = x + y, x - y          # diamond lattice, two quarries across a panel
    ia, ib = np.floor(a * 2), np.floor(b * 2)
    tone = rng.normal(0, 0.10, (8, 8))[(ia.astype(int) + 4) % 8, (ib.astype(int) + 4) % 8]
    glass = np.array([0.040, 0.050, 0.052]) * (1 + tone)[..., None]
    glass = glass * (0.85 + 0.3 * y)[..., None]                      # the sky's reflection, lighter at the top
    lead = (np.abs(a * 2 - np.round(a * 2)) < 0.035) | (np.abs(b * 2 - np.round(b * 2)) < 0.035)
    lin = np.where(lead[..., None], np.array([0.075, 0.075, 0.072]), glass)
    bar = (x < 0.035) | (y < 0.035)
    lin = np.where(bar[..., None], np.array([0.16, 0.16, 0.155]), lin)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)


M["church_slate"] = image_material("church_slate", slate_texture(), (512, 512), 0.78)
M["church_glass"] = image_material("church_glass", glass_texture(), (128, 128), 0.22)
M["church_fittings"] = principled("church_fittings", (1, 1, 1), 0.55, 0.15)
fit_nt = M["church_fittings"].node_tree
attr = fit_nt.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Color"
fit_nt.links.new(attr.outputs["Color"], fit_nt.nodes["Principled BSDF"].inputs["Base Color"])

PARTS = {k: [] for k in M}   # objects per material, joined at the end


# ---------------------------------------------------------------- geometry helpers
def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def to_object(bm, name, mat, paint=None, recalc=True):
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if paint is not None:
        lay = bm.loops.layers.float_color.new("Color")
        col = (*srgb(PAINT[paint]), 1.0)
        for f in bm.faces:
            for lp in f.loops:
                lp[lay] = col
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(M[mat])
    return link(bpy.data.objects.new(name, me))


def add(obj, mat):
    PARTS[mat].append(obj)
    return obj


def hull(name, pts, mat, paint=None):
    """The convex solid round a set of points."""
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=bm.verts[:])
    bmesh.ops.delete(bm, geom=[g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)],
                     context="VERTS")
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), verts=bm.verts[:], edges=bm.edges[:])
    return to_object(bm, name, mat, paint)


def box(name, x0, y0, z0, x1, y1, z1, mat, paint=None):
    return hull(name, [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)], mat, paint)


def section_prism(name, section, axis, a0, a1, mat, paint=None, shift=0.0):
    """A prism of a closed section, extruded along an axis: section points (b, z), where b is y for
    axis 'x' and x for axis 'y' (plus `shift`); it runs from a0 to a1 along the axis."""
    bm = bmesh.new()
    pt = (lambda a, b, z: (a, b + shift, z)) if axis == "x" else (lambda a, b, z: (b + shift, a, z))
    v0 = [bm.verts.new(pt(a0, b, z)) for b, z in section]
    v1 = [bm.verts.new(pt(a1, b, z)) for b, z in section]
    n = len(section)
    for i in range(n):
        bm.faces.new((v0[i], v0[(i + 1) % n], v1[(i + 1) % n], v1[i]))
    bm.faces.new(v0)
    bm.faces.new(v1[::-1])
    return to_object(bm, name, mat, paint)


def plan_prism(name, outline, z0, z1, mat, paint=None):
    """A vertical prism of a plan outline (x, y)."""
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, z0)) for x, y in outline]
    hi = [bm.verts.new((x, y, z1)) for x, y in outline]
    n = len(outline)
    for i in range(n):
        bm.faces.new((lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i]))
    bm.faces.new(lo[::-1])
    bm.faces.new(hi)
    return to_object(bm, name, mat, paint)


def cylinder(name, p0, p1, r, mat, paint=None, seg=8):
    p0, p1 = Vector(p0), Vector(p1)
    d = (p1 - p0).normalized()
    u = d.orthogonal().normalized()
    w = d.cross(u)
    pts = []
    for k in range(seg):
        a = 2 * math.pi * k / seg
        off = (u * math.cos(a) + w * math.sin(a)) * r
        pts += [p0 + off, p1 + off]
    return hull(name, pts, mat, paint)


def sphere(name, c, r, mat, paint=None, seg=10, rings=6):
    pts = [(c[0], c[1], c[2] - r), (c[0], c[1], c[2] + r)]
    for i in range(1, rings):
        t = math.pi * i / rings
        for k in range(seg):
            a = 2 * math.pi * k / seg
            pts.append((c[0] + r * math.sin(t) * math.cos(a), c[1] + r * math.sin(t) * math.sin(a), c[2] - r * math.cos(t)))
    return hull(name, pts, mat, paint)


def modify(obj, kind, **props):
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)
    return obj


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    obj = objs[0]
    obj.name = obj.data.name = name
    obj.select_set(False)
    return obj


def boolean(obj, others, operation):
    """Union or subtract other solids (joined into one cutter first), with the exact solver."""
    if not others:
        return obj
    other = join(others, obj.name + "_cut")
    modify(obj, "BOOLEAN", operation=operation, solver="EXACT", object=other, use_self=True, use_hole_tolerant=True)
    bpy.data.objects.remove(other)
    return obj


def union(objs, name):
    first = objs[0]
    boolean(first, objs[1:], "UNION")
    first.name = first.data.name = name
    return first


class Face:
    """A wall face: a point on it, the horizontal direction to the right seen from outside, and
    the outward normal. Local coordinates (s, z, d): along the wall, up, out of the wall."""

    def __init__(self, origin, right, normal):
        self.o, self.t, self.n = Vector(origin), Vector(right), Vector(normal)

    def p(self, s, z, d=0.0):
        return self.o + self.t * s + Vector((0, 0, z)) + self.n * d


def face_x(x, sign):
    """The wall face x = const facing +x (sign 1) or -x (sign -1)."""
    return Face((x, 0, 0), (0, sign, 0), (sign, 0, 0))


def face_y(y, sign):
    """The wall face y = const facing +y (sign 1) or -y (sign -1)."""
    return Face((0, y, 0), (-sign, 0, 0), (0, sign, 0))


def drop_back(bm, face, d0):
    """Turn the faces outward, then delete those lying against the wall at depth d0 (never seen)."""
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    back = [f for f in bm.faces if f.normal.dot(face.n) < -0.99 and abs((f.calc_center_median() - face.o).dot(face.n) - d0) < 1e-4]
    bmesh.ops.delete(bm, geom=back, context="FACES")


def outline_prism(name, face, outline, d0, d1, mat, paint=None, back=True):
    """A prism of an outline (s, z) on a wall face, from depth d0 to d1; without its back face
    (against the wall) when back is False."""
    bm = bmesh.new()
    a = [bm.verts.new(face.p(s, z, d0)) for s, z in outline]
    b = [bm.verts.new(face.p(s, z, d1)) for s, z in outline]
    n = len(outline)
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    bm.faces.new(a)
    bm.faces.new(b[::-1])
    if not back:
        drop_back(bm, face, d0)
    return to_object(bm, name, mat, paint, recalc=back)


def band_prism(name, face, inner, outer, d0, d1, mat, paint=None, back=False):
    """An open band between two matching paths (s, z) on a wall face, from depth d0 to d1 (a
    window surround round the sides and top, a drip moulding); its back against the wall left out."""
    bm = bmesh.new()
    rings = [[bm.verts.new(face.p(s, z, d)) for s, z in path] for path in (inner, outer) for d in (d0, d1)]
    i0, i1, o0, o1 = rings
    for k in range(len(inner) - 1):
        for a, b in ((i1, o1), (o0, i0), (i0, i1), (o1, o0)):   # front, back, inner side, outer side
            bm.faces.new((a[k], a[k + 1], b[k + 1], b[k]))
    for k in (0, len(inner) - 1):
        bm.faces.new((i0[k], i1[k], o1[k], o0[k]))
    if not back:
        drop_back(bm, face, d0)
    return to_object(bm, name, mat, paint, recalc=back)


def arch(w, h, rise, n=8, grow=0.0):
    """The top of an opening of width w whose crown is at h, from the right springing to the left
    one, as a segmental arch of this rise (a semicircle when the rise is w / 2). `grow` gives the
    concentric arch that far outside, for surrounds and mouldings."""
    hw = w / 2
    if rise <= 0:
        return [(hw + grow, h + grow), (-hw - grow, h + grow)]
    r = (hw * hw + rise * rise) / (2 * rise)
    zc = h - r
    a0 = math.atan2(h - rise - zc, hw)
    rr = r + grow
    out = []
    for k in range(n + 1):
        a = a0 + (math.pi - 2 * a0) * k / n
        out.append((rr * math.cos(a), zc + rr * math.sin(a)))
    if grow:  # the outer arch meets the widened sides where the sides are at hw + grow
        out[0] = (hw + grow, zc + math.sqrt(max(rr * rr - (hw + grow) ** 2, 0)))
        out[-1] = (-hw - grow, out[0][1])
    return out


BRICK_CUTS, STONE_CUTS = [], []   # openings, subtracted from the brick and the plinth at the end
GLASS_UV = []                     # per glass object: (object, face, left s, bottom z, panel width, panel height)


def window(face, s, z0, w, h, rise, surround=0.27, hood=True, ears=True, sill=True, panel=0.36, recess=0.2,
           glass=True, n=8):
    """A window in a wall face: glass from z0 to the crown at z0 + h, w wide, centred at s; a
    cement surround round the sides and top with ears at the top corners, a curved drip moulding
    over it and a bluestone sill."""
    f = Face(face.p(s, 0), face.t, face.n)
    top = arch(w, z0 + h, rise, n)
    opening = [(-w / 2, z0), (w / 2, z0)] + top
    BRICK_CUTS.append(outline_prism("cut", f, opening, 0.3, -recess - 0.05, "church_brick"))
    if glass:
        bm = bmesh.new()
        vs = [bm.verts.new(f.p(a, b, -recess)) for a, b in opening]
        bm.faces.new(vs)
        g = to_object(bm, "glass", "church_glass", recalc=False)
        if (g.data.polygons[0].normal - f.n).length > 1:
            g.data.flip_normals()
        cols = max(1, round(w / panel))
        GLASS_UV.append((g, f, -w / 2, z0, w / cols, panel * 1.1))
        add(g, "church_glass")
    if surround:
        inner = [(w / 2, z0 - 0.01)] + top + [(-w / 2, z0 - 0.01)]
        outer = [(w / 2 + surround, z0 - 0.01)] + arch(w, z0 + h, rise, n, surround) + [(-w / 2 - surround, z0 - 0.01)]
        add(band_prism("surround", f, inner, outer, -0.02, 0.035, "church_trim"), "church_trim")
        crown = arch(w, z0 + h, rise, n, surround)
        if hood:
            add(band_prism("hood", f, crown, arch(w, z0 + h, rise, n, surround + 0.07), -0.02, 0.07, "church_trim"), "church_trim")
        if ears:
            zs = crown[0][1]
            for sg in (1, -1):
                x0, x1 = sorted((sg * (w / 2 + surround - 0.02), sg * (w / 2 + surround + 0.07)))
                add(outline_prism("ear", f, [(x0, zs - 0.34), (x1, zs - 0.34), (x1, zs + 0.02), (x0, zs + 0.02)], -0.02, 0.035,
                                  "church_trim", back=False), "church_trim")
    if sill:
        e = w / 2 + surround + 0.04
        add(outline_prism("sill", f, [(-e, z0 - 0.13), (e, z0 - 0.13), (e, z0 - 0.01), (-e, z0 - 0.01)], -recess, 0.07,
                          "church_stone"), "church_stone")


def vent(face, s, z0, h, w=0.16):
    """A narrow slot in a gable with a stone lintel and sill."""
    f = Face(face.p(s, 0), face.t, face.n)
    BRICK_CUTS.append(outline_prism("cut", f, [(-w / 2, z0), (w / 2, z0), (w / 2, z0 + h), (-w / 2, z0 + h)], 0.3, -0.25,
                                    "church_brick"))
    for zz in (z0 - 0.1, z0 + h):
        add(outline_prism("vstone", f, [(-0.2, zz), (0.2, zz), (0.2, zz + 0.1), (-0.2, zz + 0.1)], -0.02, 0.04,
                          "church_trim", back=False), "church_trim")
    add(outline_prism("vback", f, [(-w / 2, z0), (w / 2, z0), (w / 2, z0 + h), (-w / 2, z0 + h)], -0.26, -0.2,
                      "church_fittings", "dark"), "church_fittings")


def oriented_box(name, a, b, width, thick, up, mat, paint=None):
    """A beam from point a to point b, `width` wide across and `thick` thick along `up` (a coping
    on a gable's slope, a verge board)."""
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    up = Vector(up)
    side = d.cross(up).normalized()
    up = side.cross(d).normalized()
    pts = []
    for p in (a, b):
        for sw in (-0.5, 0.5):
            for st in (0.0, 1.0):
                pts.append(p + side * (sw * width) + up * (st * thick))
    return hull(name, pts, mat, paint)


# ---------------------------------------------------------------- brick body
house = lambda hw, e, top: [(-hw, GR), (hw, GR), (hw, e), (0, top), (-hw, e)]
LOW = 0.25   # brick tops stay this far under the roof surface
bricks = [
    section_prism("nave", house(NAVE_HW, NAVE_E - LOW, RIDGE - LOW), "x", NAVE_X0, CROSS_X, "church_brick"),
    section_prism("transept", house((TR_X1 - TR_X0) / 2, TR_E - LOW, RIDGE - LOW), "y", -TR_HW, TR_HW, "church_brick",
                  shift=CROSS_X),
    section_prism("choir", house(CH_HW, CH_E - LOW, RIDGE - LOW), "x", CROSS_X, CH_X1, "church_brick"),
    box("sacristy_s", TR_X1 - 0.1, -SA_Y1, GR, SA_X1, -CH_HW + 0.1, SA_E - LOW, "church_brick"),
    box("sacristy_n", TR_X1 - 0.1, CH_HW - 0.1, GR, SA_X1, SA_Y1, SA_E - LOW, "church_brick"),
    box("tower", TW_X0, -TW_HW, GR, TW_X1, TW_HW, TW_TOP - 0.35, "church_brick"),
    box("cornice1", TW_X0 - 0.08, -TW_HW - 0.08, TW_TOP - 0.45, TW_X1 + 0.08, TW_HW + 0.08, TW_TOP - 0.25, "church_brick"),
    box("cornice2", TW_X0 - 0.17, -TW_HW - 0.17, TW_TOP - 0.25, TW_X1 + 0.17, TW_HW + 0.17, TW_TOP - 0.03, "church_brick"),
    box("course", TW_X0 - 0.05, -TW_HW - 0.05, 12.6, TW_X1 + 0.05, TW_HW + 0.05, 12.74, "church_brick"),
    box("chapel", TW_X0, AN_Y0, GR, NAVE_X0 + 0.1, AN_Y1 + 0.05, AN_E - LOW, "church_brick"),
    section_prism("chapel_top", [(AN_Y0, AN_E - LOW - 0.05), (AN_Y1 + 0.05, AN_E - LOW - 0.05), (AN_Y1 + 0.05, AN_TOP - LOW)],
                  "x", TW_X0, NAVE_X0 + 0.1, "church_brick"),
]
# Parapet gables at the transept's ends and the choir's east end: a little above the roof.
for sg in (1, -1):
    y0, y1 = sorted((sg * (TR_HW - 0.45), sg * TR_HW))
    bricks.append(section_prism("tr_gable", [(TR_X0, TR_E - 0.6), (TR_X1, TR_E - 0.6), (TR_X1, TR_E + 0.05), (CROSS_X, RIDGE + 0.12),
                                             (TR_X0, TR_E + 0.05)], "y", y0, y1, "church_brick"))
bricks.append(section_prism("ch_gable", [(-CH_HW, CH_E - 0.6), (CH_HW, CH_E - 0.6), (CH_HW, CH_E + 0.05), (0, RIDGE + 0.12),
                                         (-CH_HW, CH_E + 0.05)], "x", CH_X1 - 0.45, CH_X1, "church_brick"))
# The tower's small gables, one in the middle of each face above the cornice.
GW, TW_FACE = 0.87, TW_HW + 0.17
for k in range(4):
    rot = Matrix.Rotation(k * math.pi / 2, 3, "Z")
    pts = []
    for d in (1.5, TW_FACE):
        for s, z in ((-GW, TW_TOP - 0.03), (GW, TW_TOP - 0.03), (0, TW_GABLE)):
            pts.append(Vector((TW_CX, 0, 0)) + rot @ Vector((d, s, z)))
    bricks.append(hull("tw_gable", pts, "church_brick"))

# ---------------------------------------------------------------- windows and doors
S, N = face_y(-NAVE_HW, -1), face_y(NAVE_HW, 1)
for face in (S, N):
    sg = 1 if face is S else -1   # s runs east on the south face, west on the north face
    for x in (-12.55, -9.15, -5.75, -2.35):
        window(face, sg * x, 2.9, 1.45, 2.8, 0.22)
    tr = face_y(face.n.y * TR_HW, int(face.n.y))
    window(tr, sg * CROSS_X, 3.6, 2.05, 3.7, 0.28, surround=0.3)
    vent(tr, sg * CROSS_X, 10.8, 0.75)
    ch = face_y(face.n.y * CH_HW, int(face.n.y))
    window(ch, sg * 12.0, 5.7, 1.0, 1.75, 0.16, surround=0.2)
    sa = face_y(face.n.y * SA_Y1, int(face.n.y))
    for x in (10.25, 12.45):
        window(sa, sg * x, 1.95, 0.9, 1.65, 0.12, surround=0.18, panel=0.3)
E = face_x(CH_X1, 1)
vent(E, 0, 10.6, 0.7)
for y in (-5.85, 5.85):
    window(face_x(SA_X1, 1), -y, 1.95, 0.9, 1.65, 0.12, surround=0.18, panel=0.3)
# Belfry: two round-arched openings a face with louvres.
for k in range(4):
    a = k * math.pi / 2
    n = Vector((math.cos(a), math.sin(a), 0))
    f = Face(Vector((TW_CX, 0, 0)) + n * TW_HW, Vector((-math.sin(a), math.cos(a), 0)), n)
    for s in (-0.63, 0.63):
        g = Face(f.p(s, 0), f.t, f.n)
        opening = [(-0.41, 13.3), (0.41, 13.3)] + arch(0.82, 14.87, 0.41)
        BRICK_CUTS.append(outline_prism("cut", g, opening, 0.3, -0.45, "church_brick"))
        add(outline_prism("belfry_back", g, opening, -0.45, -0.38, "church_fittings", "dark"), "church_fittings")
        add(band_prism("belfry_arch", g, arch(0.82, 14.87, 0.41), arch(0.82, 14.87, 0.41, 8, 0.24), -0.02, 0.025, "church_brick"),
            "church_brick")
        for i in range(4):
            zz = 13.45 + i * 0.27
            add(hull("louvre", [g.p(sx, zz + dz, dd) for sx in (-0.41, 0.41) for dz, dd in ((0, -0.05), (0.2, -0.3))] +
                     [g.p(sx, zz + 0.03, -0.05) for sx in (-0.41, 0.41)], "church_fittings", "louvre"), "church_fittings")
        add(outline_prism("belfry_sill", g, [(-0.48, 13.2), (0.48, 13.2), (0.48, 13.3), (-0.48, 13.3)], -0.3, 0.04, "church_brick"),
            "church_brick")
    for s in (-1.68, -0.56, 0.56, 1.68):   # iron wall anchors under the string course
        add(outline_prism("anchor", f, [(s - 0.025, 11.55), (s + 0.025, 11.55), (s + 0.025, 12.5), (s - 0.025, 12.5)], -0.01, 0.03,
                          "church_fittings", "metal", back=False), "church_fittings")
# Grave stones and memorial plaques against the nave's south wall (among them the priest Modestus
# Glorieux's), light stone with rounded tops.
for x, w, z0, h in ((-12.7, 0.55, 0.95, 0.95), (-7.45, 0.78, 1.0, 1.55), (-2.35, 0.62, 0.95, 1.25)):
    f = Face(S.p(x, 0), S.t, S.n)
    add(outline_prism("plaque", f, [(-w / 2, z0), (w / 2, z0)] + arch(w, z0 + h, w / 2, 6), -0.01, 0.09, "church_trim", back=False),
        "church_trim")
# The west door: round-arched in a bluestone frame between Tuscan pilasters under a brick
# entablature and a drip moulding, a wooden transom and a blind fanlight; paired windows above.
W = face_x(TW_X0, -1)
DOOR_W, DOOR_Z, DOOR_TOP = 1.6, 0.3, 3.75
door = [(-DOOR_W / 2, DOOR_Z), (DOOR_W / 2, DOOR_Z)] + arch(DOOR_W, DOOR_TOP, DOOR_W / 2)
BRICK_CUTS.append(outline_prism("cut", W, door, 0.4, -0.35, "church_brick"))
STONE_CUTS.append(outline_prism("cut", W, door, 0.4, -0.35, "church_stone"))
add(outline_prism("door", W, [(-DOOR_W / 2, DOOR_Z), (DOOR_W / 2, DOOR_Z), (DOOR_W / 2, 2.95), (-DOOR_W / 2, 2.95)], -0.35, -0.28,
                  "church_fittings", "wood"), "church_fittings")
add(outline_prism("transom", W, [(-DOOR_W / 2, 2.95), (DOOR_W / 2, 2.95), (DOOR_W / 2, 3.08), (-DOOR_W / 2, 3.08)], -0.35, -0.22,
                  "church_fittings", "wood"), "church_fittings")
add(outline_prism("fanlight", W, [(-DOOR_W / 2, 3.08), (DOOR_W / 2, 3.08)] + arch(DOOR_W, DOOR_TOP, DOOR_W / 2)[1:-1], -0.34, -0.3,
                  "church_trim"), "church_trim")
add(band_prism("door_frame", W, [(DOOR_W / 2, DOOR_Z)] + arch(DOOR_W, DOOR_TOP, DOOR_W / 2) + [(-DOOR_W / 2, DOOR_Z)],
               [(DOOR_W / 2 + 0.2, DOOR_Z)] + arch(DOOR_W, DOOR_TOP, DOOR_W / 2, 8, 0.2) + [(-DOOR_W / 2 - 0.2, DOOR_Z)], -0.05, 0.05,
               "church_stone"), "church_stone")
def west_block(name, x0, x1, z0, z1, out, mat):
    """A flat block on the tower's west face (pilasters, capitals, the entablature)."""
    add(outline_prism(name, W, [(x0, z0), (x1, z0), (x1, z1), (x0, z1)], -0.02, out, mat, back=False), mat)


for sg in (1, -1):
    x0, x1 = sorted((sg * 1.02, sg * 1.45))
    west_block("pilaster", x0, x1, -0.3, 3.95, 0.12, "church_stone")
    x0, x1 = sorted((sg * 0.97, sg * 1.5))
    west_block("capital", x0, x1, 3.95, 4.12, 0.16, "church_stone")
    west_block("base", x0, x1, -0.3, 0.55, 0.16, "church_stone")
west_block("frieze", -1.5, 1.5, 4.12, 4.62, 0.1, "church_brick")
west_block("cornice", -1.62, 1.62, 4.62, 4.8, 0.22, "church_stone")
for s in (-0.42, 0.42):
    window(W, s, 5.6, 0.55, 1.55, 0.275, surround=0.14, hood=False, ears=False, panel=0.28)
west_block("imposts", -0.95, 0.95, 6.83, 6.93, 0.05, "church_trim")
# The calvary chapel's open front in its west wall, under a white wooden gable.
C = Face(Vector((TW_X0, (AN_Y0 + AN_Y1) / 2, 0)), W.t, W.n)
niche = [(-1.3, 0.95), (1.3, 0.95), (1.3, 2.75), (0, 3.45), (-1.3, 2.75)]
BRICK_CUTS.append(outline_prism("cut", C, niche, 0.4, -0.8, "church_brick"))
add(outline_prism("niche_back", C, niche, -0.8, -0.74, "church_fittings", "dark"), "church_fittings")
add(outline_prism("mound", C, [(-1.25, 0.95), (1.25, 0.95), (0.9, 1.25), (0, 1.38), (-0.9, 1.25)], -0.75, -0.25, "church_stone"),
    "church_stone")
add(outline_prism("cross_v", C, [(-0.06, 1.2), (0.06, 1.2), (0.06, 3.2), (-0.06, 3.2)], -0.72, -0.64, "church_fittings", "wood"),
    "church_fittings")
add(outline_prism("cross_h", C, [(-0.62, 2.72), (0.62, 2.72), (0.62, 2.84), (-0.62, 2.84)], -0.72, -0.64, "church_fittings", "wood"),
    "church_fittings")
add(outline_prism("corpus", C, [(-0.08, 1.75), (0.08, 1.75), (0.1, 2.6), (0.5, 2.78), (0.5, 2.84), (0, 2.75), (-0.5, 2.84), (-0.5, 2.78),
                                (-0.1, 2.6)], -0.64, -0.58, "church_trim"), "church_trim")
for sg in (1, -1):
    add(oriented_box("barge", C.p(sg * 1.45, 2.68, 0.2), C.p(0, 3.6, 0.2), 0.22, 0.05, C.n, "church_fittings", "white"),
        "church_fittings")
add(outline_prism("rail", C, [(-1.3, 0.95), (1.3, 0.95), (1.3, 1.95), (-1.3, 1.95)], 0.02, 0.04, "church_fittings", "metal"),
    "church_fittings")

# ---------------------------------------------------------------- quoins: sandstone blocks on the tower's west corners
for sy in (1, -1):   # the north-west corner from the plinth, the south-west one above the chapel's roof
    z, k, y = (PLINTH if sy > 0 else AN_TOP), 0, sy * TW_HW
    while z < 10.2 - 0.05:
        top = min(z + 0.3, 10.2)
        w_west, w_side = (0.45, 0.24) if k % 2 == 0 else (0.24, 0.45)
        y0, y1 = sorted((y, y - sy * w_west))
        add(box("quoin", TW_X0 - 0.015, y0, z, TW_X0, y1, top, "church_stone"), "church_stone")
        y0, y1 = sorted((y, y + sy * 0.015))
        add(box("quoin", TW_X0, y0, z, TW_X0 + w_side, y1, top, "church_stone"), "church_stone")
        z, k = top, k + 1

# ---------------------------------------------------------------- brick: union, openings
brick = union(bricks, "brick")
boolean(brick, BRICK_CUTS, "DIFFERENCE")
add(brick, "church_brick")


# ---------------------------------------------------------------- plinth
def offset_outline(pts, d):
    """Offset a counter-clockwise outline of right angles outwards by d."""
    out = []
    n = len(pts)
    for i in range(n):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % n])
        e0, e1 = (p1 - p0).normalized(), (p2 - p1).normalized()
        n0, n1 = Vector((e0.y, -e0.x)), Vector((e1.y, -e1.x))
        out.append(tuple(p1 + (n0 + n1) * d))
    return out


FOOT = [(TW_X0, AN_Y0), (TR_X0, -NAVE_HW), (TR_X0, -TR_HW), (TR_X1, -TR_HW), (TR_X1, -SA_Y1), (SA_X1, -SA_Y1), (SA_X1, -CH_HW),
        (CH_X1, -CH_HW), (CH_X1, CH_HW), (SA_X1, CH_HW), (SA_X1, SA_Y1), (TR_X1, SA_Y1), (TR_X1, TR_HW), (TR_X0, TR_HW),
        (TR_X0, NAVE_HW), (NAVE_X0, NAVE_HW), (NAVE_X0, TW_HW), (TW_X0, TW_HW)]   # the outline, counter-clockwise
outer = offset_outline(FOOT, 0.07)
bm = bmesh.new()
lo = [bm.verts.new((x, y, GR)) for x, y in outer]
mid = [bm.verts.new((x, y, PLINTH - 0.1)) for x, y in outer]
hi = [bm.verts.new((x, y, PLINTH)) for x, y in FOOT]
for i in range(len(FOOT)):
    j = (i + 1) % len(FOOT)
    bm.faces.new((lo[i], lo[j], mid[j], mid[i]))
    bm.faces.new((mid[i], mid[j], hi[j], hi[i]))
bm.faces.new(lo[::-1])
bm.faces.new(hi)
plinth = to_object(bm, "plinth", "church_stone")
boolean(plinth, STONE_CUTS, "DIFFERENCE")
add(plinth, "church_stone")

# ---------------------------------------------------------------- roofs
def gable_roof(axis, a0, a1, hw, e, ridge, over, lower=0.0, fascia=0.12, widen=0.0, shift=0.0):
    """A gable roof solid along an axis: the surface at height e over the wall faces at +-hw,
    the ridge on the axis, `over` beyond the walls; lowered by `lower` and `widen` wider at the
    same slope (for the inside cut)."""
    s = (ridge - e) / hw
    w = hw + over + widen
    edge = e - (over + widen) * s
    sec = [(-w, edge - fascia - lower), (w, edge - fascia - lower), (w, edge - lower), (0, ridge - lower), (-w, edge - lower)]
    return section_prism("roof", sec, axis, a0, a1, "church_slate", shift=shift)


T_IN = 0.16   # the slates and boarding: about 0.12 m thick at 45 degrees
TR_HALF = (TR_X1 - TR_X0) / 2
outer_roofs = [gable_roof("x", NAVE_X0 - 0.25, CROSS_X, NAVE_HW, NAVE_E, RIDGE, OVER),
               gable_roof("y", -TR_HW + 0.2, TR_HW - 0.2, TR_HALF, TR_E, RIDGE, OVER, shift=CROSS_X),
               gable_roof("x", CROSS_X, CH_X1 - 0.2, CH_HW, CH_E, RIDGE, OVER)]
# The inside cut: the same sections lowered (at the same slopes), deeper and a little wider.
inner_roofs = [gable_roof("x", NAVE_X0 - 1, CROSS_X, NAVE_HW, NAVE_E, RIDGE, OVER, T_IN, 5, 0.05),
               gable_roof("y", -TR_HW - 1, TR_HW + 1, TR_HALF, TR_E, RIDGE, OVER, T_IN, 5, 0.05, shift=CROSS_X),
               gable_roof("x", CROSS_X, CH_X1 + 1, CH_HW, CH_E, RIDGE, OVER, T_IN, 5, 0.05)]
roof = union(outer_roofs, "roof")
inner = union(inner_roofs, "roof_in")
boolean(roof, [inner], "DIFFERENCE")
add(roof, "church_slate")


def sacristy_roof(sg):
    """A sacristy's roof: ridge along x over the middle, hipped at the east end, against the
    transept's wall at the west end and the choir's wall on the inner side."""
    hw = (SA_Y1 - CH_HW) / 2
    ym, sl = CH_HW + hw, (SA_RIDGE - SA_E) / hw
    xw, xe, xr = TR_X1 - 0.15, SA_X1 + 0.25, SA_X1 - hw
    yo, yi = SA_Y1 + 0.25, CH_HW - 0.07
    zo, zi = SA_E - 0.25 * sl, SA_RIDGE - sl * (ym - yi)
    top = [(xw, ym, SA_RIDGE), (xr, ym, SA_RIDGE), (xw, yo, zo), (xe, yo, zo), (xw, yi, zi), (xe, yi, zo)]
    pts = top + [(x, y, z - 0.12) for x, y, z in top[2:]]
    return hull("sacristy_roof", [(x, sg * y, z) for x, y, z in pts], "church_slate")


for sg in (1, -1):
    add(sacristy_roof(sg), "church_slate")
# The chapel's lean-to against the tower.
s_an = (AN_TOP - AN_E) / (AN_Y1 - AN_Y0)
pts = []
for x in (TW_X0 - 0.2, NAVE_X0 + 0.05):
    pts += [(x, AN_Y0 - 0.25, AN_E - 0.25 * s_an), (x, AN_Y0 - 0.25, AN_E - 0.25 * s_an - 0.12), (x, AN_Y1 + 0.02, AN_TOP),
            (x, AN_Y1 + 0.02, AN_TOP - 0.3)]
add(hull("chapel_roof", pts, "church_slate"), "church_slate")


# ---------------------------------------------------------------- tower top: gable roofs, spire, tip
def ring12(cx, z, a, c, k):
    """A ring of 12 points round the tower's axis at height z: on each face two points at +-c from
    its middle, a from the axis, and the corner points (k, k) between them. A square when k = a,
    an octagon when c = a tan(22.5) and k = a / sqrt(2)."""
    pts =[(a, -c), (a, c), (k, k), (c, a), (-c, a), (-k, k), (-a, c), (-a, -c), (-k, -k), (-c, -a), (c, -a), (k, -k)]
    return [(cx + x, y, z) for x, y in pts]


T8 = math.tan(math.pi / 8)
P_K = 1.62   # the spire's apothem at the kink
rings = [ring12(TW_CX, TW_TOP, 2.40, GW - 0.03, TW_HW + 0.2),
         ring12(TW_CX, TW_TOP + 0.35, 2.22, 0.86, 2.05),
         ring12(TW_CX, TW_TOP + 1.2, 1.82, 0.75, 1.55),
         ring12(TW_CX, KINK, P_K, P_K * T8, P_K / math.sqrt(2))]
bm = bmesh.new()
vr = [[bm.verts.new(p) for p in r] for r in rings]
tip = bm.verts.new((TW_CX, 0, TIP))
for r0, r1 in zip(vr, vr[1:]):
    for i in range(12):
        bm.faces.new((r0[i], r0[(i + 1) % 12], r1[(i + 1) % 12], r1[i]))
for i in range(12):
    bm.faces.new((vr[-1][i], vr[-1][(i + 1) % 12], tip))
bm.faces.new(vr[0][::-1])
add(to_object(bm, "spire", "church_slate"), "church_slate")
for k in range(4):
    rot = Matrix.Rotation(k * math.pi / 2, 3, "Z")
    pts = [Vector((TW_CX, 0, 0)) + rot @ Vector((d, s, z)) for d in (1.2, TW_FACE - 0.05)
           for s, z in ((-GW - 0.08, TW_TOP - 0.05), (GW + 0.08, TW_TOP - 0.05), (0, TW_GABLE + 0.09))]
    add(hull("gable_roof", pts, "church_slate"), "church_slate")
    for sg in (1, -1):   # the wine-red flashing along the gable's slopes
        a = Vector((TW_CX, 0, 0)) + rot @ Vector((TW_FACE - 0.05, sg * (GW + 0.06), TW_TOP - 0.02))
        b = Vector((TW_CX, 0, 0)) + rot @ Vector((TW_FACE - 0.05, 0, TW_GABLE + 0.07))
        add(oriented_box("flashing", a, b, 0.2, 0.06, (0, 0, 1), "church_fittings", "wine"), "church_fittings")
add(box("cornice_edge", TW_X0 - 0.2, -TW_HW - 0.2, TW_TOP - 0.06, TW_X1 + 0.2, TW_HW + 0.2, TW_TOP, "church_fittings", "wine"),
    "church_fittings")
# The metal top: a short cone, the ball, the rod with a cross and the weathercock.
add(hull("cap", [(TW_CX + 0.13 * math.cos(a), 0.13 * math.sin(a), TIP - 0.5) for a in np.linspace(0, 2 * math.pi, 8, endpoint=False)] +
         [(TW_CX, 0, TIP + 0.35)], "church_fittings", "zinc"), "church_fittings")
add(sphere("ball", (TW_CX, 0, 26.44), 0.15, "church_fittings", "gilt"), "church_fittings")
add(cylinder("rod", (TW_CX, 0, 26.3), (TW_CX, 0, 29.25), 0.025, "church_fittings", "metal", 6), "church_fittings")
add(box("rod_cross", TW_CX - 0.02, -0.32, 27.85, TW_CX + 0.02, 0.32, 27.9, "church_fittings", "metal"), "church_fittings")
add(box("rod_cross2", TW_CX - 0.32, -0.02, 27.85, TW_CX + 0.32, 0.02, 27.9, "church_fittings", "metal"), "church_fittings")
COCK = [(-0.30, 0.05), (-0.12, 0.08), (0.02, 0.05), (0.08, 0.22), (0.16, 0.32), (0.22, 0.28), (0.2, 0.2), (0.27, 0.14), (0.18, 0.12),
        (0.17, 0.02), (0.08, -0.06), (0.03, -0.1), (-0.12, -0.08), (-0.2, 0.0), (-0.34, 0.32), (-0.38, 0.28)]
bm = bmesh.new()
for dy in (-0.012, 0.012):
    bm.faces.new([bm.verts.new((TW_CX + x, dy, 29.25 + z)) for x, z in COCK])
bmesh.ops.bridge_loops(bm, edges=bm.edges[:])
add(to_object(bm, "cock", "church_fittings", "gilt"), "church_fittings")

# ---------------------------------------------------------------- copings, kneelers, crosses, gutters, downpipes
def coping(face_axis, at, half, e, ridge, face):
    """Cement copings along a parapet gable's two slopes and stone kneelers at its feet; face_axis
    'y' for a gable across x (the transept's ends, centred on the crossing), 'x' for one across y
    (the choir's east end). `at` is the middle of the parapet's thickness, `face` its outer face."""
    out = math.copysign(1, face)
    for sg in (1, -1):
        c = CROSS_X if face_axis == "y" else 0.0
        a, b = [c + sg * (half + 0.05), e + 0.05], [c, ridge + 0.12]
        k0, k1 = sorted((c + sg * (half + OVER + 0.02), c + sg * (half - 0.45)))
        f0, f1 = sorted((face + out * 0.04, face - out * 0.55))
        if face_axis == "y":
            add(oriented_box("coping", (a[0], at, a[1]), (b[0], at, b[1]), 0.55, 0.1, (0, 0, 1), "church_trim"), "church_trim")
            add(box("kneeler", k0, f0, e - 0.42, k1, f1, e + 0.12, "church_stone"), "church_stone")
        else:
            add(oriented_box("coping", (at, a[0], a[1]), (at, b[0], b[1]), 0.55, 0.1, (0, 0, 1), "church_trim"), "church_trim")
            add(box("kneeler", f0, k0, e - 0.42, f1, k1, e + 0.12, "church_stone"), "church_stone")


for sg in (1, -1):
    coping("y", sg * (TR_HW - 0.22), TR_HALF, TR_E, RIDGE, sg * TR_HW)
    add(box("finial", CROSS_X - 0.13, sg * (TR_HW - 0.35) - 0.13, RIDGE + 0.2, CROSS_X + 0.13, sg * (TR_HW - 0.35) + 0.13, RIDGE + 0.45,
            "church_stone"), "church_stone")
coping("x", CH_X1 - 0.22, CH_HW, CH_E, RIDGE, CH_X1)
add(box("pedestal", CH_X1 - 0.42, -0.18, RIDGE + 0.15, CH_X1 - 0.06, 0.18, RIDGE + 0.5, "church_stone"), "church_stone")
add(box("cross_v", CH_X1 - 0.27, -0.035, RIDGE + 0.5, CH_X1 - 0.21, 0.035, RIDGE + 1.95, "church_fittings", "metal"), "church_fittings")
add(box("cross_h", CH_X1 - 0.27, -0.36, RIDGE + 1.38, CH_X1 - 0.21, 0.36, RIDGE + 1.44, "church_fittings", "metal"), "church_fittings")
for y, z in ((0, RIDGE + 1.98), (0.38, RIDGE + 1.41), (-0.38, RIDGE + 1.41)):
    add(sphere("knob", (CH_X1 - 0.24, y, z), 0.06, "church_fittings", "metal", 6, 4), "church_fittings")


def gutter(a, b, z, out):
    """A wine-red gutter along an eaves edge from a to b (plan points), its top at z, `out` the
    outward direction."""
    a, b, o = Vector((*a, 0)), Vector((*b, 0)), Vector((*out, 0))
    pts = []
    for p in (a, b):
        for d, zz in ((0.0, z), (0.16, z), (0.0, z - 0.2), (0.14, z - 0.2)):
            pts.append(p + o * d + Vector((0, 0, zz)))
    add(hull("gutter", pts, "church_fittings", "wine"), "church_fittings")


def eave_z(e, ridge, hw):
    return e - OVER * (ridge - e) / hw


ze = eave_z(NAVE_E, RIDGE, NAVE_HW)
zt = eave_z(TR_E, RIDGE, (TR_X1 - TR_X0) / 2)
zc = eave_z(CH_E, RIDGE, CH_HW)
zs = SA_E - 0.25 * (SA_RIDGE - SA_E) / ((SA_Y1 - CH_HW) / 2)
for sg in (1, -1):
    gutter((NAVE_X0 - 0.25, sg * (NAVE_HW + OVER)), (TR_X0 - OVER, sg * (NAVE_HW + OVER)), ze + 0.02, (0, sg))
    gutter((TR_X0 - OVER, sg * (NAVE_HW + OVER)), (TR_X0 - OVER, sg * (TR_HW - 0.1)), zt + 0.02, (-1, 0))
    gutter((TR_X1 + OVER, sg * CH_HW), (TR_X1 + OVER, sg * (TR_HW - 0.1)), zt + 0.02, (1, 0))
    gutter((TR_X1 + OVER, sg * (CH_HW + OVER)), (CH_X1 - 0.1, sg * (CH_HW + OVER)), zc + 0.02, (0, sg))
    gutter((TR_X1, sg * (SA_Y1 + 0.25)), (SA_X1 + 0.25, sg * (SA_Y1 + 0.25)), zs + 0.02, (0, sg))
    gutter((SA_X1 + 0.25, sg * (SA_Y1 + 0.25)), (SA_X1 + 0.25, sg * CH_HW), zs + 0.02, (1, 0))
    for x, y, top in ((NAVE_X0 + 0.12, NAVE_HW + 0.1, ze), (TR_X0 - 0.15, NAVE_HW + 0.1, ze), (SA_X1 - 0.15, SA_Y1 + 0.1, zs)):
        add(cylinder("downpipe", (x, sg * y, -0.2), (x, sg * y, top - 0.15), 0.05, "church_fittings", "zinc"), "church_fittings")
gutter((TW_X0 - 0.2, AN_Y0 - 0.25), (NAVE_X0, AN_Y0 - 0.25), AN_E - 0.25 * s_an + 0.02, (0, -1))
# The verge of the nave's west gable: a light flashing under the slates' edge.
for sg in (1, -1):
    a = (NAVE_X0 - 0.27, sg * (NAVE_HW + OVER), ze)
    b = (NAVE_X0 - 0.27, sg * TW_HW, RIDGE - (TW_HW / NAVE_HW) * (RIDGE - NAVE_E))
    add(oriented_box("verge", a, b, 0.05, 0.2, (0, 0, -1), "church_trim"), "church_trim")


# ---------------------------------------------------------------- UVs, join per material, export
def metre_uvs(obj, scale=1.0):
    """UVs in metres (divided by `scale`): along the face horizontally and up the face (for roofs
    up the slope), as the game's textures expect; flat faces get plan coordinates."""
    me = obj.data
    uv = me.uv_layers.new(name="UVMap") if not me.uv_layers else me.uv_layers[0]
    for poly in me.polygons:
        n = poly.normal
        if abs(n.z) > 0.97:
            t, b = Vector((1, 0, 0)), Vector((0, 1, 0))
        else:
            t = Vector((0, 0, 1)).cross(n).normalized()
            b = n.cross(t).normalized()
        for li in poly.loop_indices:
            p = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = (p.dot(t) / scale, p.dot(b) / scale)


for g, f, s0, z0, pw, ph in GLASS_UV:
    me = g.data
    uv = me.uv_layers.new(name="UVMap")
    for li, lp in enumerate(me.loops):
        p = me.vertices[lp.vertex_index].co - f.o
        uv.data[li].uv = ((p.dot(f.t) - s0) / pw, (p.z - z0) / ph)

final = {}
for mat, objs in PARTS.items():
    if mat in ("church_glass", "church_fittings"):
        obj = join(objs, mat)
    else:
        obj = join(objs, mat)
        metre_uvs(obj, SLATE_TILE if mat == "church_slate" else 1.0)
    obj.data.set_sharp_from_angle(angle=math.radians(30))
    final[mat] = obj

tris = 0
for name, o in final.items():
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
    print(f"{name}: {len(o.data.loop_triangles)} triangles")
print(f"church: {tris} triangles in {len(final)} meshes")
lo = Vector((min(v.co[i] for o in final.values() for v in o.data.vertices) for i in range(3)))
hi = Vector((max(v.co[i] for o in final.values() for v in o.data.vertices) for i in range(3)))
print("bounds", tuple(round(c, 2) for c in lo), tuple(round(c, 2) for c in hi))

bpy.ops.object.select_all(action="DESELECT")
for o in final.values():
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=True, export_extras=True, export_vertex_color="MATERIAL",
                          export_image_format="JPEG", export_jpeg_quality=88, export_cameras=False, export_lights=False)
print("written", OUT, os.path.getsize(OUT), "bytes")

# ---------------------------------------------------------------- preview renders
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 64
    scene.eevee.use_raytracing = True
    scene.eevee.shadow_resolution_scale = 1.0
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        scene.view_settings.view_transform = "Filmic"
    sizes = json.load(open(os.path.join(ROOT, "web", "public", "textures", "sizes.json")))

    def textured(mat, tex, tint, nscale, rough=1.0):
        """The game's look in Blender: its texture at its size in metres, times the tint."""
        nt = mat.node_tree
        p = nt.nodes["Principled BSDF"]
        uv = nt.nodes.new("ShaderNodeUVMap")
        mp = nt.nodes.new("ShaderNodeMapping")
        s = 1 / sizes.get(tex, 2.0)
        mp.inputs["Scale"].default_value = (s, s, 1)
        nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])

        def image(kind, colour):
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = bpy.data.images.load(os.path.join(ROOT, "web", "public", "textures", f"{tex}_{kind}.webp"), check_existing=True)
            t.image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
            nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
            return t

        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(image("color", True).outputs["Color"], mix.inputs["A"])
        mix.inputs["B"].default_value = (*srgb(tint), 1)
        nt.links.new(mix.outputs["Result"], p.inputs["Base Color"])
        if os.path.exists(os.path.join(ROOT, "web", "public", "textures", f"{tex}_normal.webp")):
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.inputs["Strength"].default_value = nscale
            nt.links.new(image("normal", False).outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
            mr = nt.nodes.new("ShaderNodeMath")
            mr.operation = "MULTIPLY"
            mr.inputs[1].default_value = rough
            nt.links.new(image("rough", False).outputs["Color"], mr.inputs[0])
            nt.links.new(mr.outputs["Value"], p.inputs["Roughness"])

    for name, (tex, tint, nscale, _) in SHARED.items():
        textured(M[name], tex, tint, nscale)

    # The game's sky photo, turned so its sun shines from the south-south-east (late morning); Eevee takes the
    # sun out of the photo as a light with shadows.
    sky = bpy.data.images.load(os.path.join(ROOT, "web", "public", "env", "sky_2k.hdr"))
    px = np.empty(sky.size[0] * sky.size[1] * 4, np.float32)
    sky.pixels.foreach_get(px)
    lum = px.reshape(sky.size[1], sky.size[0], 4)[..., :3].sum(2)
    row, col = np.unravel_index(np.argmax(lum), lum.shape)
    sun_az = math.pi * (1 - 2 * (col + 0.5) / sky.size[0])
    sun_el = math.pi * ((row + 0.5) / sky.size[1] - 0.5)
    want = math.radians(-70)
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    wn = world.node_tree
    env = wn.nodes.new("ShaderNodeTexEnvironment")
    env.image = sky
    tc = wn.nodes.new("ShaderNodeTexCoord")
    mp = wn.nodes.new("ShaderNodeMapping")
    mp.inputs["Rotation"].default_value = (0, 0, sun_az - want)
    wn.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
    wn.links.new(mp.outputs["Vector"], env.inputs["Vector"])
    wn.links.new(env.outputs["Color"], wn.nodes["Background"].inputs["Color"])
    wn.nodes["Background"].inputs["Strength"].default_value = 1.0
    world.sun_threshold = 20.0
    world.sun_angle = math.radians(1.5)
    world.use_sun_shadow = True
    scene.world = world
    print(f"sky: sun at elevation {math.degrees(sun_el):.1f} deg, turned to azimuth {math.degrees(want):.0f} deg")

    # The square: concrete pavers round the church.
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, -0.1))
    ground = bpy.context.active_object
    gm = principled("PreviewPavers", (0.5, 0.5, 0.5), 0.9)
    textured(gm, "pavers", "#cdc9c2", 0.8)
    ground.data.materials.append(gm)
    metre_uvs(ground)

    # Optional context: the neighbouring buildings as plain massing (outline, eaves and ridge in
    # the church's frame; a gable along the long side of the outline's rectangle, clipped to it).
    if CONTEXT:
        clay, clay_roof = principled("PreviewClay", srgb("#cfc9be"), 0.9), principled("PreviewClayRoof", srgb("#9c968f"), 0.85)
        for b in json.load(open(CONTEXT)):
            walls = plan_prism("ctx", b["outline"], GR, b["eaves"], "church_brick")
            walls.data.materials[0] = clay
            if b["flat"]:
                roof = plan_prism("ctx_roof", b["outline"], b["eaves"], b["eaves"] + 0.25, "church_slate")
            else:
                c = [Vector((*q, 0)) for q in b["rect"]]
                i = b["long"]
                L = c[(i + 1) % 4] - c[i]
                Sd = c[(i + 2) % 4] - c[(i + 1) % 4]
                mid = (c[0] + c[2]) / 2
                la, sb = L.length / 2 + 0.3, Sd.length / 2
                L, Sd = L.normalized(), Sd.normalized()
                slope = (b["ridge"] - b["eaves"]) / sb
                pts = []
                for e in (-la, la):
                    pts += [mid + L * e + Vector((0, 0, b["ridge"]))]
                    for sg in (-1, 1):
                        q = mid + L * e + Sd * sg * (sb + 0.3)
                        pts += [q + Vector((0, 0, b["eaves"] - 0.3 * slope)), q + Vector((0, 0, b["eaves"] - 0.3 * slope - 0.15))]
                roof = hull("ctx_roof", pts, "church_slate")
                clip = plan_prism("ctx_clip", b["outline"], b["eaves"] - 1, b["ridge"] + 1, "church_slate")
                modify(roof, "BOOLEAN", operation="INTERSECT", solver="EXACT", object=clip)
                bpy.data.objects.remove(clip)
            roof.data.materials[0] = clay_roof

    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.sensor_width = 36.0
    os.makedirs(PREVIEW, exist_ok=True)

    def shoot(label, pos, yaw, pitch, f_px, w, h, cx=None, cy=None, roll=0.0):
        """A render from pos (model metres) looking along yaw (degrees from +x, towards +y) and
        pitch, with the focal length in pixels and the principal point (cx, cy) of a w x h image."""
        scene.render.resolution_x, scene.render.resolution_y = w, h
        cam.location = pos
        cam.rotation_euler = (math.radians(90 + pitch), math.radians(roll), math.radians(yaw - 90))
        cam.data.lens = f_px / w * 36.0
        cx = w / 2 if cx is None else cx
        cy = h / 2 if cy is None else cy
        cam.data.shift_x = (w / 2 - cx) / max(w, h)
        cam.data.shift_y = (cy - h / 2) / max(w, h)
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)

    # A person on the square: south-west of the church, and south-east by the sacristy.
    shoot("church_square_sw", (-11.5, -30.5, 1.6), 72, 9, 920, 1920, 1080, cy=700)
    shoot("church_square_se", (13.5, -29.5, 1.6), 118, 6, 1050, 1920, 1080, cy=760)
    shoot("church_tower", (-11.5, -19.0, 1.6), 104, 18, 1000, 1080, 1440, cy=980)
    if CAMERAS:
        for c in json.load(open(CAMERAS)):
            shoot(c["name"], c["pos"], c["yaw"], c.get("pitch", 0.0), c["f_px"], c["w"], c["h"], c.get("cx"), c.get("cy"),
                  c.get("roll", 0.0))
