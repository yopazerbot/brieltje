"""Build the steerable parachute for arrivals by air: canopy, lines, risers, toggles, harness and pack,
rigged and animated, as one GLB for three.js, with review renders.

Run (Blender 5.2, no window), from the repository root:
  blender -b -P tools/parachute/parachute.py --                       # GLB + manifest
  blender -b -P tools/parachute/parachute.py -- --blend <file.blend>  # also an editable .blend
  blender -b -P tools/parachute/parachute.py -- --renders <dir>       # also the review renders
  blender -b -P tools/parachute/parachute.py -- --variants <dir>      # only the design variations
Options: --out <glb> (web/public/models/parachute.glb), --manifest <json> (docs/parachute/manifest.json),
--avatar <glb> (web/public/models/swat.glb), --variant A|B|C (B), --samples <n> (Cycles, 64),
--turntable (with --renders: a turntable video, needs ffmpeg), --no-export.

Our own design, made for Brieltje: a soft rectangular ram-air canopy of nine inflated cells (cream with
alternate cells in the player's colour), cascaded suspension lines, two risers a side with steering
toggles, a harness fitted to the players' figure and a compact pack. No brand marks.

Space and units. Metres. Blender +Y is forward, +Z up, so the GLB (exported Y up) faces -Z with +X on
the pilot's right, as the game's figures do (their Body contract). ParachuteRoot is the pilot's foot
origin: where the feet would stand. The figure itself is not in the file: it stays the game's own
swat.glb. Its measured joints place the harness and the pose guides (see AVATAR below).

The rig. Every bone rests with the armature's axes (it points +Y with no roll), so a bone's pose is a
plain turn in its parent's frame. Bones (glTF node names; three.js keeps underscores):
  Root                       the foot origin, never animated
  Pilot                      the pelvis: the harness hangs from it. The figure's pelvis follows it.
    Pack                     the pack on the back
    RiserFront_L/_R, RiserRear_L/_R   from the harness's connector links up to the lines
    Thigh_L/_R > Shin_L/_R > Foot_L/_R  pose guides for the figure's legs (hip, knee, ankle); the leg
                             loops ride on the thighs
    Elbow_L/_R               where the figure's elbows point (IK pole)
  Grip_L/_R                  where the figure's wrists go (palm centre): on the toggles while steering
  Toggle_L/_R                the steering toggles and the bottom of the brake lines
  Canopy                     the canopy's pivot (mid chord, mid thickness, at the centre)
    Cell_0 .. Cell_8         one per cell, left (0) to right (8): breathing, crumpling, flattening
    Brake_L/_R               turn the trailing edge down on each side
Every vertex follows at most four bones, with weights computed here from where it sits. A line is a
thin tube whose two ends follow exactly what they are tied to (the canopy at that point, a cascade
junction, a riser, a toggle), so lines stay connected in every pose.

Clips (in place: Root never moves; travel and descent belong to the game), sampled at 15 keys a second:
  Deploy        1.8 s once   packed, bag out, line stretch, spread, inflation, settles into Glide_Idle
  Glide_Idle    3.0 s loop   breathing cells, a little surge and sway; last key = first key
  Glide_Left    3.0 s loop   Glide_Idle with the left toggle pulled, canopy banked and turning left
  Glide_Right   3.0 s loop   the mirror
  Flare         0.8 s once   both toggles down, canopy pitched up, legs ready to land
  Land_Collapse 2.4 s once   touchdown, canopy falls in front and is stowed into the pack
All are whole poses (not additive). The three glide clips move in step, so the game blends them by
weight at one shared time.

Output: the GLB, a manifest (node names and transforms as exported, clips, bounds, budgets, the pilot
pose guides) and, on request, an editable .blend and the review renders.
"""
import argparse
import copy
import json
import math
import os
import random
import struct
import sys
import types

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
FPS = 30
STEP = 2                       # a key every other frame (15 a second)
LOOP = 3.0                     # s, the glide loops
CLIPS = {"Deploy": 1.8, "Glide_Idle": LOOP, "Glide_Left": LOOP, "Glide_Right": LOOP, "Flare": 0.8, "Land_Collapse": 2.4}
LOOPING = {"Glide_Idle", "Glide_Left", "Glide_Right"}
HEIGHT = 1.8                   # the game draws its figures 1.8 m tall


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="blender -b -P tools/parachute/parachute.py --")
    ap.add_argument("--out", default=os.path.join(REPO, "web", "public", "models", "parachute.glb"))
    ap.add_argument("--manifest", default=os.path.join(REPO, "docs", "parachute", "manifest.json"))
    ap.add_argument("--avatar", default=os.path.join(REPO, "web", "public", "models", "swat.glb"))
    ap.add_argument("--blend", default="")
    ap.add_argument("--renders", default="")
    ap.add_argument("--variants", default="")
    ap.add_argument("--variant", default="B", choices=["A", "B", "C"])
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--turntable", action="store_true")
    ap.add_argument("--no-export", action="store_true")
    return ap.parse_args(argv)


ARGS = args()


# ======== Small helpers.
def rgb(h):
    """sRGB hex to three 0..1 values (still sRGB)."""
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


def tone(c, k):
    return tuple(min(1.0, v * k) for v in c)


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(a, b, w):
    """Blend two poses (numbers, Vectors, Quaternions, and lists, tuples and dicts of them)."""
    if isinstance(a, Quaternion):
        return a.slerp(b, min(1.0, max(0.0, w)))
    if isinstance(a, Vector):
        return a.lerp(b, w)
    if isinstance(a, dict):
        return {k: mix(a[k], b[k], w) for k in a}
    if isinstance(a, (list, tuple)):
        return type(a)(mix(x, y, w) for x, y in zip(a, b))
    return a + (b - a) * w


def keyed(keys, t):
    """A pose at time t from [(time, pose), ...], eased (smoothstep) between neighbouring keys."""
    if t <= keys[0][0]:
        return copy.deepcopy(keys[0][1])
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t <= t1:
            return mix(a, b, smooth((t - t0) / (t1 - t0)))
    return copy.deepcopy(keys[-1][1])


def qx(a):
    return Quaternion((1, 0, 0), a)


def qy(a):
    return Quaternion((0, 1, 0), a)


def qz(a):
    return Quaternion((0, 0, 1), a)


