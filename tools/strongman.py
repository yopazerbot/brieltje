"""Build the game's strongman in Blender: a friend of ours as an old-time circus strongman, in separate parts.

Run (Blender 5, no window):
  blender -b -P tools/strongman.py -- <out.glb> [preview_dir] [face_photo]

The face is a friend's, with his consent (he asked to be in the game): face_photo is a front-on
photo of him (by default source/people/strongman-face.jpg, kept out of git). From it the script takes
only a crop of the face (brows to chin, ear to ear), levelled, evened out and blended into his
skin colour round the edges, as one 512 x 512 texture projected straight on from the front; his
head is shaped to the photo (where his eyes, nose, mouth, jaw and ears are), and his hair and
beard are meshes shaped like his. Nothing else from the photo goes into the GLB.

The rest is the archetype: 1.85 m tall with a bodybuilder's build (broad shoulders, a big chest
and arms, defined abs, thick thighs), in the classic one-shoulder leopard-print leotard (the
strap over his left shoulder, cut like wrestling trunks at the top of the thigh), barefoot.
Each part is a union of muscle-shaped ellipsoids and capsules, voxel remeshed into one skin,
smoothed and decimated.

Output: one GLB with eight nodes for procedural animation, named and set up like the clown's
(tools/clown.py) so the same code drives them. Body (the hips and torso; its origin at the hip
joints, 0.93 m up) is the root; Head (pivot at the neck), Arm_L and Arm_R (pivot at the
shoulder, hanging a little away from the body) and Leg_L and Leg_R (pivot at the hip, with the
foot) are its children, and Forearm_L and Forearm_R (pivot at the elbow, with the hand) are
the arms' children. L/R are his own sides: his left is +x. In the rest pose he stands on the
floor at y = 0 and faces +z in the GLB (Blender -Y). Every joint has a round end round its
pivot, so turning it opens no gap. Materials: Skin, Face (the photo texture), Eyes (the same
texture, glossier), Hair and Leopard (a 512 x 512 rosette print made from a procedural pattern,
on UVs). With preview_dir it also renders front three-quarter, front, side, back, the face (front,
three-quarter, side) beside the photo crop, the face texture, a walking stride, a double-biceps
flex (also with the values the game uses now) and a view from 15 m there.
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector, noise
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""
PHOTO = argv[2] if len(argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "source", "people", "strongman-face.jpg")

HIP = Vector((0.0, 0.0, 0.93))         # Body's origin, the height of the hip joints
HIP_X = 0.095                          # the hip joints either side of it
SHOULDER = Vector((0.205, 0.01, 1.455))  # the left shoulder joint; the right one mirrored
ARM_OUT = math.radians(15)             # rest pose: the arms hang a little away from the lats
UPPER, FORE = 0.325, 0.265             # shoulder to elbow, elbow to wrist
ELBOW_BEND = math.radians(10)          # the forearms a little forward of the upper arms at rest
NECK = Vector((0.0, 0.015, 1.56))      # the head's pivot, in the middle of the neck
TILE = 0.22                            # one repeat of the leopard print, in metres

# His face photo, once turned 3.4 degrees about the point between his eyes so they are level:
# where things are, in pixels (x to the right, y down), and how big a pixel is.
EYES_PX = ((216.7, 394.0), (366.7, 385.0))  # his right and left pupil in the photo as it is
EYE_ROW = 389.5
K = 0.00043                            # metres a pixel: his pupils are 147 px apart, 63 mm
MIDLINE = [(300, 291), (400, 291.5), (470, 300), (536, 305), (600, 308)]  # (y, x) down the middle of his face
OUTLINE = [(250, 155, 460), (300, 152, 462), (340, 147, 465), (389.5, 145, 467), (440, 145, 462), (480, 147, 460),
           (520, 150, 457), (560, 162, 446), (600, 188, 432), (630, 214, 405), (650, 246, 374), (660, 280, 340),
           (666, 306, 310)]   # (y, left x, right x) of his face and beard
HAIRLINE = [(130, 300), (160, 262), (200, 252), (260, 254), (300, 262), (340, 272), (370, 285), (400, 300), (430, 308),
            (460, 300), (490, 320)]  # (x, y) of the edge of the hair over his forehead
# The same in the model: his eyes at this height, the texture a square on the front of his face.
Z_EYE = 1.725
EYE_X, EYE_Y, RE = 0.0315, -0.07, 0.012   # his left eyeball's centre (x, y) and radius; the right mirrored
CC = Vector((0.0, 0.012, 1.752))          # the middle of his skull
TEX_X0, TEX_Z0, TEX_SIZE = -0.11, Z_EYE - 0.13, 0.22
BEARD_TOP = [(0.0, -0.05), (0.022, -0.052), (0.035, -0.052), (0.05, -0.044), (0.06, -0.032), (0.066, -0.012),
             (0.075, 0.005), (0.09, 0.005)]  # (|x|, z above his eyes) of the top edge of his beard


def material(name, rgb, rough=0.6, image=None):
    """rgb: sRGB, 0 to 1 (or a hex string)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    if isinstance(rgb, str):
        rgb = [int(rgb[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    p.inputs["Base Color"].default_value = (*[v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb], 1)
    p.inputs["Roughness"].default_value = rough
    if image:
        tex = m.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        m.node_tree.links.new(tex.outputs["Color"], p.inputs["Base Color"])
    m.use_backface_culling = True  # exported single-sided
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def modify(obj, kind, **props):
    """Add a modifier with these settings and apply it."""
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)
    return obj


def from_bmesh(name, bm, mats=(), recalc=False):
    """A mesh object from a bmesh; mats is one material or a list (faces keep their material_index)."""
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats if isinstance(mats, (list, tuple)) else [mats]:
        me.materials.append(m)
    return link(bpy.data.objects.new(name, me))


def lathe(profile, seg=16, matrix=Matrix(), name="Part"):
    """A surface of revolution round z: profile (r, z) from bottom to top, r = 0 makes a pole.
    Wound outwards; matrix (no mirroring) then places it."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        if r < 1e-6:
            rings.append(bm.verts.new((0.0, 0.0, z)))
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg), z))
                          for k in range(seg)])
    for a, b in zip(rings, rings[1:]):
        for k in range(seg):
            k1 = (k + 1) % seg
            if isinstance(a, list) and isinstance(b, list):
                bm.faces.new((a[k], a[k1], b[k1], b[k]))
            elif isinstance(b, list):
                bm.faces.new((a, b[k1], b[k]))
            elif isinstance(a, list):
                bm.faces.new((a[k], a[k1], b))
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    return from_bmesh(name, bm)


def ell(center, radii, rot=Matrix(), u=18, v=10):
    """An ellipsoid with semi-axes radii (x, y, z), turned by rot round its centre."""
    m = Matrix.Translation(Vector(center)) @ rot.to_4x4() @ Matrix.Diagonal((*radii, 1.0))
    return lathe([(math.sin(math.pi * i / v), -math.cos(math.pi * i / v)) for i in range(v + 1)], u, m)


def frame(axis, out):
    """Rotation whose z is along axis and y along out (made square to it)."""
    z = Vector(axis).normalized()
    y = Vector(out) - z * Vector(out).dot(z)
    y.normalize()
    return Matrix((y.cross(z), y, z)).transposed()


def belly(p0, p1, w, d, out):
    """A muscle belly: an ellipsoid running from p0 to p1, w wide and d deep (semi-axes), its
    depth along out (roughly the skin's normal there)."""
    p0, p1 = Vector(p0), Vector(p1)
    return ell((p0 + p1) / 2, (w, d, (p1 - p0).length / 2), frame(p1 - p0, out))


def capsule(a, b, ra, rb, seg=14):
    """A tapered capsule: a ball of radius ra at a, one of rb at b, a cone between them."""
    a, b = Vector(a), Vector(b)
    n = 4
    prof = [(ra * math.cos(t), ra * math.sin(t)) for t in (math.pi / 2 * (i / n - 1) for i in range(n + 1))]
    prof += [(rb * math.cos(t), (b - a).length + rb * math.sin(t)) for t in (math.pi / 2 * i / n for i in range(n + 1))]
    prof[0] = (0.0, -ra)
    prof[-1] = (0.0, (b - a).length + rb)
    rot = Vector((0.0, 0.0, 1.0)).rotation_difference(b - a).to_matrix().to_4x4()
    return lathe(prof, seg, Matrix.Translation(a) @ rot)


def merge(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = parts[0]
    obj.name = obj.data.name = name
    return obj


def fuse(parts, name, voxel, smooth):
    """The union of overlapping closed parts as one skin: voxel remeshed, then smoothed so the
    creases between the parts become soft grooves (like the edges of muscles)."""
    obj = merge(parts, name)
    modify(obj, "REMESH", mode="VOXEL", voxel_size=voxel, adaptivity=0.0)
    if smooth:
        modify(obj, "SMOOTH", factor=0.6, iterations=smooth)
    return obj


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimate(obj, target, sym=False, keep=None):
    """Down to about target triangles; keep: indices of vertices to spare (round the eyes)."""
    if keep is not None:
        g = obj.vertex_groups.new(name="keep")
        g.add([int(i) for i in keep], 1.0, "REPLACE")
    modify(obj, "DECIMATE", ratio=min(1.0, target / tris(obj)), use_symmetry=sym, symmetry_axis="X",
           vertex_group="keep" if keep is not None else "", invert_vertex_group=keep is not None)
    if keep is not None:
        obj.vertex_groups.remove(obj.vertex_groups["keep"])
    return obj


def symmetrize(obj):
    """Make it exactly symmetric: his left half mirrored onto his right."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.symmetrize(bm, input=bm.verts[:] + bm.edges[:] + bm.faces[:], direction="X", dist=1e-5)
    bm.to_mesh(obj.data)
    bm.free()


def mirrored(obj, name):
    """A copy mirrored left to right (for the right arm, forearm and leg)."""
    me = obj.data.copy()
    me.transform(Matrix.Scale(-1, 4, (1.0, 0.0, 0.0)))
    me.flip_normals()
    me.name = name
    return link(bpy.data.objects.new(name, me))


def coords(obj):
    a = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)


def set_coords(obj, a):
    obj.data.vertices.foreach_set("co", a.ravel())
    obj.data.update()


def normals(obj):
    a = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertex_normals.foreach_get("vector", a)
    return a.reshape(-1, 3)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def dent(co, center, radii, depth, direction):
    """Press a soft dent into the skin: points inside the ellipsoid (centre, axis-aligned radii)
    move along direction by up to depth, most in the middle."""
    q = ((co - np.array(center)) / np.array(radii)) ** 2
    w = np.clip(1 - q.sum(axis=1), 0.0, 1.0) ** 2
    co += np.outer(w * depth, np.array(direction) / np.linalg.norm(direction))


def bvh(obj):
    return BVHTree.FromPolygons([v.co.copy() for v in obj.data.vertices], [p.vertices[:] for p in obj.data.polygons])


def drop_faces(obj, gone):
    """Delete the faces for which gone(face) is true, and the points left loose."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if gone(f)], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def plane_cut(obj, co, no, region=None):
    """Split the faces the plane crosses (only those whose centre passes region(centre)), so a
    material can change along it."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    faces = [f for f in bm.faces if region is None or region(f.calc_center_median())]
    edges = list({e for f in faces for e in f.edges})
    verts = list({v for f in faces for v in f.verts})
    bmesh.ops.bisect_plane(bm, geom=verts + edges + faces, plane_co=co, plane_no=no, dist=1e-5)
    bm.to_mesh(obj.data)
    bm.free()


def cylinder_uvs(obj, around):
    """UVs for the leopard print: round the local z axis (around repeats) and up it, but straight
    down onto x, y where the skin faces up or down (the top of the shoulder, the crotch)."""
    me = obj.data
    uv = me.uv_layers.new(name="UVMap").data
    for p in me.polygons:
        pts = [me.vertices[me.loops[i].vertex_index].co for i in p.loop_indices]
        if abs(p.normal.z) > 0.75:
            vals = [(c.x / TILE, c.y / TILE) for c in pts]
        else:
            vals = [(math.atan2(c.y, c.x) / (2 * math.pi) * around, c.z / TILE) for c in pts]
            us = [u for u, _ in vals]
            if max(us) - min(us) > around / 2:  # across the seam behind his right side: unwrap
                vals = [(u + around if u < 0 else u, v) for u, v in vals]
        for i, val in zip(p.loop_indices, vals):
            uv[i].uv = val


def face_uvs(obj):
    """UVs for the face texture: straight on from the front (x across, z up)."""
    me = obj.data
    uv = me.uv_layers.new(name="UVMap").data
    for i, lp in enumerate(me.loops):
        c = me.vertices[lp.vertex_index].co
        uv[i].uv = ((c.x - TEX_X0) / TEX_SIZE, (c.z - TEX_Z0) / TEX_SIZE)


def finish(obj, angle=80):
    obj.data.set_sharp_from_angle(angle=math.radians(angle))
    return obj


def interp(table, x):
    xs, ys = zip(*table)
    return np.interp(x, xs, ys)


# ======== Textures: his face from the photo, and a tileable leopard print (rosettes on tan).
def sample(img, x, y):
    """Bilinear lookup in an (h, w, 3) image at pixel positions x, y (top row first)."""
    h, w = img.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001)
    y = np.clip(y - 0.5, 0, h - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    return ((img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy)
            + (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy)


def blur(a, r):
    """A box blur of radius r, three times (about a Gaussian)."""
    for _ in range(3):
        for ax in (0, 1):
            c = np.cumsum(np.pad(a, [(r + 1, r) if i == ax else (0, 0) for i in range(a.ndim)], mode="edge"), axis=ax)
            a = (np.take(c, range(2 * r + 1, c.shape[ax]), axis=ax) - np.take(c, range(0, c.shape[ax] - 2 * r - 1), axis=ax)) / (2 * r + 1)
    return a


def push_pull(img, mask):
    """Fill where mask is 0 with the colours round it, spreading outwards smoothly."""
    levels = []
    a, m = img * mask[..., None], mask.astype(float)
    while a.shape[0] > 1:
        levels.append((a, m))
        a = a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]
        m = m[0::2, 0::2] + m[1::2, 0::2] + m[0::2, 1::2] + m[1::2, 1::2]
    fill = a / max(m[0, 0], 1e-9)
    for a, m in reversed(levels):
        up = blur(fill.repeat(2, 0).repeat(2, 1), 1)
        w = np.clip(m, 0, 1)[..., None]
        fill = a / np.maximum(m, 1e-9)[..., None] * w + up * (1 - w)
    return fill


def to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


SKIN_SRGB = np.array([0.82, 0.62, 0.51])  # light skin with warm tones: his face is brightened to this
HAIR_SRGB = np.array([0.27, 0.161, 0.102])  # dark auburn brown


def face_pixels(n=512):
    """His face as a front-on texture (rows from the bottom, as Blender keeps them), the photo
    levelled, cropped and turned (per row, round the middle of his face) so his features sit
    symmetrically; outside his face it carries on in his own colours and fades to skin. Also his
    skin colour, and the levelled photo crop for comparison."""
    if not os.path.exists(PHOTO):
        sys.exit(f"strongman: face photo not found: {PHOTO}")
    im = bpy.data.images.load(PHOTO)
    w, h = im.size
    photo = np.array(im.pixels[:]).reshape(h, w, 4)[::-1, :, :3]
    bpy.data.images.remove(im)
    (rx, ry), (lx, ly) = EYES_PX
    cx, cy = (rx + lx) / 2, (ry + ly) / 2
    tilt = math.atan2(ry - ly, lx - rx)

    def unlevel(x, y):
        dx, dy = x - cx, y - cy
        return cx + math.cos(tilt) * dx + math.sin(tilt) * dy, cy - math.sin(tilt) * dx + math.cos(tilt) * dy

    xs = TEX_X0 + (np.arange(n) + 0.5) / n * TEX_SIZE
    zs = TEX_Z0 + (np.arange(n) + 0.5) / n * TEX_SIZE
    rows = EYE_ROW + (Z_EYE - zs) / K
    ys, ls, rs = zip(*OUTLINE)
    px = np.empty((n, n))
    half = np.empty(n)
    for j, py in enumerate(rows):
        lft, rgt, mid = np.interp(py, ys, ls), np.interp(py, ys, rs), interp(MIDLINE, py)
        half[j] = (rgt - lft) / 2 * K
        cl, cr = mid - min(73.5, 0.7 * (mid - lft)), mid + min(73.5, 0.7 * (rgt - mid))
        src = [lft - 300, lft - 1e-3, cl, mid, cr, rgt + 1e-3, rgt + 300]
        dst = [-half[j] - 300 * K, -half[j], -(mid - cl) * K, 0.0, (cr - mid) * K, half[j], half[j] + 300 * K]
        px[j] = np.interp(xs, dst, src)
    py = np.repeat(rows[:, None], n, axis=1)
    sx, sy = unlevel(px, py)
    tex = sample(photo, sx, sy)
    x = np.repeat(xs[None, :], n, axis=0)
    z = np.repeat(zs[:, None], n, axis=1)
    hair = np.interp(px, *zip(*HAIRLINE))
    face = (np.abs(x) < half[:, None] - 0.004) & (py > hair + 4) & (half[:, None] > 0.006)
    # His skin colour: forehead and cheeks, away from brows, eyes, nose and beard.
    skin_area = face & (((np.abs(x) < 0.035) & (z > Z_EYE + 0.026) & (z < Z_EYE + 0.045))
                        | ((np.abs(x) > 0.038) & (np.abs(x) < 0.056) & (z > Z_EYE - 0.032) & (z < Z_EYE - 0.016)))
    # The photo is backlit and a little magenta: brighten it so his skin is as light as SKIN_SRGB
    # and take the colour most of the way there (gains in linear light, a soft roll-off on top).
    med = np.median(tex[skin_area], axis=0)
    luma = lambda c: (to_linear(c) * np.array([0.2126, 0.7152, 0.0722])).sum(axis=-1)
    expo = luma(SKIN_SRGB) / luma(med)
    gain = expo * (to_linear(SKIN_SRGB) / to_linear(med) / expo) ** 0.6

    def correct(c):
        c = to_linear(c) * gain
        return to_srgb(np.where(c > 0.6, 0.6 + (c - 0.6) / (1 + (c - 0.6) / 0.4), c))
    tex = correct(tex)
    skin = correct(med)
    # Even out the light: his bare skin's colour, smoothed over a few centimetres, divided out
    # most of the way (the window lit one cheek brighter and cooler); the detail stays.
    bare = face & (z > Z_EYE + interp(BEARD_TOP, np.abs(x)) + 0.004)
    light = np.stack([blur(c, 24) for c in np.moveaxis(push_pull(tex, bare.astype(float)), 2, 0)], axis=2)
    even = (np.median(tex[bare], axis=0) / np.maximum(light, 1e-3)) ** 0.75
    tex = np.where(face[..., None], tex * even, tex)
    # The beard darker and warmer again after the brightening, auburn brown as in his other photos
    # (its dark, hairy pixels most), so it reads as a beard from afar.
    beard = z < Z_EYE + interp(BEARD_TOP, np.abs(x)) + 0.003
    lips = (np.abs(x) < 0.022) & (z > Z_EYE - 0.075) & (z < Z_EYE - 0.055)
    dark = smoothstep(0.66, 0.4, tex.mean(axis=2)) * beard
    tex = to_srgb(to_linear(tex) * (1 + dark[..., None] * (np.array([0.95, 0.68, 0.48]) - 1)))
    # Outside his face: beside the jaw more beard (from the beard alone), elsewhere his skin.
    hairy = face & beard & ~lips & (tex.mean(axis=2) < 0.5)
    rng = np.random.default_rng(3)
    grain = 1 + 0.12 * blur(rng.standard_normal((n, n)), 1).clip(-2, 2)
    soft = smoothstep(0.004, -0.008, z - Z_EYE - interp(BEARD_TOP, np.abs(x)))
    outside = (push_pull(tex, hairy.astype(float)) * grain[..., None] * soft[..., None]
               + push_pull(tex, face.astype(float)) * (1 - soft[..., None]))
    tex = np.where(face[..., None], tex, outside)
    # Round the edges (not in the beard): into plain skin, as on the rest of his head.
    edge = smoothstep(half[:, None] - 0.016, half[:, None] - 0.005, np.abs(x))
    b = edge * ~beard
    tex = tex * (1 - b[..., None]) + skin * b[..., None]
    above = smoothstep(hair + 6, hair - 4, py)
    tex = tex * (1 - above[..., None]) + HAIR_SRGB * above[..., None]
    crop_x, crop_y = np.meshgrid(np.arange(90, 530) + 0.5, np.arange(150, 700) + 0.5)
    crop = sample(photo, *unlevel(crop_x, crop_y))
    return np.clip(tex, 0, 1), skin, crop


def leopard_pixels(n=512, seed=11):
    rng = np.random.default_rng(seed)
    yy, xx = (np.mgrid[0:n, 0:n] + 0.5) / n
    # Tan ground with a soft tileable mottle.
    mottle = sum(a * np.sin(2 * np.pi * (fx * xx + fy * yy) + rng.uniform(0, 6.3))
                 for a, fx, fy in ((0.05, 1, 2), (0.04, 3, -1), (0.03, -2, 5), (0.025, 6, 3)))
    ground = np.array([0.8, 0.6, 0.35])
    inner = np.array([0.62, 0.38, 0.17])
    spot = np.array([0.15, 0.09, 0.05])
    img = ground * (1 + mottle)[..., None]
    ink = np.zeros((n, n))
    fill = np.zeros((n, n))
    g = 5
    px = 1.0 / n
    for i in range(g):
        for j in range(g):
            cx = (i + 0.5 + rng.uniform(-0.28, 0.28)) / g
            cy = (j + 0.5 + rng.uniform(-0.28, 0.28)) / g
            R = rng.uniform(0.27, 0.36) / g
            dx = (xx - cx + 0.5) % 1 - 0.5
            dy = (yy - cy + 0.5) % 1 - 0.5
            rho = np.hypot(dx, dy)
            th = np.arctan2(dy, dx)
            wob = 1 + 0.12 * np.sin(3 * th + rng.uniform(0, 6.3)) + 0.06 * np.sin(5 * th + rng.uniform(0, 6.3))
            fill = np.maximum(fill, smoothstep(0.92, 0.78, rho / (R * wob)))
            k = int(rng.integers(4, 7))
            ph = rng.uniform(0, 2 * np.pi)
            for b in range(k):
                a = ph + 2 * np.pi * b / k + rng.uniform(-0.2, 0.2)
                half = rng.uniform(0.32, 0.46) * 2 * np.pi / k
                t = ((th - a + np.pi) % (2 * np.pi) - np.pi) / half
                w = rng.uniform(0.16, 0.24) * R * np.sqrt(np.clip(1 - t * t, 0, 1))
                ink = np.maximum(ink, smoothstep(-px, px, w - np.abs(rho - R * wob)))
            for _ in range(int(rng.integers(0, 3))):  # a few small solid spots between the rosettes
                sx, sy = cx + rng.uniform(-0.5, 0.5) / g, cy + rng.uniform(-0.5, 0.5) / g
                r = rng.uniform(0.05, 0.09) / g
                d = np.hypot((xx - sx + 0.5) % 1 - 0.5, (yy - sy + 0.5) % 1 - 0.5)
                if np.hypot((sx - cx + 0.5) % 1 - 0.5, (sy - cy + 0.5) % 1 - 0.5) > R * 1.5:
                    ink = np.maximum(ink, smoothstep(px, -px, d - r))
    img = img * (1 - fill[..., None]) + inner * (1 + mottle)[..., None] * fill[..., None]
    img = img * (1 - ink[..., None]) + spot * ink[..., None]
    return np.clip(img, 0, 1)


def image(name, pixels, keep=True):
    """A Blender image from (h, w, 3) sRGB pixels, rows from the bottom."""
    h, w = pixels.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    rgba = np.concatenate([pixels, np.ones((h, w, 1))], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())  # byte image: the values are sRGB, as stored
    if keep:
        img.pack()
    return img


bpy.ops.wm.read_factory_settings(use_empty=True)
FACE_PX, SKIN_RGB, PHOTO_CROP = face_pixels()
face_img = image("FaceTex", FACE_PX)
M = {
    "Skin": material("Skin", SKIN_RGB, 0.62),
    "Face": material("Face", "#ffffff", 0.62, face_img),
    "Eyes": material("Eyes", "#ffffff", 0.35, face_img),
    "Hair": material("Hair", HAIR_SRGB, 0.75),
    "Leopard": material("Leopard", "#ffffff", 0.7, image("LeopardTex", leopard_pixels())),
}
print("skin colour (sRGB)", tuple(round(float(v), 3) for v in SKIN_RGB))


# ======== Body: the hips and torso, a big chest, pecs, six-pack, lats, traps and glutes.
def body():
    p = [ell((0, 0.0, 1.33), (0.17, 0.14, 0.185)),         # ribcage
         ell((0, 0.035, 1.40), (0.15, 0.108, 0.12)),        # round upper back
         ell((0, 0.0, 1.11), (0.142, 0.114, 0.15)),         # waist
         ell((0, -0.04, 0.99), (0.12, 0.075, 0.1)),         # lower belly
         ell((0, 0.012, 0.95), (0.168, 0.112, 0.115))]      # pelvis
    core = [(Vector(c), Vector(r)) for c, r in (((0, 0.0, 1.33), (0.17, 0.14, 0.185)), ((0, 0.0, 1.11), (0.142, 0.114, 0.15)),
                                                  ((0, -0.04, 0.99), (0.12, 0.075, 0.1)))]

    def front(x, z):
        """The front of the core (most forward y) at x, z."""
        y = 0.0
        for c, r in core:
            q = 1 - ((x - c.x) / r.x) ** 2 - ((z - c.z) / r.z) ** 2
            if q > 0:
                y = min(y, c.y - r.y * math.sqrt(q))
        return y

    for s in (1, -1):
        p.append(belly((s * 0.025, -0.13, 1.355), (s * 0.178, -0.075, 1.43), 0.074, 0.044, (s * 0.3, -1, 0.1)))   # pec
        p.append(ell((s * 0.14, 0.01, 1.45), (0.07, 0.08, 0.06)))                                                 # shoulder girdle
        p.append(belly((s * 0.03, 0.045, 1.588), (s * 0.18, 0.015, 1.488), 0.046, 0.042, (s * 0.3, 0.3, 1)))      # upper trap
        p.append(belly((s * 0.165, 0.03, 1.40), (s * 0.08, 0.085, 1.10), 0.07, 0.036, (s * 0.8, 0.6, 0)))          # lat
        p.append(belly((s * 0.125, -0.05, 1.25), (s * 0.128, -0.025, 1.07), 0.032, 0.026, (s, -0.4, 0)))          # serratus, obliques
        p.append(ell((s * 0.125, 0.0, 1.05), (0.03, 0.065, 0.04)))                                                # over the hip bone
        p.append(ell((s * 0.035, 0.095, 1.09), (0.03, 0.026, 0.12)))                                              # spinal erectors
        p.append(ell((s * 0.075, 0.065, 0.92), (0.08, 0.062, 0.09), Matrix.Rotation(s * math.radians(8), 3, "Y")))  # glute
        for z in (1.235, 1.165, 1.095):  # the six-pack, standing about a centimetre proud
            x = s * 0.034
            p.append(ell((x, front(x, z) + 0.01, z), (0.03, 0.019, 0.031), frame((0, 0, 1), (s * 0.25, -1, 0))))
    p.append(ell((0, 0.108, 1.40), (0.10, 0.035, 0.09)))     # mid traps, rhomboids
    p.append(ell((0, 0.02, 1.52), (0.072, 0.068, 0.06)))     # the base of the neck, in the traps
    p.append(ell((0, 0.118, 1.28), (0.05, 0.02, 0.08)))      # lower traps
    p.append(ell((0, front(0, 1.02) + 0.012, 1.02), (0.065, 0.02, 0.045)))  # below the navel
    obj = fuse(p, "Body", 0.0045, 24)
    symmetrize(obj)
    return obj


# ======== Arms: deltoid, biceps, triceps from the shoulder (a ball round the pivot) to the elbow
# (a ball round the elbow); forearms from the elbow ball to a loosely closed hand.
def arm():
    """The left arm in its own frame: the shoulder pivot at the origin, hanging along -z."""
    e = (0, 0, -UPPER)
    p = [ell((0, 0, 0), (0.074, 0.074, 0.074)),
         belly((0.035, 0.0, 0.03), (0.04, 0.0, -0.15), 0.042, 0.035, (1, 0, 0)),          # lateral deltoid
         belly((0.01, -0.045, 0.02), (0.035, -0.03, -0.135), 0.03, 0.03, (0.3, -1, 0)),   # front deltoid
         belly((0.01, 0.045, 0.02), (0.035, 0.03, -0.135), 0.03, 0.03, (0.3, 1, 0)),     # rear deltoid
         capsule((0, 0, -0.02), e, 0.05, 0.042),                                          # the bone, the core
         belly((0.0, -0.03, -0.07), (-0.004, -0.032, -0.29), 0.045, 0.05, (0, -1, 0)),    # biceps
         belly((0.032, -0.012, -0.17), (0.022, -0.018, -0.3), 0.024, 0.026, (1, -0.6, 0)),  # brachialis
         belly((-0.02, 0.032, -0.05), (-0.008, 0.03, -0.27), 0.04, 0.045, (-0.4, 1, 0)),   # triceps, long head
         belly((0.032, 0.028, -0.08), (0.018, 0.032, -0.24), 0.034, 0.04, (0.7, 0.7, 0)),  # triceps, outer head
         ell(e, (0.047, 0.047, 0.047))]
    return fuse(p, "Arm_L", 0.0035, 14)


def forearm():
    """The left forearm in its own frame: the elbow pivot at the origin, hanging along -z, with
    the hand: palm towards the thigh (-x), thumb in front, fingers curled into a loose fist."""
    w = -FORE
    p = [ell((0, 0, 0), (0.045, 0.045, 0.045)),
         capsule((0, 0, 0), (0, 0, w), 0.04, 0.026),
         belly((0.03, -0.013, -0.015), (0.023, -0.012, -0.18), 0.035, 0.037, (1, -0.5, 0)),  # brachioradialis
         belly((-0.022, -0.019, -0.03), (-0.013, -0.015, -0.2), 0.037, 0.034, (-0.6, -1, 0)),  # flexors
         belly((0.01, 0.022, -0.02), (0.006, 0.017, -0.2), 0.034, 0.032, (0.3, 1, 0)),       # extensors
         ell((0, 0, w + 0.01), (0.021, 0.031, 0.025)),                                      # wrist
         ell((0.002, -0.002, w - 0.055), (0.022, 0.05, 0.056))]                             # palm
    for y, length, r in ((-0.034, 1.08, 0.0118), (-0.012, 1.16, 0.012), (0.011, 1.1, 0.0115), (0.031, 0.9, 0.0105)):
        k = Vector((0.004, y, w - 0.106))
        d = 0.0
        for seg, bend in ((0.045, 55), (0.028, 75), (0.021, 45)):
            d += math.radians(bend)
            nxt = k + Vector((-math.sin(d), 0.0, -math.cos(d))) * seg * length
            p.append(capsule(k, nxt, r, r * 0.95, 10))
            k = nxt
    thumb = [Vector((-0.006, -0.03, w - 0.02)), Vector((-0.02, -0.046, w - 0.058)), Vector((-0.034, -0.044, w - 0.088)),
             Vector((-0.043, -0.034, w - 0.104))]
    for a, b, r in zip(thumb, thumb[1:], (0.016, 0.013, 0.0118)):
        p.append(capsule(a, b, r, r * 0.92, 10))
    return fuse(p, "Forearm_L", 0.003, 8)


# ======== Legs: a ball round the hip pivot, quads with the outer sweep and the teardrop, the
# hamstrings, the knee, a diamond calf, the ankle and a bare foot flat on the floor.
def leg():
    floor = -HIP.z
    k, a = Vector((0.003, -0.008, -0.425)), Vector((0.012, 0.012, -0.85))
    p = [ell((0, 0, 0), (0.09, 0.09, 0.09)),
         capsule((0, 0, 0), k, 0.078, 0.058),
         belly((0.005, -0.058, -0.08), (0.0, -0.058, -0.36), 0.048, 0.048, (0, -1, 0)),        # rectus femoris
         belly((0.055, -0.012, -0.1), (0.047, -0.03, -0.37), 0.052, 0.052, (1, -0.3, 0)),      # outer sweep
         belly((-0.04, -0.035, -0.25), (-0.035, -0.045, -0.40), 0.035, 0.04, (-0.8, -0.6, 0)),  # teardrop
         belly((-0.045, 0.0, -0.06), (-0.03, -0.005, -0.27), 0.045, 0.045, (-1, 0, 0)),        # adductors
         belly((0.0, 0.055, -0.08), (0.0, 0.045, -0.37), 0.05, 0.045, (0, 1, 0)),             # hamstrings
         ell(k, (0.06, 0.058, 0.058)),
         ell((0.003, -0.05, -0.415), (0.022, 0.012, 0.026)),                                 # kneecap
         belly((-0.022, 0.036, -0.49), (-0.02, 0.036, -0.67), 0.04, 0.044, (-0.4, 1, 0)),     # calf, inner head
         belly((0.025, 0.032, -0.49), (0.022, 0.03, -0.63), 0.035, 0.04, (0.5, 1, 0)),        # calf, outer head
         belly((0.0, 0.025, -0.56), (0.006, 0.028, -0.79), 0.044, 0.03, (0, 1, 0)),           # soleus
         belly((0.02, -0.028, -0.47), (0.012, -0.02, -0.75), 0.022, 0.022, (0.6, -1, 0)),     # shin muscle
         capsule(k, a, 0.052, 0.034),
         ell(a + Vector((-0.022, 0.0, 0.005)), (0.016, 0.016, 0.016)),                        # ankle bones
         ell(a + Vector((0.024, 0.006, -0.008)), (0.015, 0.015, 0.015)),
         capsule((0.006, 0.04, -0.72), (0.008, 0.045, -0.89), 0.014, 0.016),                  # Achilles tendon
         ell((0.008, 0.045, floor + 0.035), (0.034, 0.034, 0.036)),                           # heel
         ell((0.004, -0.045, floor + 0.03), (0.042, 0.105, 0.032)),                           # sole of the foot
         ell((0.004, -0.04, floor + 0.05), (0.035, 0.07, 0.025)),                             # instep
         ell((0.0, -0.13, floor + 0.016), (0.046, 0.035, 0.017))]                             # ball of the foot
    for (x0, y0), (x1, y1), r in (((-0.026, -0.16), (-0.03, -0.205), 0.0135), ((-0.006, -0.165), (-0.007, -0.2), 0.0095),
                                  ((0.01, -0.16), (0.012, -0.192), 0.009), ((0.024, -0.152), (0.027, -0.18), 0.0085),
                                  ((0.037, -0.14), (0.041, -0.163), 0.008)):
        p.append(capsule((x0, y0, floor + r), (x1, y1, floor + r * 0.9), r, r * 0.9, 10))
    obj = fuse(p, "Leg_L", 0.004, 16)
    co = coords(obj)
    co[:, 2] = np.maximum(co[:, 2], floor)  # a flat sole on the floor
    set_coords(obj, co)
    return obj


# ======== Head: shaped to his photo. Skull and forehead, brow ridge, cheekbones, his jaw and
# chin, a straight nose, lips, ears and the neck; eye sockets carved round the eyeballs. Then his
# beard grown off it (in the face texture, for volume) and his hair, swept up and to his left.
def half_width(z):
    """Half the width of his face (with the beard) at height z, as in the photo."""
    ys, ls, rs = zip(*OUTLINE)
    py = EYE_ROW + (Z_EYE - z) / K
    return (np.interp(py, ys, rs) - np.interp(py, ys, ls)) / 2 * K


def head():
    ze = Z_EYE
    p = [ell(CC, (0.074, 0.097, 0.092)),                                        # skull
         ell((0, -0.045, ze + 0.05), (0.062, 0.045, 0.045)),                    # forehead
         ell((0, -0.071, ze + 0.017), (0.054, 0.013, 0.009)),                   # brow ridge
         ell((0, -0.035, ze - 0.03), (0.064, 0.064, 0.068)),                    # cheeks, upper jaw
         ell((0, -0.022, ze - 0.077), (0.048, 0.066, 0.034)),                   # jaw
         ell((0, -0.079, ze - 0.098), (0.022, 0.016, 0.014)),                   # chin
         ell((0, -0.078, ze - 0.062), (0.03, 0.022, 0.024)),                    # mouth
         belly((0, -0.088, ze + 0.004), (0, -0.104, ze - 0.03), 0.0095, 0.0105, (0, -1, 0.3)),  # bridge of the nose
         ell((0, -0.1035, ze - 0.035), (0.0125, 0.0125, 0.0125)),               # tip of the nose
         ell((0, -0.091, ze - 0.057), (0.021, 0.0105, 0.0075)),                 # upper lip
         ell((0, -0.088, ze - 0.069), (0.019, 0.0105, 0.0075)),                 # lower lip
         capsule(NECK, (0, 0.0, 1.68), 0.06, 0.055)]                            # neck
    for s in (1, -1):
        flare = Matrix.Rotation(-s * math.radians(15), 3, "Z") @ Matrix.Rotation(math.radians(-10), 3, "X")
        p += [ell((s * 0.047, -0.053, ze - 0.014), (0.018, 0.02, 0.014)),      # cheekbone
              belly((s * 0.054, 0.02, ze - 0.02), (s * 0.044, 0.012, ze - 0.066), 0.011, 0.009, (s, 0, 0)),  # back of the jaw
              ell((s * 0.0108, -0.0915, ze - 0.0415), (0.0088, 0.0088, 0.0088)),  # wing of the nose
              belly((s * 0.05, 0.03, 1.68), (s * 0.018, -0.045, 1.53), 0.016, 0.014, (s, -0.5, 0)),  # neck muscle
              ell((s * 0.066, 0.014, ze - 0.0175), (0.01, 0.012, 0.02)),       # the ear's root
              ell((s * 0.069, 0.016, ze - 0.0175), (0.0065, 0.016, 0.0275), flare),  # ear
              ell((s * 0.068, 0.012, ze - 0.041), (0.0072, 0.0075, 0.0075))]   # earlobe
        rim = [Vector((s * 0.069, 0.016, ze - 0.0175)) + flare @ Vector((s * 0.0025, 0.0158 * math.cos(math.radians(a)),
                                                                          0.027 * math.sin(math.radians(a))))
               for a in (150, 120, 90, 60, 30, 0, -30, -60)]
        p += [capsule(a_, b_, 0.0034, 0.0034, 10) for a_, b_ in zip(rim, rim[1:])]  # the ear's rim
    obj = fuse(p, "Head", 0.0022, 5)
    symmetrize(obj)
    co = coords(obj)
    eye_w = np.zeros(len(co))
    socket = np.zeros(len(co))
    for s in (1, -1):
        # Eye sockets: the skin in front of the eye pushed back onto the eyeball in an almond the
        # size of his eyes in the photo, softly round the edge (along rays from the eye's centre,
        # so nothing folds over). What lands on the ball is the eye.
        e = np.array((s * EYE_X, EYE_Y, Z_EYE))
        d = co - e
        dist = np.linalg.norm(d, axis=1)
        az = np.degrees(np.arctan2(s * d[:, 0], -d[:, 1]))
        el = np.degrees(np.arcsin(np.clip(d[:, 2] / dist, -1, 1)))
        w = 1 - smoothstep(0.75, 1.2, np.hypot(az / 52, (el - 1) / 18))
        new = np.where(dist > RE, dist + (RE - dist) * w, dist)
        co[:] = e + d * (new / dist)[:, None]
        eye_w = np.maximum(eye_w, (w > 0.97) * (d[:, 1] < 0))
        socket = np.maximum(socket, (w > 0.02) * (d[:, 1] < 0.004))
        dent(co, (s * 0.0108, -0.096, ze - 0.049), (0.006, 0.008, 0.005), 0.004, (0, 0, 1))  # nostril
        dent(co, (s * 0.076, 0.013, ze - 0.02), (0.007, 0.01, 0.015), 0.005, (-s, 0, 0))    # the hollow of the ear
    dent(co, (0, -0.1, ze - 0.063), (0.02, 0.012, 0.003), 0.0025, (0, 1, 0))                 # between the lips
    set_coords(obj, co)
    # His beard: the skin of the jaw, cheeks, chin and upper lip pushed out, thinning to nothing
    # at its edges (one surface with the face, the face texture on it).
    t = beard_thickness(co)
    set_coords(obj, co + normals(obj) * t[:, None])
    for name, wts in (("beard", np.clip(t / 0.003, 0, 1)), ("eye", eye_w), ("socket", socket)):
        g = obj.vertex_groups.new(name=name)
        for i in np.flatnonzero(wts > 0.01):
            g.add([int(i)], float(wts[i]), "REPLACE")
    return obj


def group_weights(obj, name):
    """Each point's weight in a vertex group (0 where it is not in it)."""
    gi = obj.vertex_groups[name].index
    return np.array([next((g.weight for g in v.groups if g.group == gi), 0.0) for v in obj.data.vertices])


def beard_thickness(co):
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    top = Z_EYE + interp(BEARD_TOP, np.abs(x))
    bottom = np.interp(y, [-0.1, -0.06, -0.03, 0.0, 0.03], [1.597, 1.6, 1.62, 1.645, 1.66])
    back = np.interp(z, [Z_EYE - 0.07, Z_EYE - 0.048, Z_EYE - 0.04], [0.03, 0.03, -0.004])  # behind: only under the ear
    inside = (smoothstep(top + 0.001, top - 0.014, z) * smoothstep(bottom - 0.002, bottom + 0.008, z)
              * smoothstep(back + 0.004, back - 0.008, y))
    t = np.interp(z, [1.59, 1.62, 1.66, 1.69, 1.72], [0.013, 0.012, 0.008, 0.006, 0.004]) * np.interp(y, [-0.03, 0.0, 0.03], [1, 0.6, 0.35])
    lips = smoothstep(1.0, 0.6, np.hypot(x / 0.024, (z - Z_EYE + 0.064) / 0.011)) * (y < -0.07)
    t = t * (1 - 0.85 * lips) + np.array([noise.noise(Vector((abs(c[0]), c[1], c[2])) * 70.0) for c in co]) * 0.0006
    return np.maximum(t, 0.0) * inside


# His hair: a short layer over the scalp (shorter at the sides and back) and many locks over it:
# on top swept up from his right and over to his left, a fringe falling over his left brow, the
# sides combed back, the back down. Thick and a little messy.
HAIR_LINE = [(-180, -46), (-150, -40), (-125, -28), (-110, -6), (-95, -2), (-82, -2), (-76, -24), (-68, -24), (-60, 0),
             (-45, 12), (-25, 14), (0, 14), (25, 12), (45, 9), (60, 0), (68, -24), (76, -24), (82, -2), (95, -2),
             (110, -6), (125, -28), (150, -40), (180, -46)]  # (azimuth from the front, + to his left; elevation) round the skull


def hair_thickness(co):
    """How thick his hair is over each point of the head (negative: none), and where it is."""
    d = co - np.array(CC)
    az = np.degrees(np.arctan2(d[:, 0], -d[:, 1]))
    el = np.degrees(np.arctan2(d[:, 2], np.hypot(d[:, 0], d[:, 1])))
    line = interp(HAIR_LINE, az)
    # The fringe: from the hairline in the middle of his forehead slanting down to just above his
    # left brow, its edge in strands.
    fringe = smoothstep(-6, 2, az) * smoothstep(60, 50, az)
    edge = 14 - 10 * smoothstep(-2, 38, az) + 4 * smoothstep(42, 58, az) + 1.5 * np.sin(np.radians(az) * 20)
    inside = np.maximum(smoothstep(line - 1, line + 2, el), fringe * smoothstep(edge - 1, edge + 2, el))
    # Short at the sides and back, thinning to nothing at its edge; long on top.
    rise = np.maximum(smoothstep(line - 1, line + 5, el), fringe * smoothstep(edge - 1, edge + 5, el))
    t = (0.0045 + 0.005 * smoothstep(15, 60, el) + 0.005 * fringe) * rise
    # Volume swept up from the front (most a little to his right), less to the crown, and over to his left.
    t += 0.018 * np.exp(-((az + 10) / 60) ** 2) * smoothstep(line, line + 14, el) * (1 - 0.5 * smoothstep(55, 85, el))
    t += 0.01 * np.exp(-((az - 32) / 26) ** 2) * np.exp(-((el - 26) / 14) ** 2)
    # Clumps combed along the way it goes: round the head on top and at the sides, down at the back.
    along = np.array([noise.noise(Vector((a_ * 0.035, e_ * 0.2, 0.5))) for a_, e_ in zip(az, el)])
    down = np.array([noise.noise(Vector((a_ * 0.2, e_ * 0.04, 3.5))) for a_, e_ in zip(az, el)])
    back = smoothstep(110, 140, np.abs(az))
    t += (0.005 + 0.008 * smoothstep(25, 50, el)) * (along * (1 - back) + down * back) * rise
    t += 0.0012 * np.array([noise.noise(Vector(c) * 140.0) for c in co])
    return t * inside - 0.004 * (1 - inside), inside


def hair(src, tree, budget):
    """The head pushed out over the scalp by hair_thickness and shrunk a little into itself
    elsewhere (towards the middle, so nothing folds), remeshed; what is inside the head goes."""
    obj = link(bpy.data.objects.new("Hair", src.data.copy()))
    co, nr = coords(obj), normals(obj)
    t, inside = hair_thickness(co)
    shrunk = np.array(CC) + (co - np.array(CC)) * 0.96
    set_coords(obj, shrunk * (1 - inside[:, None]) + (co + nr * t[:, None]) * inside[:, None])
    modify(obj, "REMESH", mode="VOXEL", voxel_size=0.0024, adaptivity=0.0)
    modify(obj, "SMOOTH", factor=0.5, iterations=2)

    def under(f):
        c = f.calc_center_median()
        hit = tree.find_nearest(c)
        return hit[0] is not None and (c - hit[0]).dot(hit[1]) < -0.0008
    drop_faces(obj, under)
    obj.data.materials.clear()
    obj.data.materials.append(M["Hair"])
    return decimate(obj, budget)


# ======== Build the parts.
body_obj = body()
decimate(body_obj, 2000, sym=True)
# The leotard: below a plane from his left shoulder down to under his right arm, and the strap
# over his left shoulder; skin above. The plane slopes the same way at the back.
NECKLINE = (Vector((0.13, 0.0, 1.47)), Vector((-0.61, 0.0, 1.0)).normalized())
STRAP = (0.095, 0.165)
plane_cut(body_obj, *NECKLINE)
above = lambda c: (c - NECKLINE[0]).dot(NECKLINE[1]) > 0 and c.z > 1.36
for x in STRAP:
    plane_cut(body_obj, Vector((x, 0, 0)), Vector((1, 0, 0)), above)
body_obj.data.materials.append(M["Skin"])
body_obj.data.materials.append(M["Leopard"])
for f in body_obj.data.polygons:
    c = f.center
    f.material_index = 0 if above(c) and not STRAP[0] < c.x < STRAP[1] else 1
cylinder_uvs(body_obj, 5)
finish(body_obj)

head_obj = head()
head_tree = bvh(head_obj)
hair_obj = hair(head_obj, head_tree, 800)
decimate(head_obj, 2400, sym=True, keep=np.flatnonzero(group_weights(head_obj, "socket") > 0))  # the eyes kept fine
for name in ("Skin", "Face", "Eyes"):
    head_obj.data.materials.append(M[name])
beard_w, eye_w = group_weights(head_obj, "beard"), group_weights(head_obj, "eye")
head_obj.vertex_groups.clear()
for f in head_obj.data.polygons:
    # The face texture on the front of his face (not his ears) and all over the beard; the eyes
    # glossier; plain skin round it.
    c, vs = f.center, list(f.vertices)
    front = f.normal.y < -0.15 and Z_EYE - 0.105 < c.z < Z_EYE + 0.085 and abs(c.x) < half_width(c.z) - 0.003
    ear = abs(c.x) > 0.06 and Z_EYE - 0.05 < c.z < Z_EYE + 0.02 and c.y > -0.02
    f.material_index = 2 if eye_w[vs].mean() > 0.5 else int((front and not ear) or beard_w[vs].mean() > 0.4)
face_uvs(head_obj)
head_obj = merge([head_obj, hair_obj], "Head")
finish(head_obj, 180)  # all smooth: no creases across his face

arm_l = finish(decimate(arm(), 560))
fore_l = finish(decimate(forearm(), 660))
leg_l = decimate(leg(), 860)
TRUNKS = (Vector((0.0, 0.0, -0.165)), Vector((-0.12, 0.0, 1.0)).normalized())  # the leg opening, higher on the outside
plane_cut(leg_l, *TRUNKS)
leg_l.data.materials.append(M["Skin"])
leg_l.data.materials.append(M["Leopard"])
for f in leg_l.data.polygons:
    f.material_index = 1 if (f.center - TRUNKS[0]).dot(TRUNKS[1]) > 0 else 0
cylinder_uvs(leg_l, 3)
finish(leg_l)
for o in (arm_l, fore_l):
    o.data.materials.append(M["Skin"])

# ======== Assemble: each part's mesh round its pivot, rotated into the rest pose.
out = Matrix.Rotation(-ARM_OUT, 4, "Y")  # the left arm out to the side; the right one mirrored
arm_l.data.transform(out)
fore_l.data.transform(out @ Matrix.Rotation(-ELBOW_BEND, 4, "X"))
elbow = out @ Vector((0.0, 0.0, -UPPER))
nodes = {"Body": body_obj, "Head": head_obj, "Arm_L": arm_l, "Forearm_L": fore_l, "Leg_L": leg_l,
         "Arm_R": mirrored(arm_l, "Arm_R"), "Forearm_R": mirrored(fore_l, "Forearm_R"), "Leg_R": mirrored(leg_l, "Leg_R")}
body_obj.data.transform(Matrix.Translation(-HIP))
body_obj.location = HIP
head_obj.data.transform(Matrix.Translation(-NECK))
head_obj.parent = body_obj
head_obj.location = NECK - HIP  # local to Body; the parent inverse stays identity
for s, side in ((1, "L"), (-1, "R")):
    a = nodes["Arm_" + side]
    a.parent = body_obj
    a.location = Vector((s * SHOULDER.x, SHOULDER.y, SHOULDER.z)) - HIP
    f = nodes["Forearm_" + side]
    f.parent = a
    f.location = Vector((s * elbow.x, elbow.y, elbow.z))
    g = nodes["Leg_" + side]
    g.parent = body_obj
    g.location = Vector((s * HIP_X, 0.0, 0.0))

bpy.context.view_layer.update()
total = 0
for name, o in nodes.items():
    o.data.calc_loop_triangles()
    total += len(o.data.loop_triangles)
    print(f"{name}: {len(o.data.loop_triangles)} triangles, pivot {tuple(round(v, 3) for v in o.matrix_world.translation)}, "
          f"materials {[m.name for m in o.data.materials]}")
print(f"strongman: {total} triangles; eye faces {sum(p.material_index == 2 for p in head_obj.data.polygons)}")

bpy.ops.object.select_all(action="DESELECT")
for o in nodes.values():
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_image_format="JPEG", export_image_quality=88,
                          export_cameras=False, export_lights=False)


def pose(name, x=0.0, y=0.0, z=0.0):
    """Turn a joint as the game would: three.js rotation.set(x, y, z) (Euler XYZ, y up, +z his front)."""
    c = Matrix.Rotation(math.pi / 2, 3, "X")  # glTF axes to Blender's
    o = nodes[name]
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = (c @ Euler((x, y, z), "ZYX").to_matrix() @ c.inverted()).to_quaternion()


# ---- Preview renders.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "ACES 1.3"  # the game renders with ACES filmic tone mapping
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.47, 0.55, 1)
    scene.world = world
    bpy.ops.object.light_add(type="AREA", location=(-2.0, -3.2, 3.6))
    key = bpy.context.active_object
    key.data.energy, key.data.size = 650, 2.5
    key.rotation_euler = (Vector((0, 0, 1.1)) - key.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(35)))
    bpy.context.active_object.data.energy = 1.5
    bpy.ops.mesh.primitive_plane_add(size=40)
    bpy.context.active_object.data.materials.append(material("Floor", "#8a8f86", 0.8))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)

    def shot(label, loc, target, lens, res=(900, 1100)):
        scene.render.resolution_x, scene.render.resolution_y = res
        cam.location = loc
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(PREVIEW, f"strongman_{label}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        return path

    def rest():
        for n in nodes:
            pose(n)
        body_obj.location = HIP

    def pixels_of(path):
        im = bpy.data.images.load(path)
        a = np.array(im.pixels[:]).reshape(im.size[1], im.size[0], 4)[::-1, :, :3]
        bpy.data.images.remove(im)
        return a

    def fit(a, h):
        rows = (np.arange(h) + 0.5) * a.shape[0] / h
        w = int(round(a.shape[1] * h / a.shape[0]))
        cols = (np.arange(w) + 0.5) * a.shape[1] / w
        return sample(a, *np.meshgrid(cols, rows))

    # His face: front and three-quarter, beside the photo crop (for the likeness; the photo goes
    # into this preview only).
    mid = Z_EYE - (425 - EYE_ROW) * K  # the middle of the photo crop, 0.19 m wide: framed the same
    front = shot("face", (0.0, -0.68, mid), (0, -0.08, mid), 114, (800, 1000))
    three = shot("face34", (0.5, -0.72, mid + 0.04), (0, 0, mid + 0.03), 85, (800, 1000))
    side = shot("face_side", (0.88, 0.0, mid + 0.03), (0, 0, mid + 0.03), 85, (800, 1000))
    tex = image("FaceTexPreview", FACE_PX, keep=False)
    tex.filepath_raw = os.path.join(PREVIEW, "strongman_face_texture.png")
    tex.file_format = "PNG"
    tex.save()
    tiles = [fit(PHOTO_CROP, 1000)] + [pixels_of(p) for p in (front, three, side)]
    sheet = np.concatenate(tiles, axis=1)
    im = image("Likeness", sheet[::-1], keep=False)
    im.filepath_raw = os.path.join(PREVIEW, "strongman_likeness.png")
    im.file_format = "PNG"
    im.save()
    shot("front34", (2.4, -4.4, 1.6), (0, 0, 0.93), 45)
    shot("front", (0, -5.0, 1.0), (0, 0, 0.93), 45)
    shot("side", (5.0, 0, 1.0), (0, 0, 0.93), 45)
    shot("back", (-2.2, 4.4, 1.6), (0, 0, 0.93), 45)
    # Mid-stride, with the game's walking rotations (step 0.55: the left leg forward).
    step = 0.55
    pose("Leg_L", -step)
    pose("Leg_R", step)
    pose("Arm_L", step * 0.7)
    pose("Arm_R", -step * 0.7)
    shot("stride", (3.6, -3.4, 1.4), (0, 0, 0.9), 45)
    shot("stride_side", (5.0, 0, 1.0), (0, 0, 0.9), 45)
    rest()
    # A double-biceps flex: the upper arms out to horizontal, the forearms up.
    lift = math.pi / 2 - ARM_OUT
    for s, side in ((1, "L"), (-1, "R")):
        pose("Arm_" + side, 0, 0, s * lift)
        pose("Forearm_" + side, 0, 0, s * 1.9)
    shot("flex", (1.2, -4.6, 1.5), (0, 0, 1.15), 42)
    shot("flex34", (2.8, -3.6, 1.6), (0, 0, 1.15), 42)
    for s, side in ((1, "L"), (-1, "R")):  # the values in web/src/world/clowns.ts now
        pose("Arm_" + side, 0, 0, s * 1.35)
        pose("Forearm_" + side, 0, 0, s * 1.6)
    shot("flex_game", (1.2, -4.6, 1.5), (0, 0, 1.15), 42)
    rest()
    # From 15 m with the game's 72 degree vertical field of view (centre crop), scaled up 2.5 as in the game.
    body_obj.scale = (2.5, 2.5, 2.5)
    body_obj.location = HIP * 2.5
    cam.data.sensor_fit = "VERTICAL"
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    cam.data.angle = math.radians(72)
    cam.location = (4.0, -14.5, 1.65)
    cam.rotation_euler = (Vector((0, 0, 2.2)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.use_border, scene.render.use_crop_to_border = True, True
    scene.render.border_min_x, scene.render.border_max_x = 0.36, 0.64
    scene.render.border_min_y, scene.render.border_max_y = 0.2, 0.8
    scene.render.filepath = os.path.join(PREVIEW, "strongman_15m.png")
    bpy.ops.render.render(write_still=True)