def to_gltf(v):
    """Blender (x, y, z) to glTF Y up (x, z, -y)."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


# ======== Colours (sRGB). The accent faces are white in the vertex colours: the material's colour is the
# player's colour (the game sets it), multiplied by white.
VARIANTS = {
    # accent cells, slate cells
    "A": ({3, 4, 5}, {0, 8}),          # a centre band in the player's colour, slate tips
    "B": ({0, 2, 4, 6, 8}, set()),     # alternate cells: the player's colour, from below and above
    "C": ({0, 1, 7, 8}, {4}),          # coloured tips, a slate centre cell
}
CREAM, CREAM_UNDER = rgb("#efe6d3"), rgb("#e9dfcb")
SLATE, SLATE_UNDER = rgb("#5a6b7c"), rgb("#4d5d6d")
WHITE = (1.0, 1.0, 1.0)
MOUTH = rgb("#6a6057")
LINE_UP, LINE_LOW, LINE_BRAKE = rgb("#bdb6aa"), rgb("#8d8880"), rgb("#c9a04a")
WEB, WEB_LIGHT, METAL = rgb("#2b2f35"), rgb("#3c424a"), rgb("#a7abb0")
PACK, PACK_DARK = rgb("#4a5662"), rgb("#38424c")
ACCENT_DEFAULT = "#e0733a"    # shown until the game sets the player's colour
FABRIC, ACCENT, GEAR = 0, 1, 2     # Parachute_Canopy, Parachute_Accent, Parachute_Gear
GLOW = 0.28                        # the canopy's faint emissive: light through the fabric, so the shaded
                                   # underside still reads (glTF emissiveFactor = colour x GLOW)


# ======== The figure: the game's swat.glb, scaled to 1.8 m and turned to face +Y (the GLB's -Z).
def game_scale(path):
    """The scale and lift net/swat.ts gives the figure: 1.8 m over the height of its skinned meshes as three.js
    loads them (Box3.setFromObject skins them in the pose of the file's nodes, which isn't the bind pose:
    1.82 m there against 1.85 m in the bind pose). Done here the same way: joint transforms, inverse bind
    matrices, four weights."""
    data = open(path, "rb").read()
    jl = struct.unpack("<I", data[12:16])[0]
    j = json.loads(data[20:20 + jl])
    blob_ = data[20 + jl + 8:]
    comps = {5126: np.float32, 5123: np.uint16, 5121: np.uint8, 5125: np.uint32}
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

    def acc(i):
        a = j["accessors"][i]
        bv = j["bufferViews"][a["bufferView"]]
        dt, n = comps[a["componentType"]], ncomp[a["type"]]
        item = np.dtype(dt).itemsize * n
        stride = bv.get("byteStride", item)
        base = np.frombuffer(blob_, np.uint8, (a["count"] - 1) * stride + item, bv.get("byteOffset", 0) + a.get("byteOffset", 0))
        rows = np.lib.stride_tricks.as_strided(base, (a["count"], item), (stride, 1))
        arr = np.frombuffer(rows.tobytes(), dt).reshape(a["count"], n)
        return arr / np.iinfo(dt).max if a.get("normalized") else arr
    nodes = j["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def local(n):
        M = np.eye(4)
        M[:3, :3] = np.array(Quaternion((n.get("rotation", [0, 0, 0, 1])[3], *n.get("rotation", [0, 0, 0, 1])[:3])).to_matrix()) * np.array(n.get("scale", [1, 1, 1]))
        M[:3, 3] = n.get("translation", [0, 0, 0])
        return M

    def world(i):
        M = local(nodes[i])
        while i in parent:
            i = parent[i]
            M = local(nodes[i]) @ M
        return M
    ys = []
    for i, n in enumerate(nodes):
        if "skin" not in n:
            continue
        sk = j["skins"][n["skin"]]
        ibm = acc(sk["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
        S = np.array([world(jt) @ ibm[k] for k, jt in enumerate(sk["joints"])])   # glTF ignores the mesh node's own transform
        for pr in j["meshes"][n["mesh"]]["primitives"]:
            P = acc(pr["attributes"]["POSITION"]).astype(np.float64)
            Jt = acc(pr["attributes"]["JOINTS_0"]).astype(int)
            Wt = acc(pr["attributes"]["WEIGHTS_0"]).astype(np.float64)
            Ph = np.c_[P, np.ones(len(P))]
            out = np.zeros((len(P), 4))
            for k in range(4):
                out += Wt[:, k:k + 1] * np.einsum("nij,nj->ni", S[Jt[:, k]], Ph)
            ys.append(out[:, 1])
    y = np.concatenate(ys)
    scale = HEIGHT / float(y.max() - y.min())
    return scale, -float(y.min()) * scale


def import_avatar(path):
    """Import swat.glb under an 'Avatar' empty (scaled to the game's 1.8 m, facing +Y) in its rest pose.
    Returns (empty, armature, meshes, new objects)."""
    before = set(bpy.data.objects)
    acts = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    for o in [o for o in new if o.type == "MESH" and o.parent != arm]:   # the importer's bone shape
        new.remove(o)
        bpy.data.objects.remove(o)
    meshes = [o for o in new if o.type == "MESH"]
    if arm.animation_data:
        arm.animation_data.action = None
    for a in set(bpy.data.actions) - acts:
        bpy.data.actions.remove(a)
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    top = [o for o in new if o.parent is None]
    av = bpy.data.objects.new("Avatar", None)
    bpy.context.scene.collection.objects.link(av)
    for o in top:
        o.parent = av
    bpy.context.view_layer.update()
    s, lift = game_scale(path)
    av.scale = (s, s, s)
    av.location.z = lift
    av.rotation_euler = (0, 0, math.pi)
    bpy.context.view_layer.update()
    return av, arm, meshes, new + [av]


def avatar_verts(meshes):
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in meshes:
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        m = np.array(e.matrix_world)
        c = np.zeros(len(me.vertices) * 3)
        me.vertices.foreach_get("co", c)
        c = c.reshape(-1, 3)
        out.append(c @ m[:3, :3].T + m[:3, 3])
        e.to_mesh_clear()
    return np.concatenate(out)


def bone_world(arm, name):
    return arm.matrix_world @ arm.data.bones[name].head_local


def measure(path):
    """The figure's joints and surface (rest pose, metres, this file's axes)."""
    av, arm, meshes, objs = import_avatar(path)
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    V = avatar_verts(meshes)
    J = {}
    for key, bone in (("pelvis", "Body"), ("chest", "Chest"), ("neck", "Neck"), ("head", "Head")):
        J[key] = bone_world(arm, bone)
    for s in "LR":
        for key, bone in (("hip", "UpperLeg"), ("knee", "LowerLeg"), ("foot", "Foot"), ("shoulder", "UpperArm"),
                          ("elbow", "LowerArm"), ("wrist", "Wrist")):
            J[f"{key}_{s}"] = bone_world(arm, f"{bone}.{s}")
        # The lower leg ends at the foot bone's head (LowerLeg.X_end in the GLB; Blender's importer puts its
        # own LowerLeg.X_end empties near the knee, so they aren't used).
        J[f"ankle_{s}"] = bone_world(arm, f"Foot.{s}")
    J["top"] = Vector((0, 0, float(V[:, 2].max())))
    arm.data.pose_position = "POSE"
    scale = av.scale[0]
    for o in objs:
        bpy.data.objects.remove(o)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)
    return V, J, scale


V_AV, J, AV_SCALE = measure(ARGS.avatar)
for s, sx in (("L", -1), ("R", 1)):   # the figure's left is -X here
    assert J[f"shoulder_{s}"].x * sx > 0, "the figure should face +Y with its left at -X"


def band(z, half=0.018, sel=None):
    b = V_AV[np.abs(V_AV[:, 2] - z) < half]
    return b if sel is None else b[sel(b)]


def surf(x, z, front=True, dx=0.025, dz=0.025):
    """The figure's front (max y) or back (min y) at (x, z)."""
    b = V_AV[(np.abs(V_AV[:, 0] - x) < dx) & (np.abs(V_AV[:, 2] - z) < dz)]
    return float(b[:, 1].max() if front else b[:, 1].min())


def top_at(x, y, d=0.025):
    b = V_AV[(np.abs(V_AV[:, 0] - x) < d) & (np.abs(V_AV[:, 1] - y) < d)]
    return float(b[:, 2].max())


def outline(z, n, pad, sel=None, half=0.018):
    """A closed outline round the figure's section at height z: the farthest point in each of n directions
    from the section's centre, smoothed, padded. Returns (centre, [points])."""
    b = band(z, half, sel)
    c = (b[:, :2].max(0) + b[:, :2].min(0)) / 2
    d = b[:, :2] - c
    ang = np.arctan2(d[:, 1], d[:, 0])
    r = np.hypot(d[:, 0], d[:, 1])
    bins = ((ang + math.pi) / (2 * math.pi) * n).astype(int) % n
    R = np.zeros(n)
    for k in range(n):
        m = r[bins == k]
        R[k] = m.max() if len(m) else np.nan
    ok = ~np.isnan(R)
    R = np.interp(np.arange(n), np.arange(n)[ok], R[ok], period=n)
    R = np.maximum(R, (np.roll(R, 1) + np.roll(R, -1)) / 2)   # no dents between bins
    pts = []
    for k in range(n):
        a = -math.pi + (k + 0.5) * 2 * math.pi / n
        pts.append(Vector((c[0] + (R[k] + pad) * math.cos(a), c[1] + (R[k] + pad) * math.sin(a), z)))
    return Vector((c[0], c[1], z)), pts


# ======== The canopy's shape (this file's axes, rest = steady glide).
SPAN, CELLS = 6.0, 9           # m along the arc (flat span), cells
HALF, CW = SPAN / 2, SPAN / CELLS
ARC_R = 5.4                    # m, the span's curve: tips 0.81 m lower, 5.69 m across
CHORD, CHORD_DROP = 2.45, 0.25
TRIM = math.radians(7)         # nose down
T_MAX, CAMBER, CAMBER_AT, MOUTH_C = 0.17, 0.04, 0.40, 0.05
CANOPY_HEAD = Vector((0.0, -0.15, 5.50))   # the pilot hangs under about 44 % of the chord
CELL_S = [-HALF + CW * (i + 0.5) for i in range(CELLS)]
TRIM_M = Matrix.Rotation(-TRIM, 3, "X")


def chord_at(s):
    k = (1 - min(1.0, abs(s) / HALF) ** 8) ** 0.125
    return (CHORD - CHORD_DROP * (s / HALF) ** 2) * (0.35 + 0.65 * k)


def foil(c):
    t = 5 * T_MAX * (0.2969 * math.sqrt(c) - 0.1260 * c - 0.3516 * c * c + 0.2843 * c ** 3 - 0.1036 * c ** 4)
    p = CAMBER_AT
    yc = CAMBER / p ** 2 * (2 * p * c - c * c) if c < p else CAMBER / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * c - c * c)
    return yc, t


FOIL_T = foil(0.3)[1]


def bulge(s):
    """0 on a rib, 1 mid-cell."""
    u = ((s + HALF) / CW) % 1.0
    return math.sin(math.pi * u) ** 0.8


def local(s, c, where):
    """A point of the canopy before the arc: (span, forward, up). where: 'upper', 'lower' or a mouth
    fraction (0..1 from the nose down to the lower lip)."""
    L = chord_at(s)
    b = bulge(s) if abs(s) < HALF - 1e-6 else 0.0
    zsh = -0.035 * L
    if where in ("upper", "lower"):
        yc, yt = foil(c)
        g = yt / FOIL_T
        cc = c * (1 - 0.03 * b)                      # the trailing edge scallops between ribs
        y = L * (0.5 - cc)
        if where == "upper":
            z = L * (yc + yt) + 0.022 * L * g * b + zsh
        else:
            z = L * (yc - yt) - 0.012 * L * g * b + zsh
        return Vector((s, y, z))
    f = where
    nose = local(s, 0.0, "upper")
    lip = local(s, MOUTH_C, "lower")
    p = nose.lerp(lip, f)
    p.y -= 0.09 * (L / CHORD) * b * math.sin(math.pi * f)   # the cell mouths: open between the ribs
    return p


def place(p):
    """Canopy-local point to the rest pose: round the span's arc, trimmed, at the canopy's place."""
    th = p.x / ARC_R
    r = ARC_R + p.z
    q = Vector((r * math.sin(th), p.y, r * math.cos(th) - ARC_R))
    return CANOPY_HEAD + TRIM_M @ q


def tangent(s):
    th = s / ARC_R
    return (TRIM_M @ Vector((math.cos(th), 0, -math.sin(th)))).normalized()


def canopy_w(s, c):
    """Which bones a canopy point follows: the two nearest cells, and on the rear half of each side its
    brake."""
    if s <= CELL_S[0]:
        cw = {0: 1.0}
    elif s >= CELL_S[-1]:
        cw = {CELLS - 1: 1.0}
    else:
        i = min(CELLS - 2, int((s - CELL_S[0]) // CW))
        f = (s - CELL_S[i]) / CW
        cw = {i: 1 - f, i + 1: f}
    wb = smooth((c - 0.55) / 0.45) * smooth((abs(s) - 0.25) / 1.3)
    w = {f"Cell_{i}": v * (1 - wb) for i, v in cw.items() if v > 1e-6}
    if wb > 1e-6:
        w["Brake_L" if s < 0 else "Brake_R"] = wb
    return w


def canopy_point(s, c, where="lower"):
    return place(local(s, c, where))


# ======== The harness's places, from the figure.
PELVIS = J["pelvis"]
SIDES = (("L", -1), ("R", 1))
CARAB = {}
for s, sx in SIDES:
    x = sx * 0.135
    CARAB[s] = Vector((x, surf(x, 1.36) + 0.026, 1.36))
WAIST_Z, THIGH_Z, CHEST_Z = 1.00, 0.80, 1.25
BACK_Y = min(surf(x, z, False) for x in (-0.12, 0, 0.12) for z in (1.05, 1.2, 1.35))
PACK_R = Vector((0.165, 0.082, 0.235))
PACK_C = Vector((0.0, BACK_Y - 0.006 - PACK_R.y, 1.20))
H_PILOT = Vector((0.0, (CARAB["L"].y + PELVIS.y) / 2, 1.38))     # the pilot swings round the connector links
RISER_LEN = 0.48
ROWS = {"A": (0.10, "Front"), "B": (0.36, "Front"), "C": (0.64, "Rear")}
RIBS = [-HALF + 4 * CW, -HALF + 2 * CW, -HALF]        # the left side's line ribs; mirrored on the right
TE_RIBS = [-HALF + 3 * CW, -HALF + 2 * CW, -HALF + CW, -HALF]


def side_s(s, sx):
    return s if sx < 0 else -s


def riser_tip(side, sx, kind):
    rows = [r for r, (c, k) in ROWS.items() if k == kind]
    tops = [canopy_point(side_s(rb, sx), ROWS[r][0]) for r in rows for rb in RIBS]
    ctr = sum(tops, Vector()) / len(tops)
    d = (ctr - CARAB[side]).normalized()
    return CARAB[side] + d * RISER_LEN + Vector((0, 0.03 if kind == "Front" else -0.03, 0))


TIP = {(s, k): riser_tip(s, sx, k) for s, sx in SIDES for k in ("Front", "Rear")}
TOGGLE_AT = 0.35
TOGGLE = {s: CARAB[s].lerp(TIP[(s, "Rear")], TOGGLE_AT) + Vector((sx * 0.09, 0.11, -0.03)) for s, sx in SIDES}
H_CANOPY = Vector((0.0, (TIP[("L", "Front")].y + TIP[("L", "Rear")].y) / 2, (TIP[("L", "Front")].z + TIP[("L", "Rear")].z) / 2))

# Bones: (name, parent, head). Parents come first.
BONES = [("Root", None, Vector()), ("Pilot", "Root", PELVIS.copy()), ("Pack", "Pilot", PACK_C.copy())]
for s, sx in SIDES:
    BONES += [(f"RiserFront_{s}", "Pilot", CARAB[s]), (f"RiserRear_{s}", "Pilot", CARAB[s])]
for s, sx in SIDES:
    BONES += [(f"Thigh_{s}", "Pilot", J[f"hip_{s}"]), (f"Shin_{s}", f"Thigh_{s}", J[f"knee_{s}"]),
              (f"Foot_{s}", f"Shin_{s}", J[f"ankle_{s}"])]
for s, sx in SIDES:
    BONES += [(f"Elbow_{s}", "Pilot", J[f"shoulder_{s}"] + Vector((sx * 0.34, -0.14, -0.20)))]
for s, sx in SIDES:
    BONES += [(f"Toggle_{s}", "Root", TOGGLE[s]), (f"Grip_{s}", "Root", TOGGLE[s].copy())]
BONES += [("Canopy", "Root", CANOPY_HEAD.copy())]
BONES += [(f"Cell_{i}", "Canopy", place(Vector((CELL_S[i], 0, 0)))) for i in range(CELLS)]
BRAKE_S = 1.85
BONES += [("Brake_L", "Canopy", place(local(-BRAKE_S, 0.58, "lower")).lerp(place(local(-BRAKE_S, 0.58, "upper")), 0.5)),
          ("Brake_R", "Canopy", place(local(BRAKE_S, 0.58, "lower")).lerp(place(local(BRAKE_S, 0.58, "upper")), 0.5))]
NAMES = [b[0] for b in BONES]
INDEX = {n: i for i, n in enumerate(NAMES)}
PARENT = {b[0]: b[1] for b in BONES}
HEAD = {b[0]: b[2].copy() for b in BONES}
BRAKE_AXIS = {"L": tangent(-BRAKE_S), "R": tangent(BRAKE_S)}
CELL_T = [tangent(s) for s in CELL_S]
FLAT = [Vector((CELL_S[i], 0, 0)) - (place(Vector((CELL_S[i], 0, 0))) - CANOPY_HEAD) for i in range(CELLS)]
RIBS_ALL = {s: [side_s(rb, sx) for rb in RIBS] for s, sx in SIDES}


# ======== Geometry: faces with a material and a colour; vertices with bone weights.
class Geo:
    def __init__(self):
        self.co, self.w, self.faces, self.fmat, self.fcol = [], [], [], [], []

    def v(self, p, w):
        self.co.append(Vector(p))
        self.w.append(dict(w))
        return len(self.co) - 1

    def face(self, idx, mat, col, inside=None, outward=None):
        """A face; turned so its normal points away from `inside` (or along `outward`)."""
        pts = [self.co[i] for i in idx]
        n = Vector()
        for a, b in zip(pts, pts[1:] + pts[:1]):
            n += a.cross(b)
        ctr = sum(pts, Vector()) / len(pts)
        ref = outward if outward is not None else (ctr - inside if inside is not None else None)
        if ref is not None and n.dot(ref) < 0:
            idx = list(reversed(idx))
        self.faces.append(tuple(idx))
        self.fmat.append(mat)
        self.fcol.append(col)

    def grid(self, rows, wrows, matcol, inside, closed_u=False, closed_v=False):
        """rows[j][i]: points along u (i) for each v (j). matcol(i, j) -> (material, colour) of the quad
        from (i, j); inside(i, j) -> a point inside the part there."""
        ids = [[self.v(p, w) for p, w in zip(r, wr)] for r, wr in zip(rows, wrows)]
        nv, nu = len(ids), len(ids[0])
        for j in range(nv if closed_v else nv - 1):
            for i in range(nu if closed_u else nu - 1):
                i2, j2 = (i + 1) % nu, (j + 1) % nv
                m, c = matcol(i, j)
                self.face([ids[j][i], ids[j][i2], ids[j2][i2], ids[j2][i]], m, c, inside=inside(i, j))
        return ids

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)


def frame(t, up_hint):
    """Two unit vectors across the direction t."""
    t = t.normalized()
    n = (up_hint - t * up_hint.dot(t))
    if n.length < 1e-6:
        n = Vector((1, 0, 0)) - t * t.x
    n.normalize()
    return n, t.cross(n)


def tube(G, a, b, r, sides, wa, wb, col, mat=GEAR):
    """A line: an open tube from a to b, its ends following wa and wb."""
    t = b - a
    n, m = frame(t, Vector((0, 0, 1)) if abs(t.normalized().z) < 0.9 else Vector((1, 0, 0)))
    ring = [n * math.cos(2 * math.pi * k / sides) + m * math.sin(2 * math.pi * k / sides) for k in range(sides)]
    G.grid([[a + d * r for d in ring], [b + d * r for d in ring]], [[wa] * sides, [wb] * sides],
           lambda i, j: (mat, col), lambda i, j: (a + b) / 2, closed_u=True)


def strap(G, path, normals, width, thick, ws, col, mat=GEAR, closed=False, cap=True):
    """Webbing: a flat rectangle swept along a path (normals point away from what it lies on)."""
    rows, wrows, ctr = [], [], []
    n_pts = len(path)
    for k, p in enumerate(path):
        if closed:
            t = path[(k + 1) % n_pts] - path[k - 1]
        else:
            t = path[min(k + 1, n_pts - 1)] - path[max(k - 1, 0)]
        n, b = frame(t, normals[k])
        h, w = n * thick / 2, b * width / 2
        rows.append([p - h - w, p - h + w, p + h + w, p + h - w])
        wrows.append([ws[k]] * 4)
        ctr.append(p)
    ids = G.grid(rows, wrows, lambda i, j: (mat, col), lambda i, j: ctr[j], closed_u=True, closed_v=closed)
    if cap and not closed:
        for j, sgn in ((0, -1), (len(path) - 1, 1)):
            d = (path[min(j + 1, n_pts - 1)] - path[max(j - 1, 0)]).normalized() * sgn
            G.face(ids[j], mat, col, outward=d)


def spow(x, e):
    return math.copysign(abs(x) ** e, x)


def blob(G, c, r, e, nu, nv, w, col, mat=GEAR, rot=None):
    """A rounded box (superellipsoid) with flat fans at its poles."""
    rot = rot or Matrix.Identity(3)
    rows = []
    for j in range(1, nv):
        v = -math.pi / 2 + math.pi * j / nv
        rows.append([c + rot @ Vector((r.x * spow(math.cos(v), e) * spow(math.cos(2 * math.pi * i / nu), e),
                                       r.y * spow(math.cos(v), e) * spow(math.sin(2 * math.pi * i / nu), e),
                                       r.z * spow(math.sin(v), e))) for i in range(nu)])
    ids = G.grid(rows, [[w] * nu for _ in rows], lambda i, j: (mat, col), lambda i, j: c, closed_u=True)
    up = rot @ Vector((0, 0, 1))
    G.face(ids[0], mat, col, outward=-up)
    G.face(ids[-1], mat, col, outward=up)


def bundle(w_list, f_list):
    """Weights mixed: sum of f * w, the four strongest kept."""
    out = {}
    for w, f in zip(w_list, f_list):
        for k, v in w.items():
            out[k] = out.get(k, 0) + v * f
    top = sorted(out.items(), key=lambda kv: -kv[1])[:4]
    s = sum(v for _, v in top)
    return {k: v / s for k, v in top}


# ======== Building the parts.
def build_canopy(G, lod, variant):
    accent, slate = VARIANTS[variant]
    fr = [0, 0.05, 0.25, 0.5, 0.75, 0.95] if lod == 0 else [0, 0.5]
    ss = [-HALF + CW * (k + f) for k in range(CELLS) for f in fr] + [HALF]
    nu, nl = (14, 9) if lod == 0 else (6, 3)
    up_c = [(1 - math.cos(math.pi * k / nu)) / 2 for k in range(nu + 1)]
    lo_c = [MOUTH_C + (1 - MOUTH_C) * (1 - math.cos(math.pi * k / nl)) / 2 for k in range(nl + 1)]
    mouth = [1 / 3, 2 / 3] if lod == 0 else [0.5]
    # One closed section per span station: lower surface from the trailing edge forward, the mouth, then
    # the upper surface from the nose back.
    sec = [("lower", c) for c in reversed(lo_c)] + [("mouth", f) for f in reversed(mouth)] + [("upper", c) for c in up_c]
    rows, wrows = [], []
    for s in ss:
        r, wr = [], []
        for kind, c in sec:
            p = local(s, c, kind if kind != "mouth" else c)
            r.append(place(p))
            cw = c if kind != "mouth" else 0.0
            wr.append(canopy_w(s, cw))
        rows.append(r)
        wrows.append(wr)
    n_sec = len(sec)
    # The grid's u runs round the section, v along the span.
    def matcol(i, j):
        smid = (ss[j] + ss[j + 1]) / 2
        cell = min(CELLS - 1, int((smid + HALF) / CW))
        u = ((smid + HALF) / CW) % 1.0
        kind, c = sec[i]
        kind2, c2 = sec[(i + 1) % n_sec]
        if kind == "mouth" or kind2 == "mouth" or (kind == "lower" and kind2 == "upper" and c < 0.5):
            return GEAR, MOUTH
        top = kind == "upper" and kind2 == "upper"
        if cell in accent:
            mat, col = ACCENT, WHITE
        elif cell in slate:
            mat, col = FABRIC, SLATE if top else SLATE_UNDER
        else:
            mat, col = FABRIC, CREAM if top else CREAM_UNDER
        if mat == FABRIC:
            seam = lod == 0 and (u < 0.05 or u > 0.95)
            edge = top and (c < 0.035 or c2 > 0.97)
            col = tone(col, 0.86 if seam else (0.92 if edge else 1.0))
        return mat, col

    def inside(i, j):
        smid = (ss[j] + ss[j + 1]) / 2
        return place(Vector((smid, local(smid, 0.4, "upper").y, (local(smid, 0.3, "upper").z + local(smid, 0.3, "lower").z) / 2)))
    ids = G.grid(rows, wrows, matcol, inside, closed_u=True)
    for j, sx in ((0, -1), (len(ss) - 1, 1)):
        cell = 0 if sx < 0 else CELLS - 1
        col = WHITE if cell in accent else (SLATE_UNDER if cell in slate else CREAM_UNDER)
        G.face(ids[j], ACCENT if cell in accent else FABRIC, col, outward=tangent(ss[j]) * sx)


def line_set(lod):
    """The lines as (a, b, weights at a, weights at b, radius, colour), in the rest pose."""
    out = []
    for s, sx in SIDES:
        if lod == 0:
            for r, (c, kind) in ROWS.items():
                tip = TIP[(s, kind)]
                tops = [(canopy_point(rs, c), canopy_w(rs, c)) for rs in RIBS_ALL[s]]
                ctr = sum((p for p, _ in tops), Vector()) / len(tops)
                jn = tip.lerp(ctr, 0.62)
                smid = sum(RIBS_ALL[s]) / len(RIBS_ALL[s])
                wj = bundle([{f"Riser{kind}_{s}": 1.0}, canopy_w(smid, c)], [0.38, 0.62])
                out.append((tip, jn, {f"Riser{kind}_{s}": 1.0}, wj, 0.0065, LINE_LOW))
                for p, w in tops:
                    out.append((jn, p, wj, w, 0.0075, LINE_UP))
            tes = [(canopy_point(side_s(rb, sx), 0.99), canopy_w(side_s(rb, sx), 0.99)) for rb in TE_RIBS]
            ctr = sum((p for p, _ in tes), Vector()) / len(tes)
            jn = TOGGLE[s].lerp(ctr, 0.70)
            smid = side_s(sum(TE_RIBS) / len(TE_RIBS), sx)
            wj = bundle([{f"Toggle_{s}": 1.0}, canopy_w(smid, 0.99)], [0.30, 0.70])
            out.append((TOGGLE[s], jn, {f"Toggle_{s}": 1.0}, wj, 0.0075, LINE_BRAKE))
            for p, w in tes:
                out.append((jn, p, wj, w, 0.0065, LINE_BRAKE))
        else:
            for rs, c, kind in ((side_s(-HALF + 2 * CW, sx), 0.12, "Front"), (side_s(-HALF + 0.5 * CW, sx), 0.25, "Front"),
                                (side_s(-HALF + 2 * CW, sx), 0.64, "Rear")):
                out.append((TIP[(s, kind)], canopy_point(rs, c), {f"Riser{kind}_{s}": 1.0}, canopy_w(rs, c), 0.016, LINE_LOW))
            rs = side_s(-HALF + 1.5 * CW, sx)
            out.append((TOGGLE[s], canopy_point(rs, 0.99), {f"Toggle_{s}": 1.0}, canopy_w(rs, 0.99), 0.014, LINE_BRAKE))
    return out


def build_lines(G, lod):
    for a, b, wa, wb, r, col in line_set(lod):
        tube(G, a, b, r, 6 if lod == 0 else 3, wa, wb, col)


def torso_normal(p):
    """Away from the body's axis at p's height (up over the shoulders)."""
    yc = (surf(0.0, min(p.z, 1.40)) + surf(0.0, min(p.z, 1.40), False)) / 2
    a = Vector((0, yc, min(p.z, 1.34)))
    return (p - a).normalized()


def build_harness(G, lod):
    pw = {"Pilot": 1.0}
    nseg = 28 if lod == 0 else 12
    # The waist belt and the leg loops, fitted round the figure.
    _, belt = outline(WAIST_Z, nseg, 0.008)
    ctr = Vector((0, sum(p.y for p in belt) / len(belt), WAIST_Z))
    strap(G, belt, [(p - ctr) for p in belt], 0.05, 0.010, [pw] * len(belt), WEB, closed=True)
    for s, sx in SIDES:
        c, loop = outline(THIGH_Z, 20 if lod == 0 else 8, 0.007, sel=lambda b: b[:, 0] * sx > 0.03)
        tw = {f"Thigh_{s}": 1.0}
        strap(G, loop, [(p - c) for p in loop], 0.04, 0.010, [tw] * len(loop), WEB, closed=True)
        if lod == 0:
            # From the leg loop's front up to the belt: follows the thigh below, the pelvis above.
            a = max(loop, key=lambda p: p.y * 0.8 + p.x * sx * 0.6)
            b = Vector((sx * 0.13, surf(sx * 0.13, WAIST_Z) + 0.012, WAIST_Z - 0.02))
            path = [a.lerp(b, k / 4) for k in range(5)]
            for p in path[1:-1]:
                p.y = max(p.y, surf(p.x, p.z) + 0.012)
            strap(G, path, [Vector((sx * 0.3, 1, 0))] * 5, 0.038, 0.008,
                  [bundle([tw, pw], [1 - k / 4, k / 4]) for k in range(5)], WEB_LIGHT)
    # The main lift webs: from the belt up the chest, past the connector links, over the shoulders
    # into the top of the pack.
    for s, sx in SIDES:
        path = []
        zs = [1.0, 1.1, 1.2, 1.28, 1.36, 1.43] if lod == 0 else [1.0, 1.2, 1.36, 1.43]
        for z in zs:
            x = sx * lerp(0.085, 0.135, (z - 1.0) / 0.43)
            path.append(Vector((x, surf(x, z) + 0.009, z)))
        x = sx * 0.135
        yf, yb = surf(x, 1.43), surf(x, 1.43, False)
        for k in ((1, 2, 3) if lod == 0 else (2,)):
            y = lerp(yf, yb, k / 4)
            path.append(Vector((x, y, top_at(x, y) + 0.009)))
        for z in ((1.43, 1.38, 1.33) if lod == 0 else (1.40,)):
            path.append(Vector((x, surf(x, z, False) - 0.009, z)))
        strap(G, path, [torso_normal(p) for p in path], 0.044, 0.009, [pw] * len(path), WEB)
        if lod == 0:
            ring = [CARAB[s] + Vector((0.02 * math.cos(a), 0.004 * math.sin(a), 0.026 * math.sin(a) + 0.01))
                    for a in [2 * math.pi * k / 10 for k in range(10)]]
            strap(G, ring, [Vector((sx, 0, 0))] * 10, 0.008, 0.008, [pw] * 10, METAL, closed=True)
    if lod == 0:
        # The chest strap and its buckle.
        path = [Vector((x, surf(x, CHEST_Z) + 0.016, CHEST_Z)) for x in np.linspace(-0.105, 0.105, 7)]
        strap(G, path, [Vector((0, 1, 0))] * 7, 0.028, 0.007, [pw] * 7, WEB_LIGHT)
        blob(G, Vector((0, surf(0, CHEST_Z) + 0.026, CHEST_Z)), Vector((0.03, 0.009, 0.02)), 0.3, 10, 4, pw, METAL)
    # The pack: a soft box with a flap in the player's colour and a small handle.
    kw = {"Pack": 1.0}
    blob(G, PACK_C, PACK_R, 0.32, 20 if lod == 0 else 10, 12 if lod == 0 else 6, kw, PACK)
    blob(G, PACK_C + Vector((0, -PACK_R.y + 0.004, 0.075)), Vector((0.148, 0.022, 0.13)), 0.25,
         14 if lod == 0 else 6, 6 if lod == 0 else 3, kw, WHITE, ACCENT)
    if lod == 0:
        blob(G, PACK_C + Vector((0.11, -PACK_R.y + 0.01, -0.19)), Vector((0.022, 0.012, 0.022)), 0.6, 8, 4, kw, PACK_DARK)


def build_risers(G, lod):
    for s, sx in SIDES:
        kinds = ("Front", "Rear") if lod == 0 else ("Rear",)
        for kind in kinds:
            tip = TIP[(s, kind)] if lod == 0 else TIP[(s, "Front")].lerp(TIP[(s, "Rear")], 0.5)
            bw = {f"Riser{kind}_{s}": 1.0}
            path = [CARAB[s].lerp(tip, k / 4) for k in range(5)]
            nrm = Vector((0, 1, 0)) if kind == "Front" else Vector((0, -1, 0))
            strap(G, path, [nrm] * 5, 0.040 if lod == 0 else 0.06, 0.007, [bw] * 5, WEB)
            if lod == 0:
                blob(G, tip, Vector((0.013, 0.009, 0.016)), 0.3, 8, 4, bw, METAL)
                if kind == "Rear":
                    blob(G, CARAB[s].lerp(tip, 0.70), Vector((0.026, 0.012, 0.02)), 0.4, 8, 4, bw, WEB_LIGHT)
        # The toggle: a handle in the player's colour.
        tw = {f"Toggle_{s}": 1.0}
        blob(G, TOGGLE[s], Vector((0.017, 0.015, 0.046)), 0.45, 10 if lod == 0 else 6, 6 if lod == 0 else 4, tw, WHITE, ACCENT)


def build(lod, variant):
    G = Geo()
    build_canopy(G, lod, variant)
    build_lines(G, lod)
    build_risers(G, lod)
    build_harness(G, lod)
    return G


# ======== Posing: the rig's own forward kinematics and skinning, so clips can be checked and measured.
def trs(loc, q, sc):
    return Matrix.Translation(loc) @ q.to_matrix().to_4x4() @ Matrix.Diagonal((sc.x, sc.y, sc.z, 1.0))


def fk(B):
    W = {}
    for n, par, h in BONES:
        loc, q, sc = B.get(n, (Vector(), Quaternion(), Vector((1, 1, 1))))
        base = Matrix.Translation(h) if par is None else W[par] @ Matrix.Translation(h - HEAD[par])
        W[n] = base @ trs(loc, q, sc)
    return W


def skin_mats(W):
    return np.array([np.array(W[n] @ Matrix.Translation(-HEAD[n])) for n in NAMES])


def wmat(ws):
    M = np.zeros((len(ws), len(NAMES)))
    for i, w in enumerate(ws):
        for k, v in w.items():
            M[i, INDEX[k]] = v
    return M


def skin(P, M, S):
    Ph = np.c_[P, np.ones(len(P))]
    out = np.zeros((len(P), 3))
    for b in np.nonzero(M.any(0))[0]:
        out += M[:, b:b + 1] * (Ph @ S[b].T)[:, :3]
    return out


def attach(rows):
    """Canopy points the risers aim at, per side and riser."""
    out = {}
    for s, sx in SIDES:
        for kind in ("Front", "Rear"):
            pts, ws = [], []
            for r, (c, k) in ROWS.items():
                if k == kind:
                    for rs in RIBS_ALL[s]:
                        pts.append(canopy_point(rs, c))
                        ws.append(canopy_w(rs, c))
            out[(s, kind)] = (np.array([list(p) for p in pts]), wmat(ws))
    return out


ATTACH = attach(ROWS)
CR_A = [random.Random(7 + i).uniform(-1, 1) for i in range(CELLS)]
CR_B = [random.Random(31 + i).uniform(-1, 1) for i in range(CELLS)]
CR_C = [random.Random(57 + i).uniform(0.4, 1.0) for i in range(CELLS)]
FREE = {
    "fall": {"L": Vector((-0.50, 0.03, 1.52)), "R": Vector((0.50, 0.03, 1.52))},
    "down": {"L": Vector((-0.205, 0.075, 1.035)), "R": Vector((0.205, 0.075, 1.035))},
}


def base():
    """The steady glide, before any motion."""
    return {
        "p_pos": PELVIS.copy(), "p_rot": Quaternion(),
        "hip": {"L": 0.88, "R": 0.88}, "abd": {"L": 0.06, "R": 0.06}, "knee": {"L": 1.05, "R": 1.05},
        "ankle": {"L": -0.30, "R": -0.30}, "pack": 1.0,
        "c_pos": CANOPY_HEAD.copy(), "c_rot": Quaternion(), "c_scale": Vector((1, 1, 1)),
        "tw": [0.0] * CELLS, "thick": [1.0] * CELLS, "crumple": 0.0, "flat": 0.0,
        "brake": {"L": 0.05, "R": 0.05}, "riser": 1.0,
        "pull": {"L": 0.0, "R": 0.0}, "hold": {"L": 1.0, "R": 1.0},
        "free": {"L": FREE["down"]["L"].copy(), "R": FREE["down"]["R"].copy()},
    }


def swing(p, kp, kr, pivot, q):
    p[kr] = q @ p[kr]
    p[kp] = pivot + q @ (p[kp] - pivot)


def solve(p, ground=False):
    """Bone poses (loc, rot, scale in each bone's rest frame) and their world matrices for a pose p."""
    B = {}
    B["Pilot"] = (p["p_pos"] - HEAD["Pilot"], p["p_rot"].copy(), Vector((1, 1, 1)))
    for s, sx in SIDES:
        B[f"Thigh_{s}"] = (Vector(), qx(p["hip"][s]) @ qy(sx * p["abd"][s]), Vector((1, 1, 1)))
        B[f"Shin_{s}"] = (Vector(), qx(-p["knee"][s]), Vector((1, 1, 1)))
        B[f"Foot_{s}"] = (Vector(), qx(p["ankle"][s]), Vector((1, 1, 1)))
    B["Pack"] = (Vector(), Quaternion(), Vector((p["pack"],) * 3))
    B["Canopy"] = (p["c_pos"] - HEAD["Canopy"], p["c_rot"].copy(), p["c_scale"].copy())
    k = p["crumple"]
    for i in range(CELLS):
        q = Quaternion(CELL_T[i], p["tw"][i] + k * 0.55 * CR_A[i]) @ qy(k * 0.35 * CR_B[i] - p["flat"] * (CELL_S[i] / ARC_R))
        loc = FLAT[i] * p["flat"] + Vector((0, 0, -k * 0.25 * CR_C[i]))
        th = p["thick"][i] * (1 - 0.55 * k)
        B[f"Cell_{i}"] = (loc, q, Vector((1, 1 - 0.15 * k * CR_C[i], th)))
    for s, sx in SIDES:
        B[f"Brake_{s}"] = (Vector(), Quaternion(BRAKE_AXIS[s], p["brake"][s]), Vector((1, 1, 1)))
    if ground:
        # Keep the fallen canopy on the ground (its lowest point 3 cm up).
        for _ in range(2):
            low = float(skin(CANOPY_CO, CANOPY_M, skin_mats(fk(B)))[:, 2].min())
            if low < 0.03:
                loc, q, sc = B["Canopy"]
                B["Canopy"] = (loc + Vector((0, 0, 0.03 - low)), q, sc)
    W = fk(B)
    S = skin_mats(W)
    # Risers point at the middle of their lines.
    for s, sx in SIDES:
        for kind in ("Front", "Rear"):
            P, M = ATTACH[(s, kind)]
            target = Vector(skin(P, M, S).mean(0))
            n = f"Riser{kind}_{s}"
            par = W["Pilot"] @ Matrix.Translation(HEAD[n] - HEAD["Pilot"])
            here = par.translation
            rest_dir = (TIP[(s, kind)] - CARAB[s]).normalized()
            R = rest_dir.rotation_difference((target - here).normalized())
            q = par.to_quaternion().inverted() @ R
            B[n] = (Vector(), q, Vector((p["riser"],) * 3))
    W = fk(B)
    # Toggles hang on the rear risers, pulled down by the hands; the wrists follow them or go free.
    for s, sx in SIDES:
        Sr = W[f"RiserRear_{s}"] @ Matrix.Translation(-HEAD[f"RiserRear_{s}"])
        on = Sr @ TOGGLE[s]
        a = p["pull"][s]
        pos = on + Vector((0, 0.10 * a, -a)) * p["riser"]
        B[f"Toggle_{s}"] = (pos - HEAD[f"Toggle_{s}"], Sr.to_quaternion(), Vector((p["riser"],) * 3))
        g = p["free"][s].lerp(pos, p["hold"][s])
        B[f"Grip_{s}"] = (g - HEAD[f"Grip_{s}"], Quaternion(), Vector((1, 1, 1)))
    return B, fk(B)


def legs_for_drop(d):
    """Hip flex and knee bend that keep the ankles where they stand when the pelvis drops d metres."""
    out = {}
    for s, _ in SIDES:
        l1 = (J[f"hip_{s}"] - J[f"knee_{s}"]).length
        l2 = (J[f"knee_{s}"] - J[f"ankle_{s}"]).length
        d0 = (J[f"hip_{s}"] - J[f"ankle_{s}"]).length
        dd = max(0.5 * (l1 + l2), d0 - d)
        a0 = math.acos((l1 * l1 + d0 * d0 - l2 * l2) / (2 * l1 * d0))
        a1 = math.acos((l1 * l1 + dd * dd - l2 * l2) / (2 * l1 * dd))
        k0 = math.acos((l1 * l1 + l2 * l2 - d0 * d0) / (2 * l1 * l2))
        k1 = math.acos((l1 * l1 + l2 * l2 - dd * dd) / (2 * l1 * l2))
        out[s] = (a1 - a0, k0 - k1)
    return out


# ======== The clips, as poses over time.
def glide(t, steer=0.0):
    p = base()
    ph = 2 * math.pi * t / LOOP
    swing(p, "p_pos", "p_rot", H_PILOT, qy(0.16 * steer + 0.025 * math.sin(ph + 0.4)) @ qx(0.02 * math.sin(ph + 2.0)))
    for s, sx in SIDES:
        inner = max(0.0, -steer) if s == "L" else max(0.0, steer)
        p["hip"][s] += 0.05 * math.sin(ph + 1.0 + 0.3 * sx) + 0.08 * inner
        p["knee"][s] += 0.05 * math.sin(ph + 1.7 + 0.3 * sx) + 0.10 * inner
        p["brake"][s] += 0.015 * math.sin(3 * ph + 0.9 * sx) + 0.62 * inner
        p["pull"][s] = 0.38 * inner + 0.006 * (1 + math.sin(ph + sx))
    qc = qz(-0.12 * steer) @ qy(0.34 * steer + 0.015 * math.sin(ph + 1.3)) @ qx(0.02 * math.sin(ph))
    swing(p, "c_pos", "c_rot", H_CANOPY, qc)
    p["c_pos"] += Vector((0, 0.03 * math.sin(ph + 2.2), 0.03 * math.sin(ph + 0.5)))
    p["tw"] = [0.014 * math.sin(2 * ph + 0.7 * i) for i in range(CELLS)]
    p["thick"] = [1 + 0.03 * math.sin(ph + 0.6 * i) for i in range(CELLS)]
    return p


def flare_pose():
    p = glide(0.0)
    swing(p, "c_pos", "c_rot", H_CANOPY, qx(0.28))
    swing(p, "p_pos", "p_rot", H_PILOT, qx(0.12))
    for s, _ in SIDES:
        p["hip"][s], p["knee"][s], p["ankle"][s] = 0.30, 0.30, -0.12
        p["brake"][s], p["pull"][s] = 0.95, 0.56
    p["thick"] = [1.04] * CELLS
    return p


def flare(t):
    a, b = glide(0.0), flare_pose()
    w = smooth(t / 0.62)
    w += 0.06 * math.sin(math.pi * min(1.0, max(0.0, (t - 0.4) / 0.4)))   # a little overshoot as it bites
    return mix(a, b, min(1.06, w))


def packed(pilot):
    """Everything in the pack: canopy, lines, risers and toggles."""
    p = pilot
    p["c_pos"], p["c_rot"], p["c_scale"] = PACK_C.copy(), Quaternion(), Vector((0.02, 0.02, 0.02))
    p["crumple"], p["flat"], p["riser"] = 1.0, 0.0, 0.0
    p["tw"], p["thick"] = [0.0] * CELLS, [1.0] * CELLS
    p["brake"] = {"L": 0.3, "R": 0.3}
    p["pull"], p["hold"] = {"L": 0.0, "R": 0.0}, {"L": 0.0, "R": 0.0}
    return p


def standing():
    p = base()
    for s, _ in SIDES:
        p["hip"][s], p["abd"][s], p["knee"][s], p["ankle"][s] = 0.0, 0.0, 0.0, 0.0
    return p


def deploy(t):
    k0 = base()
    for s, _ in SIDES:
        k0["hip"][s], k0["knee"][s], k0["ankle"][s], k0["abd"][s] = -0.12, 0.55, -0.35, 0.12
        k0["free"][s] = FREE["fall"][s].copy()
    k0 = packed(k0)
    k1 = copy.deepcopy(k0)
    k1["pack"] = 1.08
    k2 = copy.deepcopy(k0)                       # the bag out behind and above, lines unstowing
    k2.update(c_pos=Vector((0, -0.75, 4.2)), c_scale=Vector((0.10, 0.22, 0.45)), riser=1.0, crumple=1.0, pack=1.0)
    k2["c_rot"] = qx(-0.5)
    k3 = copy.deepcopy(k2)                       # line stretch, the canopy spreading
    k3.update(c_pos=Vector((0, -0.42, 5.15)), c_scale=Vector((0.45, 0.75, 0.40)), crumple=0.7)
    k3["c_rot"] = qx(0.35)
    g = glide(0.0)
    k4 = copy.deepcopy(g)                        # inflating: overshoot, the canopy surges ahead
    swing(k4, "c_pos", "c_rot", H_CANOPY, qx(-0.18))
    swing(k4, "p_pos", "p_rot", H_PILOT, qx(0.12))
    k4.update(c_scale=Vector((1.03, 1.0, 1.08)), crumple=0.12)
    k4["brake"], k4["hold"] = {"L": 0.3, "R": 0.3}, {"L": 0.6, "R": 0.6}
    k4["free"] = copy.deepcopy(k0["free"])
    k5 = copy.deepcopy(g)
    swing(k5, "c_pos", "c_rot", H_CANOPY, qx(0.06))
    swing(k5, "p_pos", "p_rot", H_PILOT, qx(-0.05))
    keys = [(0.0, k0), (0.12, k1), (0.40, k2), (0.75, k3), (1.05, k4), (1.38, k5), (1.8, g)]
    return keyed(keys, t)


def land(t):
    f = flare_pose()
    st = standing()
    # The pilot: legs down and a dip on touchdown, hands up, then down.
    drop = 0.10 * math.sin(math.pi * min(1.0, max(0.0, (t - 0.10) / 0.45)))
    lg = legs_for_drop(drop)
    w = smooth(t / 0.22)
    p = mix(f, st, w)
    p["p_pos"] = st["p_pos"] + Vector((0, 0, -drop * smooth(t / 0.12)))
    for s, _ in SIDES:
        p["hip"][s] = lerp(f["hip"][s], lg[s][0], w)
        p["knee"][s] = lerp(f["knee"][s], lg[s][1], w)
        p["ankle"][s] = lerp(f["ankle"][s], 0.0, w)
        p["hold"][s] = 1 - smooth((t - 0.55) / 0.5)
        p["pull"][s] = f["pull"][s] * (1 - smooth((t - 0.45) / 0.4))
    # The canopy: falls forward, flattens and crumples on the ground in front, then is stowed over the
    # pilot's head into the pack.
    c0 = {"c_pos": f["c_pos"], "c_rot": f["c_rot"], "c_scale": f["c_scale"], "crumple": 0.0, "flat": 0.0,
          "brake": f["brake"], "riser": 1.0, "pack": 1.0}
    c1 = copy.deepcopy(c0)
    swing(c1, "c_pos", "c_rot", H_CANOPY, qx(-1.0))
    c1.update(crumple=0.35, c_scale=Vector((0.95, 1.0, 0.7)), brake={"L": 0.5, "R": 0.5})
    c2 = {"c_pos": Vector((0, 3.0, 0.30)), "c_rot": qx(-0.18), "c_scale": Vector((0.80, 0.92, 0.18)), "crumple": 0.95,
          "flat": 1.0, "brake": {"L": 0.2, "R": 0.2}, "riser": 1.0, "pack": 1.0}
    c3 = copy.deepcopy(c2)
    c4 = {"c_pos": PACK_C.copy(), "c_rot": Quaternion(), "c_scale": Vector((0.02, 0.02, 0.02)), "crumple": 1.0,
          "flat": 0.0, "brake": {"L": 0.3, "R": 0.3}, "riser": 0.0, "pack": 1.0}
    keys = [(0.0, c0), (0.12, c0), (0.65, c1), (1.15, c2), (1.45, c3), (2.25, c4), (2.4, c4)]
    c = keyed(keys, t)
    if 1.45 < t < 2.25:   # over the head on the way to the pack
        u = (t - 1.45) / 0.8
        c["c_pos"] += Vector((0, 0, 1.7 * math.sin(math.pi * smooth(u))))
        c["riser"] = 1 - smooth((t - 1.75) / 0.5)
    for k_, v in c.items():
        p[k_] = v
    p["free"] = copy.deepcopy(FREE["down"])
    p["tw"], p["thick"] = [0.0] * CELLS, [1.0] * CELLS
    if t >= 2.25:
        p["hold"] = {"L": 0.0, "R": 0.0}
    return p


CLIP_FN = {
    "Deploy": deploy,
    "Glide_Idle": lambda t: glide(t, 0.0),
    "Glide_Left": lambda t: glide(t, -1.0),
    "Glide_Right": lambda t: glide(t, 1.0),
    "Flare": flare,
    "Land_Collapse": land,
}


def pose_at(clip, t):
    return solve(CLIP_FN[clip](t), ground=(clip == "Land_Collapse" and 0.5 < t < 1.9))


# ======== Blender objects.
def material(name, colour=None, glow=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.82
    p.inputs["Metallic"].default_value = 0.0
    if colour is None:
        vc = nt.nodes.new("ShaderNodeVertexColor")
        vc.layer_name = "Col"
        nt.links.new(vc.outputs["Color"], p.inputs["Base Color"])
    else:
        c = rgb(colour)
        p.inputs["Base Color"].default_value = (*[x ** 2.2 for x in c], 1.0)
    if glow is not None:
        p.inputs["Emission Color"].default_value = (*[x ** 2.2 for x in rgb(glow)], 1.0)
        p.inputs["Emission Strength"].default_value = GLOW
    m.use_backface_culling = True
    return m


def make_mesh(name, G, mats, rig):
    me = bpy.data.meshes.new(name)
    me.from_pydata([c[:] for c in G.co], [], G.faces)
    me.update()
    ca = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    cols = np.ones((len(me.loops), 4))
    starts = np.zeros(len(me.polygons), dtype=int)
    counts = np.zeros(len(me.polygons), dtype=int)
    me.polygons.foreach_get("loop_start", starts)
    me.polygons.foreach_get("loop_total", counts)
    for k, (st, n) in enumerate(zip(starts, counts)):
        cols[st:st + n, :3] = G.fcol[k]
    ca.data.foreach_set("color_srgb", cols.ravel())
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = 0
    me.polygons.foreach_set("material_index", G.fmat)
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(70))
    for m in mats:
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    groups = {n: obj.vertex_groups.new(name=n) for n in NAMES}
    for i, w in enumerate(G.w):
        top = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        s = sum(v for _, v in top)
        for k, v in top:
            groups[k].add([i], v / s, "REPLACE")
    obj.parent = rig
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    return obj


def make_rig(parent):
    arm = bpy.data.armatures.new("Parachute_Rig")
    obj = bpy.data.objects.new("Parachute_Rig", arm)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    for n, par, h in BONES:
        eb = arm.edit_bones.new(n)
        eb.head, eb.tail, eb.roll = h, h + Vector((0, 0.08, 0)), 0.0
        eb.use_deform = True
        if par:
            eb.parent = arm.edit_bones[par]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in obj.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return obj


def apply_pose(rig, B):
    for n in NAMES:
        loc, q, sc = B.get(n, (Vector(), Quaternion(), Vector((1, 1, 1))))
        pb = rig.pose.bones[n]
        pb.location, pb.rotation_quaternion, pb.scale = loc, q, sc
    bpy.context.view_layer.update()


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.worlds, bpy.data.images):
        for d in list(coll):
            coll.remove(d)


def build_scene(variant):
    clear_scene()
    scene = bpy.context.scene
    scene.render.fps = FPS
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    root = bpy.data.objects.new("ParachuteRoot", None)
    scene.collection.objects.link(root)
    rig = make_rig(root)
    mats = [material("Parachute_Canopy", glow="#efe6d3"), material("Parachute_Accent", ACCENT_DEFAULT, glow=ACCENT_DEFAULT),
            material("Parachute_Gear")]
    G0, G1 = build(0, variant), build(1, variant)
    lod0 = make_mesh("Parachute_LOD0", G0, mats, rig)
    lod1 = make_mesh("Parachute_LOD1", G1, mats, rig)
    return root, rig, lod0, lod1, G0, G1


# The canopy's own vertices (LOD0), for keeping it on the ground.
_G = Geo()
build_canopy(_G, 0, ARGS.variant)
CANOPY_CO = np.array([list(c) for c in _G.co])
CANOPY_M = wmat(_G.w)
del _G


def bake(rig):
    """Key every clip into its own action (an NLA track each, as the exporter wants), checking each frame:
    returns per-clip facts (length, bounds, clearances)."""
    info = {}
    rig.animation_data_create()
    G = GEO[0]
    co = np.array([list(c) for c in G.co])
    M = wmat(G.w)
    line_idx = np.array(sorted(LINE_VERTS))
    head_c = J["head"] + Vector((0, 0.02, 0.05))
    for clip, secs in CLIPS.items():
        act = bpy.data.actions.new(clip)
        rig.animation_data.action = act
        n = round(secs * FPS)
        prev = {}
        lo, hi = np.full(3, 1e9), np.full(3, -1e9)
        clo, chi = np.full(3, 1e9), np.full(3, -1e9)
        head_clear, torso_clear = 1e9, 1e9
        first = None
        for f in range(0, n + 1, STEP):
            B, W = pose_at(clip, f / FPS)
            S = skin_mats(W)
            pos = skin(co, M, S)
            lo, hi = np.minimum(lo, pos.min(0)), np.maximum(hi, pos.max(0))
            cp = pos[CANOPY_IDX]
            clo, chi = np.minimum(clo, cp.min(0)), np.maximum(chi, cp.max(0))
            # How close the lines come to the head and the chest (moved with the pilot).
            D = np.array(W["Pilot"] @ Matrix.Translation(-HEAD["Pilot"]))
            hc = (D @ np.array([*head_c, 1.0]))[:3]
            lp = pos[line_idx]
            if B["RiserFront_L"][2].x >= 0.99:   # not while the lines are still in the pack
                head_clear = min(head_clear, float(np.linalg.norm(lp - hc, axis=1).min()) - 0.14)
                for z in (1.05, 1.2, 1.35):
                    tc = (D @ np.array([0.0, 0.03, z, 1.0]))[:3]
                    torso_clear = min(torso_clear, float(np.linalg.norm(lp - tc, axis=1).min()) - 0.17)
            if first is None:
                first = pos
            for b in NAMES:
                pb = rig.pose.bones[b]
                loc, q, sc = B.get(b, (Vector(), Quaternion(), Vector((1, 1, 1))))
                if b in prev and prev[b].dot(q) < 0:
                    q = -q
                prev[b] = q.copy()
                pb.location, pb.rotation_quaternion, pb.scale = loc, q, sc
                for path in ("location", "rotation_quaternion", "scale"):
                    pb.keyframe_insert(path, frame=f, group=b)
        track = rig.animation_data.nla_tracks.new()
        track.name = clip
        track.strips.new(clip, 0, act)
        rig.animation_data.action = None
        info[clip] = {
            "seconds": secs, "frames": n, "loop": clip in LOOPING,
            "loop_seam_m": float(np.abs(pos - first).max()) if clip in LOOPING else None,
            "bounds_gltf": {"min": to_gltf_box(lo, hi)[0], "max": to_gltf_box(lo, hi)[1]},
            "canopy_bounds_gltf": {"min": to_gltf_box(clo, chi)[0], "max": to_gltf_box(clo, chi)[1]},
            "line_head_clearance_m": round(head_clear, 3), "line_torso_clearance_m": round(torso_clear, 3),
        }
        print(f"clip {clip:14s} {secs:.2f} s  bounds {np.round(lo, 2)} .. {np.round(hi, 2)}  "
              f"lines to head {head_clear:.3f} m, to chest {torso_clear:.3f} m")
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    return info


def to_gltf_box(lo, hi):
    a = to_gltf(Vector(lo))
    b = to_gltf(Vector(hi))
    return [min(x, y) for x, y in zip(a, b)], [max(x, y) for x, y in zip(a, b)]


def export(path):
    bpy.ops.object.select_all(action="DESELECT")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
        export_texcoords=False, export_normals=True, export_tangents=False, export_materials="EXPORT",
        export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_attributes=False,
        export_cameras=False, export_lights=False, export_extras=False,
        export_skins=True, export_influence_nb=4, export_all_influences=False, export_def_bones=False,
        export_morph=False, export_animations=True, export_animation_mode="ACTIONS", export_nla_strips=True,
        export_force_sampling=True, export_frame_step=STEP, export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=True, export_anim_slide_to_zero=True,
        export_reset_pose_bones=True, export_rest_position_armature=True, export_anim_single_armature=False,
        export_merge_animation="ACTION", export_bake_animation=False, export_leaf_bone=False,
        export_armature_object_remove=False, export_hierarchy_flatten_bones=False)


def read_glb(path):
    data = open(path, "rb").read()
    jl = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20:20 + jl]), data[20 + jl + 8:]


def manifest(path, info, variant):
    j, _ = read_glb(path)
    nodes = j["nodes"]
    names = {i: n.get("name") for i, n in enumerate(nodes)}
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    wanted = ["ParachuteRoot", "Parachute_Rig", "Root", "Pilot", "Pack", "Grip_L", "Grip_R", "Toggle_L", "Toggle_R",
              "Canopy", "RiserFront_L", "RiserRear_L", "RiserFront_R", "RiserRear_R", "Thigh_L", "Shin_L", "Foot_L",
              "Thigh_R", "Shin_R", "Foot_R", "Elbow_L", "Elbow_R", "Brake_L", "Brake_R"]
    out_nodes = {}
    for i, n in enumerate(nodes):
        if n.get("name") in wanted:
            out_nodes[n["name"]] = {
                "index": i, "parent": names.get(parent.get(i)),
                "translation": [round(x, 4) for x in n.get("translation", [0, 0, 0])],
                "rotation": [round(x, 5) for x in n.get("rotation", [0, 0, 0, 1])],
                "scale": [round(x, 4) for x in n.get("scale", [1, 1, 1])],
                "rest_position_in_root": to_gltf(HEAD[n["name"]]) if n["name"] in HEAD else [0, 0, 0],
            }
    meshes = []
    for m in j["meshes"]:
        prims = []
        for pr in m["primitives"]:
            cnt = j["accessors"][pr["indices"]]["count"] // 3
            prims.append({"material": j["materials"][pr["material"]]["name"], "triangles": cnt,
                          "vertices": j["accessors"][pr["attributes"]["POSITION"]]["count"]})
        meshes.append({"name": m["name"], "triangles": sum(p["triangles"] for p in prims), "primitives": prims})
    anims = []
    for a in j["animations"]:
        t1 = max(j["accessors"][s["input"]]["max"][0] for s in a["samplers"])
        anims.append({"name": a["name"], "seconds": round(t1, 4), "channels": len(a["channels"])})
    mats = [{"name": m["name"], "baseColorFactor": [round(x, 4) for x in m.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])],
             "emissiveFactor": [round(x, 4) for x in m.get("emissiveFactor", [0, 0, 0])],
             "roughness": m.get("pbrMetallicRoughness", {}).get("roughnessFactor", 1), "metallic": m.get("pbrMetallicRoughness", {}).get("metallicFactor", 1),
             "vertexColours": True, "doubleSided": m.get("doubleSided", False)} for m in j["materials"]]
    doc = {
        "asset": "web/public/models/parachute.glb",
        "generator": "blender -b -P tools/parachute/parachute.py -- (Blender %s)" % bpy.app.version_string,
        "licence": "Our own work for Brieltje, under the project's licence (CC BY-NC 4.0). No third-party parts.",
        "variant": variant,
        "units": "metres", "up": "+Y", "forward": "-Z", "right": "+X",
        "origin": "ParachuteRoot = the pilot's foot origin (where the feet stand); the game's Body.root goes on the same spot",
        "file_bytes": os.path.getsize(path),
        "meshes": meshes, "materials": mats,
        "accent_material": "Parachute_Accent: set color to the player's colour and emissive to that colour x %.2f (its vertex colours are white)" % GLOW,
        "nodes": out_nodes,
        "clips": {a["name"]: {**info.get(a["name"], {}), "exported_seconds": a["seconds"], "channels": a["channels"]} for a in anims},
        "pilot_pose_guides": {
            "Pilot": "pelvis: the figure's Body bone follows its change from rest",
            "Thigh_X / Shin_X / Foot_X": "heads at the figure's hip, knee and ankle; the legs reach the ankle by two-bone IK with the knee as pole; Foot.X follows Foot_X's change",
            "Grip_X": "the palm's centre: the wrist goes 5 cm short of it towards the shoulder (two-bone IK, Elbow_X as pole)",
            "figure_scale": round(AV_SCALE, 5), "figure": "web/public/models/swat.glb (Quaternius, CC0), not included in this file",
        },
        "dimensions": {
            "span_flat_m": SPAN, "span_projected_m": round(2 * ARC_R * math.sin(HALF / ARC_R), 3),
            "tip_drop_m": round(ARC_R * (1 - math.cos(HALF / ARC_R)), 3), "chord_centre_m": CHORD,
            "chord_tip_m": round(chord_at(HALF), 3), "cells": CELLS, "trim_deg": round(math.degrees(TRIM), 1),
            "canopy_pivot_height_m": round(CANOPY_HEAD.z, 3), "riser_length_m": RISER_LEN,
            "max_thickness_m": round(2 * FOIL_T * CHORD, 3),
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(ARGS.manifest)), exist_ok=True)
    with open(ARGS.manifest, "w") as fh:
        json.dump(doc, fh, indent=1)
        fh.write("\n")
    return doc


# ======== Run: build, bake, export.
ROOT, RIG, LOD0, LOD1, G0, G1 = build_scene(ARGS.variant)
GEO = (G0, G1)
CANOPY_IDX = np.array([i for i, w in enumerate(G0.w) if any(k.startswith(("Cell_", "Brake_")) for k in w)
                       and all(k.startswith(("Cell_", "Brake_")) for k in w)])
_tmp = Geo()
build_canopy(_tmp, 0, ARGS.variant)
_start = len(_tmp.co)
build_lines(_tmp, 0)
LINE_VERTS = set(range(_start, len(_tmp.co)))
del _tmp
print(f"LOD0 {G0.tris()} triangles, LOD1 {G1.tris()} triangles, {len(NAMES)} bones")
print("canopy: projected span %.2f m, tip drop %.2f m, pivot %.2f m up" % (2 * ARC_R * math.sin(HALF / ARC_R), ARC_R * (1 - math.cos(HALF / ARC_R)), CANOPY_HEAD.z))


def variants_and_exit():
    import renders  # noqa: E402  (tools/parachute/renders.py)
    renders.variants(ARGS.variants, types.SimpleNamespace(**globals()))
    sys.exit(0)


sys.path.insert(0, HERE)
if ARGS.variants:
    variants_and_exit()

INFO = bake(RIG)
if not ARGS.no_export:
    export(ARGS.out)
    doc = manifest(ARGS.out, INFO, ARGS.variant)
    print("exported %s: %d bytes; meshes %s" % (ARGS.out, doc["file_bytes"], [(m["name"], m["triangles"]) for m in doc["meshes"]]))
if ARGS.blend:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(ARGS.blend), compress=True)
    print("saved", ARGS.blend)
if ARGS.renders:
    import renders  # noqa: E402
    renders.review(ARGS.renders, types.SimpleNamespace(**globals()))
