"""Build Santa (de Kerstman), his sleigh and four reindeer for December on the church square, in Blender.

Run (Blender 5, no window):
  blender -b --disable-autoexec -P tools/santa.py -- <deer1.blend> [out.glb] [preview_dir]

<deer1.blend>: "Old Deer Male" by CDmir on OpenGameArt (CC0 1.0, https://opengameart.org/content/old-deer-male,
deer1.blend, 7.7 MB), a sculpted, textured, rigged and animated deer. Fetched by hand into a scratch folder; not kept
in the repository (only what this tool makes from it is).

Generic and invented: a traditional Santa, nobody in particular, no logos and no brand's look. Out: one GLB (Y up,
metres, facing +z, i.e. Blender -y) with three parts.

  santa      Santa himself, made as tools/villagers.py makes the villagers (this tool borrows its code, see V below):
             the same sculpted public domain body (tools/assets/people/body_male.glb, Blender Studio's Human Base
             Meshes, CC0) rigged on the villagers' skeleton (bones santa_<Bone>), a rounder belly, dressed in a red
             jacket and trousers with white fur at the hem, the cuffs, the collar and down the front, a black belt
             with a gold buckle, black boots with fur tops, round gold spectacles, white hair and a long, full white
             beard (the sculpted beard of Quaternius' Universal Base Characters, CC0, drawn out down over the chest),
             and a red hat with a fur band and a bobble that hangs to one side. santa_body and santa_far (about
             1,800 triangles, for further off) on one armature. Clips (santa_<Clip>, 15 keys a second, in place):
             Idle and Idle2 (standing about: rubbing his hands against the cold, a look at his watch), Wave, Talk,
             Laugh (ho ho ho, his hands on his belly), Sit and SitWave (on the sleigh's seat, 45 cm above his feet).
             Colours by slot in the UVs as the villagers' (u: slot + 0.5, v: 1 - shade); world/santa.ts paints them.
  reindeer   One reindeer from the deer above: its four meshes joined into one with one texture (the three pictures
             side by side, made greyer and lighter for a reindeer, plus a few flat colours for the harness), scaled to
             a reindeer's 1.1 m at the shoulder, its rig (IK controls, Blender 2.7 era) baked to plain bones
             (rd_<Bone>), a red leather collar with three gold bells and a girth band, all skinned. reindeer_body and
             reindeer_far (about 900 triangles). Clips (reindeer_<Clip>): Idle, Graze (the head down), Look (a look
             round, the ears flicking) and Run (a gallop, for the flight). The node's extras say where its nose is
             (the leader's glows at night) and where the harness meets the traces.
  sleigh     The sleigh, made here: two gold runners curling up at the front, a red lacquered body with gold trim, a
             high back and a curled front, a velvet seat, a sack of presents behind it and two presents at its front;
             the pole and the leather traces to four reindeer standing in two pairs ahead of it. One mesh, colours by
             slot as above (SLEIGH_SLOTS). Its extras give each reindeer's place and the seat.

With preview_dir it saves small pictures (Eevee) of the team and of Santa's poses there.
"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not argv:
    raise SystemExit(__doc__)
HERE = os.path.dirname(os.path.abspath(__file__))
DEER = argv[0]
OUT = argv[1] if len(argv) > 1 else os.path.join(HERE, "..", "web", "public", "models", "santa.glb")
PREVIEW = argv[2] if len(argv) > 2 else ""

# ======== The villagers' tool, borrowed: its definitions (the sculpted body's rigging and dressing, the poses, the
# meshes, the far mesh, the GLB repacking, the preview renders) without its build. Run as it is, so Santa is made as
# the villagers are; nothing in tools/villagers.py changes for him.
VIL = os.path.join(HERE, "villagers.py")
_src = open(VIL, encoding="utf-8").read()


def _part(a, b):
    i = _src.index(a)
    return _src[i:_src.index(b, i)]


V = {"__name__": "villagers_parts", "__file__": VIL}
exec(compile(_src[:_src.index("# ======== Build everything.")], VIL, "exec"), V)
exec(compile(_part("def read_glb(", "size_raw = os.path.getsize(OUT)"), VIL, "exec"), V)
exec(compile(_part("def render(", "if PREVIEW:"), VIL, "exec"), V)
euler, smooth, SIDES, TAU, FPS, STEP = V["euler"], V["smooth"], V["SIDES"], V["TAU"], V["FPS"], V["STEP"]
SKIN, HAIR, TOP, BOTTOM, SHOES, ACC, ACC2, LEGS, FRAME, WHITE, DARK, METAL, TYRE, LEATHER, LIPS, SOLE = range(16)
UMB, BAG, HAT, SCARF, SPECS, HAIR_A, HAIR_B, BEARD = 1, 2, 3, 4, 5, 6, 7, 8

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
scene = bpy.context.scene
scene.render.fps = FPS
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
V["MAT"] = MAT = V["preview_material"]()


def link(o):
    scene.collection.objects.link(o)
    return o


# ======== Santa.
K = "santa"
H = 1.80
V["OUTFIT"][K] = dict(jacket=0.028, quilt=0.0, hem=0.49, collar=0.0, legs=0.018, boots=0.26, shoe=0.02)
V["HAIRS"][K] = ("Hair_Long", None, "Hair_Beard")
V["KINDS"][K] = dict(H=H, tris=9000, sh=0.21, hip=0.1, girth=1.12, chest=(0.17, 0.12), waist=(0.17, 0.13), head=1.0, sleeve="long", clips="adult",
                     walk=1.2, T=1.1, hair="short", base="male")
V["GAIT"][K] = V["GAIT"]["man"]
BELT_W = 0.06  # the belt's width (m)
FUR = 0.014  # how far the fur stands out from the cloth (m)

_thin_piece = V["thin_piece"]


def thin_piece(v, f, tris):
    """The beard keeps more of its sculpt than a villager's: it is drawn out down over his chest."""
    return _thin_piece(v, f, 900 if tris == 200 else tris)


V["thin_piece"] = thin_piece
_sculpt = V["sculpt"]


def vertex_normals(co, faces):
    bm = bmesh.new()
    for p in co:
        bm.verts.new(p)
    bm.verts.ensure_lookup_table()
    for f in faces:
        try:
            bm.faces.new([bm.verts[i] for i in f])
        except ValueError:
            pass
    bm.normal_update()
    out = [v.normal.copy() for v in bm.verts]
    bm.free()
    return out


def cut_seams(S, cuts, body_slots):
    """Cut S's clothes along planes (point, normal, which faces: f(middle, arm weight)); the faces' colours, groups
    and the points' weights go with the pieces (bmesh carries them over and blends the weights at a cut)."""
    co, faces, look, group, wts = S["co"], S["faces"], S["look"], S["group"], S["weights"]
    names = sorted({b for w in wts for b in w})
    bidx = {b: i for i, b in enumerate(names)}
    bm = bmesh.new()
    dl = bm.verts.layers.deform.verify()
    slot_l = bm.faces.layers.int.new("slot")
    shade_l = bm.faces.layers.float.new("shade")
    grp_l = bm.faces.layers.int.new("grp")
    for p, w in zip(co, wts):
        v = bm.verts.new(p)
        for b, x in w.items():
            v[dl][bidx[b]] = x
    bm.verts.ensure_lookup_table()
    lost = 0
    for f, (sl, sh), g in zip(faces, look, group):
        try:
            nf = bm.faces.new([bm.verts[i] for i in f])
        except ValueError:
            lost += 1
            continue
        nf[slot_l], nf[shade_l], nf[grp_l] = sl, sh, g
    ARMI = [bidx[b] for b in ("UpperArmL", "UpperArmR", "LowerArmL", "LowerArmR", "HandL", "HandR") if b in bidx]

    def aw(v):
        return sum(x for gi, x in v[dl].items() if gi in ARMI)

    for point, normal, which in cuts:
        fs = [f for f in bm.faces if f[grp_l] == 0 and f[slot_l] in body_slots and which(f.calc_center_median(), sum(aw(v) for v in f.verts) / len(f.verts))]
        vs = {v for f in fs for v in f.verts}
        es = {e for f in fs for e in f.edges}
        bmesh.ops.bisect_plane(bm, geom=list(vs) + list(es) + fs, plane_co=Vector(point), plane_no=Vector(normal), dist=1e-5)
    bm.verts.index_update()
    bm.verts.ensure_lookup_table()
    S["co"] = [v.co.copy() for v in bm.verts]
    S["weights"] = []
    for v in bm.verts:
        w = {names[gi]: x for gi, x in v[dl].items() if x > 1e-3}
        tot = sum(w.values()) or 1.0
        S["weights"].append({b: x / tot for b, x in w.items()})
    S["faces"] = [tuple(v.index for v in f.verts) for f in bm.faces]
    S["look"] = [(f[slot_l], f[shade_l]) for f in bm.faces]
    S["group"] = [f[grp_l] for f in bm.faces]
    bm.free()
    print(f"santa seams: {len(faces)} faces in, {len(S['faces'])} out, {lost} lost")


def santa_dress(S):
    """Santa on the sculpted body the villagers' dressing gave him: a rounder belly, the fur, the belt and buckle,
    the boots' fur tops, the long beard and bushy white brows. Changes S (sculpt()'s result) in place."""
    co, faces, look, group, wts = S["co"], S["faces"], S["look"], S["group"], S["weights"]
    J = S["joints"]
    s9 = H / 1.79
    body_slots = {SKIN, TOP, BOTTOM, SHOES, SOLE, LIPS, LEGS}
    body_v = sorted({i for f, (sl, _), g in zip(faces, look, group) if sl in body_slots and g == 0 for i in f})
    w = lambda i, *bs: sum(wts[i].get(b, 0.0) for b in bs)
    # ---- The belly: round in front and a little at the sides, from the chest's underside to the belt and below.
    bz = J["Spine"].z + 0.03 * s9
    for i in body_v:
        p = co[i]
        torso = w(i, "Spine", "Hips", "Chest")
        if torso < 0.4:
            continue
        fz = math.exp(-((p.z - bz) / (0.2 * s9)) ** 2)
        if p.y < 0.02:
            p.y -= 0.15 * s9 * fz * math.exp(-(p.x / (0.19 * s9)) ** 2) * min(1.0, torso)
        p.x *= 1 + 0.1 * fz * min(1.0, torso)
    # ---- The seams cut straight across first (as sculpt() cuts the hem and the cuffs), so each band of fur, the belt
    # and the buckle has edges of its own; then each face takes its colour by its middle.
    hem = V["OUTFIT"][K]["hem"] * H
    boot_top = V["OUTFIT"][K]["boots"] * H
    belt_z = bz - 0.01 * s9
    neck = J["Neck"].z
    cuffs = {s: (J["LowerArm" + s], J["Hand" + s] - J["LowerArm" + s]) for s in "LR"}
    ARM = ("UpperArmL", "UpperArmR", "LowerArmL", "LowerArmR", "HandL", "HandR")
    zc = Vector((0, 0, 1))
    xc = Vector((1, 0, 0))
    torso = lambda c, aw: aw < 0.5
    front = lambda c, aw: aw < 0.5 and c.y < 0 and hem < c.z < neck
    cuts = [((0, 0, hem + 0.075 * s9), zc, torso), ((0, 0, belt_z - BELT_W / 2), zc, torso), ((0, 0, belt_z + BELT_W / 2), zc, torso),
            ((0, 0, neck - 0.045 * s9), zc, torso), ((0, 0, boot_top + 0.05 * s9), zc, torso),
            ((0.032 * s9, 0, 0), xc, front), ((-0.032 * s9, 0, 0), xc, front),
            ((0.05 * s9, 0, 0), xc, lambda c, aw: front(c, aw) and abs(c.z - belt_z) < BELT_W), ((-0.05 * s9, 0, 0), xc, lambda c, aw: front(c, aw) and abs(c.z - belt_z) < BELT_W)]
    for s, sg in SIDES:
        el, d = cuffs[s]
        cuts.append((el + d * 0.76, d.normalized(), lambda c, aw, sg=sg: aw > 0.3 and c.x * sg > 0))
    cut_seams(S, cuts, body_slots)
    co, faces, look, group, wts = S["co"], S["faces"], S["look"], S["group"], S["weights"]
    piece = [g != 0 or sl not in body_slots for (sl, _), g in zip(look, group)]  # the eyes, the brows, the hair and the beard
    fur_v, belt_v = set(), set()
    for fi, f in enumerate(faces):
        sl, shade = look[fi]
        if group[fi] != 0 or sl not in (TOP, BOTTOM):
            continue
        c = sum((co[i] for i in f), Vector()) / len(f)
        aw = sum(w(i, *ARM) for i in f) / len(f)
        new = None
        if sl == TOP and aw > 0.5:
            el, d = cuffs["L" if c.x > 0 else "R"]
            t = (c - el).dot(d) / d.length_squared
            if t > 0.76:
                new = (WHITE, 1.0)
        elif sl == TOP:
            if c.z < hem + 0.075 * s9:
                new = (WHITE, 1.0)
            elif c.z > neck - 0.045 * s9:
                new = (WHITE, 1.0)
            elif abs(c.z - belt_z) < BELT_W / 2:
                new = (METAL, 1.0) if (abs(c.x) < 0.05 * s9 and c.y < 0) else (DARK, 1.0)
                belt_v.update(f)
            elif abs(c.x) < 0.032 * s9 and c.y < 0:
                new = (WHITE, 1.0)
        elif sl == BOTTOM and c.z < boot_top + 0.05 * s9:
            new = (WHITE, 1.0)
        if new:
            look[fi] = new
            if new[0] == WHITE:
                fur_v.update(f)
    skin_faces = [f for f, pc in zip(faces, piece) if not pc]
    nrm = vertex_normals(co, skin_faces)
    for i in fur_v:
        co[i] = co[i] + nrm[i] * FUR
    for i in belt_v - fur_v:
        co[i] = co[i] + nrm[i] * 0.007
    # ---- The beard: drawn out down over the chest, fuller, the lower part following the chest; pushed out of the
    # body wherever it would sink into it.
    bm = bmesh.new()
    for p in co:
        bm.verts.new(p)
    bm.verts.ensure_lookup_table()
    for f in skin_faces:
        try:
            bm.faces.new([bm.verts[i] for i in f])
        except ValueError:
            pass
    bvh = BVHTree.FromBMesh(bm)
    bm.free()
    eye_z = S["eye"][2]
    z0 = eye_z - 0.08 * s9  # about the mouth
    beard_v = sorted({i for f, g in zip(faces, group) if g == BEARD for i in f})
    cx = sum((co[i] for i in beard_v), Vector()) / len(beard_v)
    for i in beard_v:
        p = co[i].copy()
        p = cx + (p - cx) * Vector((1.12, 1.1, 1.0))
        if p.z < z0:
            # A curtain from the jaw: the sides hang as far as the chin, so the beard ends broad and round.
            d = z0 - p.z
            side = smooth(abs(p.x) / (0.065 * s9))
            p.z = z0 - d * 3.0 - 0.11 * s9 * side * smooth(d / (0.03 * s9))
            p.y -= d * 1.1 + 0.03 * side * smooth(d / (0.03 * s9))
            p.x *= 1 + d * 3.0
        elif p.z < z0 + 0.03 * s9 and p.y < cx.y:  # the moustache, fuller
            p.x *= 1.15
            p.y -= 0.004
        hit = bvh.find_nearest(p)
        if hit[0] is not None and hit[3] < 0.08:
            loc, n_ = hit[0], hit[1]
            depth = (p - loc).dot(n_)
            if depth < 0.012:
                p = p + n_ * (0.012 - depth)
        co[i] = p
        low = smooth((z0 - 0.07 * s9 - p.z) / (0.12 * s9))
        wts[i] = {"Head": 1 - low, "Chest": low} if low > 0.01 else {"Head": 1.0}
    # ---- Bushy brows.
    brow_v = sorted({i for f, (sl, sh), g in zip(faces, look, group) if g == 0 and sl == HAIR for i in f})
    if brow_v:
        bc = sum((co[i] for i in brow_v), Vector()) / len(brow_v)
        for i in brow_v:
            co[i] = bc + (co[i] - bc) * Vector((1.15, 1.4, 1.9)) + Vector((0, -0.003, 0.002))
    return S


def sculpt(k, P):
    S = _sculpt(k, P)
    return santa_dress(S) if k == K else S


V["sculpt"] = sculpt


def santa_hat(F, B):
    """The hat: red, from a fur band round his head, up and over to one side, its bobble hanging by his ear."""
    S = B.S
    cr = S["cran"]
    ez = S["eye"][2]
    s9 = H / 1.79
    hz = cr["top"] - ez
    c = Vector((0, (cr["front"] + cr["back"]) / 2 + 0.006 * s9, ez + 0.36 * hz))
    rx, ry = cr["half"] * 1.24, (cr["back"] - cr["front"]) / 2 * 1.17
    tilt = Matrix.Rotation(math.radians(-10), 3, "X")  # the band a little higher at the front
    # The crown's line: up, then over and down to his left, behind the ear.
    pts = [Vector(p) for p in ((0, 0, 0), (0, 0.01, 0.07), (0.015, 0.035, 0.14), (0.05, 0.075, 0.19), (0.1, 0.12, 0.18), (0.14, 0.15, 0.12),
                               (0.16, 0.165, 0.04), (0.165, 0.17, -0.02))]
    pts = [c + tilt @ (p * s9) for p in pts]
    radii = [(rx, ry), (rx * 0.97, ry * 0.97), (rx * 0.82, ry * 0.85), (0.075, 0.075), (0.058, 0.058), (0.044, 0.044), (0.032, 0.032), (0.022, 0.022)]
    rings = []
    for k, (p, (ru, rv)) in enumerate(zip(pts, radii)):
        a = (pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)]).normalized()
        u = (Vector((1, 0, 0)) - a * a.x).normalized()
        v = a.cross(u).normalized()
        rings.append(V["ring"](p, u, v, ru * s9 if k > 2 else ru, rv * s9 if k > 2 else rv, 16))
    hb = (B.n("Head"),)
    F.add(V["loft"](rings, cap0=True, cap1=True), TOP, hb, 1.0)
    band = V["torus"](c + tilt @ Vector((0, 0, 0.012 * s9)), rx * 1.02, 0.026 * s9, 24, 8, tilt @ Matrix.Diagonal((1.0, ry / rx, 1.0)))
    F.add(band, WHITE, hb, 1.0)
    F.add(V["ellipsoid"](pts[-1] + Vector((0.005, 0.0, -0.035)) * s9, (0.048 * s9,) * 3, 12, 8), WHITE, hb, 1.0)


def keep_groups(F, keep):
    """Only the faces of the groups kept (0 and those in keep, all made 0), and only the points they use."""
    idx = [i for i, g in enumerate(F.group) if g == 0 or g in keep]
    used = sorted({v for i in idx for v in F.faces[i]})
    remap = {o: n for n, o in enumerate(used)}
    F.co = [F.co[o] for o in used]
    F.allow = [F.allow[o] for o in used]
    F.given = {remap[o]: w for o, w in F.given.items() if o in remap}
    sculpted = sum(1 for i in idx if i < F.sculpted)
    F.faces = [tuple(remap[v] for v in F.faces[i]) for i in idx]
    F.slot = [F.slot[i] if F.group[i] != SPECS else METAL for i in idx]
    F.shade = [F.shade[i] for i in idx]
    F.group = [0 for _ in idx]
    F.sculpted = sculpted


def laugh_clip(B):
    """Ho ho ho: his hands on his belly, three laughs that shake his shoulders and his belly, his head back."""
    n = B.n
    L = 2.4

    def pose(t):
        p = V["Pose"]()
        ho = 0.0
        for i in range(3):
            x = (t - 0.12 - i * 0.42) / 0.36
            if 0 < x < 1:
                ho += math.sin(math.pi * x) * (1.0 - 0.15 * i)
        on = V["kf"](t, L, [(0.0, 0.0), (0.12, 1.0), (1.7, 1.0), (2.3, 0.0)])
        V["stand_feet"](B, p, 0.2, spread=0.02)
        p.rel[n("Spine")] = euler(pitch=-3 * on - 2.5 * ho)
        p.rel[n("Chest")] = euler(pitch=-2 * on - 2.0 * ho)
        p.rel[n("Neck")] = euler(pitch=-4 * on)
        p.rel[n("Head")] = euler(pitch=-8 * on - 4 * ho, roll=3 * math.sin(TAU * t / L))
        for s, sg in SIDES:
            p.rel[n(f"Clavicle{s}")] = euler(roll=-sg * 4 * ho)
            p.rel[n(f"UpperArm{s}")] = euler(pitch=-12 * on, roll=-sg * (8 + 16 * on), yaw=-sg * 8 * on)
            p.rel[n(f"LowerArm{s}")] = euler(pitch=-14 - 34 * on, yaw=-sg * (6 + 40 * on))
            p.rel[n(f"Hand{s}")] = euler(pitch=-8 + 10 * on, roll=-sg * 20 * on)
        V["breathe"](p, B, t)
        V["finish_stand"](B, p)
        return p

    return pose, L


def sit_wave(B):
    """On the sleigh's seat, waving with his right hand to those below."""
    sit = V["sitting"](B)
    n = B.n

    def pose(t):
        p = sit(t)
        ph = (t / 1.2) % 1.0
        p.rel[n("ClavicleR")] = euler(roll=12)
        p.rel[n("UpperArmR")] = euler(pitch=-30, roll=95)
        p.rel[n("LowerArmR")] = euler(pitch=-12, roll=62 + 24 * math.sin(TAU * ph * 2))
        p.rel[n("HandR")] = euler(roll=8 + 12 * math.sin(TAU * ph * 2 + 0.6), pitch=-6)
        return p

    return pose


def build_santa():
    B = V["Body"](K, V["KINDS"][K])
    V["set_rest_poles"](B)
    F = V["build_person"](B)
    keep_groups(F, {SPECS, HAIR_A, BEARD})
    santa_hat(F, B)
    W = V["weights"](B, F)
    top = link(bpy.data.objects.new("santa", None))
    rig = V["make_rig"](B, top)
    rig.name = rig.data.name = "santa_rig"
    mesh = V["make_mesh"]("santa_body", B, F, W, MAT, rig)
    far = V["far_mesh"](mesh, F, 1800)
    far.name = far.data.name = "santa_far"
    idles = V["idles"](B)
    L = round(V["IDLE_S"] * FPS)
    laugh, Ll = laugh_clip(B)
    clips = {"Idle": (L, idles[2]), "Idle2": (L, idles[1]), "Wave": (round(1.2 * FPS), V["wave_clip"](B)), "Talk": (L, V["talk_clip"](B)),
             "Laugh": (round(Ll * FPS), laugh), "Sit": (L, V["sitting"](B)), "SitWave": (round(2.4 * FPS), sit_wave(B))}
    keyframe_people(B, F, W, rig, clips)
    print(f"santa: {F.tris()} triangles, {len(F.co)} points; far {sum(len(p.vertices) - 2 for p in far.data.polygons)}; clips {list(clips)}")
    return top, rig, mesh, B


def keyframe_people(B, F, W, rig, clips):
    """Each clip as an action of its own on the rig (an NLA track each, so the export finds them), as villagers.py."""
    rest_q = {b: rig.data.bones[b].matrix_local.to_quaternion() for b in B.names}
    rig.animation_data_create()
    for clip, (frames, posef) in clips.items():
        name = f"{K}_{clip}"
        act = bpy.data.actions.new(name)
        rig.animation_data.action = act
        prev = {}
        for f in range(0, frames + 1, STEP):
            p = posef(f / FPS)
            Q, G = V["solve"](B, p)
            for b in B.names:
                pb = rig.pose.bones[b]
                q = rest_q[b].inverted() @ Q[b] @ rest_q[b]
                if b in prev and prev[b].dot(q) < 0:
                    q.negate()
                prev[b] = q.copy()
                pb.rotation_quaternion = q
                pb.keyframe_insert("rotation_quaternion", frame=f, group=b)
                if b.endswith("_Hips"):
                    pb.location = rest_q[b].inverted() @ p.off.get(b, Vector())
                    pb.keyframe_insert("location", frame=f, group=b)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None


# ======== The reindeer, from the deer.
RD_SHOULDER = 1.1  # m at the withers
# The deer's bones that move its skin, and our names for them (no dots: three.js drops them).
RD_BONES = {"Hip": "Hip", "Backbone": "Back", "Backbone.001": "Chest", "Backbone.002": "Neck", "Head": "Head", "Head_L.001": "EarL",
            "Head_R.001": "EarR"}
for side in "LR":
    for i, suf in enumerate(("", ".001", ".002")):
        RD_BONES[f"Frontleg_{side}{suf}"] = f"Front{side}{i + 1}"
        RD_BONES[f"Backleg_{side}{suf}"] = f"Back{side}{i + 1}"
# Weights on the rig's controls, given to the bone each control sits on (the deer's front left foot's group is
# misnamed in the file and moves nothing there, so it is left out here too).
RD_GROUPS = {"IK-Backbone": "Backbone.001", "IK-Head": "Head", "IK-Frontleg_R": "Frontleg_R.002"}
RD_CLIPS = {"Idle": "Idle.000", "Graze": "Eat.001", "Look": "LookAround.000", "Run": "Run"}
DEER_FPS = 24


def atlas_image(imgs):
    """The deer's three pictures in one (1024 square: the body, the head and the antlers at 512, and flat colours for
    the eyes and the harness), greyer and a little lighter for a reindeer; the blue padding round the body's pieces
    filled with its fur's colour so it doesn't bleed in at a distance."""
    A = np.zeros((1024, 1024, 4), np.float32)
    A[..., 3] = 1.0

    def px(name):
        im = imgs[name].copy()
        im.scale(512, 512)
        a = np.array(im.pixels[:], np.float32).reshape(512, 512, 4)
        bpy.data.images.remove(im)
        return a

    def reindeer(a, amount=0.45, lift=1.1):
        rgb = a[..., :3]
        blue = (rgb[..., 2] > rgb[..., 0] + 0.08) & (rgb[..., 2] > rgb[..., 1] + 0.05)
        fur = rgb[~blue & (rgb.sum(-1) > 0.05)].mean(0)
        rgb[blue] = fur
        lum = (rgb * np.array([0.3, 0.55, 0.15], np.float32)).sum(-1, keepdims=True)
        grey = lum * np.array([1.0, 0.95, 0.88], np.float32)
        a[..., :3] = np.clip((rgb * (1 - amount) + grey * amount) * lift, 0, 1)
        return a

    # Blender's pictures start at the bottom row: [rows, cols]; top left is rows 512.., cols ..512.
    A[512:, :512] = reindeer(px("body"))
    A[512:, 512:] = reindeer(px("head"), 0.3, 1.05)
    A[:512, :512] = px("deer-antlers.png")
    for (r, c), col in zip(PATCH_RC.values(), PATCH_COL.values()):
        A[r * 256:(r + 1) * 256, 512 + c * 256:512 + (c + 1) * 256, :3] = col
    im = bpy.data.images.new("reindeer_atlas", 1024, 1024)
    im.pixels.foreach_set(A.ravel())
    path = os.path.join(bpy.app.tempdir or os.environ.get("TEMP", "."), "reindeer_atlas.jpg")
    im.filepath_raw = path
    im.file_format = "JPEG"
    scene.render.image_settings.quality = 88
    im.save()
    im2 = bpy.data.images.load(path)
    im2.name = "reindeer"
    im2.pack()
    return im2


# Flat colours in the picture's free quarter (bottom right): [row, col] of 256 squares, linear RGB.
PATCH_RC = {"eye": (0, 0), "leather": (0, 1), "gold": (1, 0), "nose": (1, 1)}
PATCH_COL = {"eye": (0.012, 0.01, 0.009), "leather": (0.33, 0.035, 0.03), "gold": (0.75, 0.52, 0.16), "nose": (0.08, 0.05, 0.045)}
QUAD_UV = {"Body": (0.0, 0.5), "Head": (0.5, 0.5), "Antlers": (0.0, 0.0)}


def patch_uv(name):
    r, c = PATCH_RC[name]
    return (0.5 + (c + 0.5) * 0.25, (r + 0.5) * 0.25)


def build_reindeer():
    with bpy.data.libraries.load(DEER) as (src, dst):
        dst.objects = ["Armature", "Body", "Head", "Horns", "Eyes"]
        dst.actions = list(RD_CLIPS.values())
        dst.images = ["body", "head", "deer-antlers.png"]
    objs = {o.name.split(".")[0]: link(o) for o in dst.objects}
    imgs = {i.name: i for i in dst.images}
    arm = objs["Armature"]
    bpy.context.view_layer.update()
    Aw = arm.matrix_world.copy()
    # The scale: the withers (the top of the chest bone's head, measured on the skin) to a reindeer's.
    body = objs["Body"]
    feet = min((body.matrix_world @ v.co).z for v in body.data.vertices)
    chest = (Aw @ arm.data.bones["Backbone.001"].head_local)
    withers = max((body.matrix_world @ v.co).z for v in body.data.vertices if abs((body.matrix_world @ v.co).y - chest.y) < 0.25)
    s = RD_SHOULDER / (withers - feet)
    mid_y = chest.y * s  # its middle (the girth) at the origin, and its feet on the ground
    shift = Vector((0, -mid_y, -feet * s))

    def place(m):
        """A matrix in the deer's world, scaled and moved to ours (rotation kept)."""
        loc, q, _ = m.decompose()
        return Matrix.Translation(loc * s + shift) @ q.to_matrix().to_4x4()

    # ---- Sample every clip's bones (their place with all the controls' constraints on), frame by frame.
    order = [b.name for b in arm.data.bones if b.name in RD_BONES]
    parent = {b: next((p.name for p in arm.data.bones[b].parent_recursive if p.name in RD_BONES), None) for b in order}
    rest = {b: place(Aw @ arm.data.bones[b].matrix_local) for b in order}
    samples = {}
    arm.animation_data_create()
    for clip, aname in RD_CLIPS.items():
        act = bpy.data.actions[aname]
        arm.animation_data.action = act
        if hasattr(arm.animation_data, "action_slot") and act.slots:
            arm.animation_data.action_slot = act.slots[0]
        f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
        frames = []
        for f in range(f0, f1 + 1):
            scene.frame_set(f)
            bpy.context.view_layer.update()
            frames.append({b: place(Aw @ arm.pose.bones[b].matrix) for b in order})
        samples[clip] = frames
        hip = [fr["Hip"].translation for fr in frames]
        print(f"reindeer {clip}: {len(frames)} frames; hip y {min(p.y for p in hip):.3f}..{max(p.y for p in hip):.3f} z {min(p.z for p in hip):.3f}..{max(p.z for p in hip):.3f}")
    arm.animation_data.action = None
    # ---- One mesh, in the rest pose, with the picture's quarters for UVs.
    co, faces, uvs, wts = [], [], [], []
    ranges = {}
    for name, mat in (("Body", "Body"), ("Head", "Head"), ("Horns", "Antlers"), ("Eyes", "Eye")):
        o = objs[name]
        me = o.data
        gname = {g.index: g.name for g in o.vertex_groups}
        base = len(co)
        ranges[name] = (base, base + len(me.vertices))
        mw = o.matrix_world
        for v in me.vertices:
            co.append((mw @ v.co) * s + shift)
            w = {}
            for g in v.groups:
                b = RD_GROUPS.get(gname[g.group], gname[g.group])
                if b in RD_BONES and g.weight > 1e-3:
                    w[b] = w.get(b, 0.0) + g.weight
            wts.append(w)
        uvl = me.uv_layers["UVMap"]
        for p in me.polygons:
            faces.append(tuple(base + i for i in p.vertices))
            if mat == "Eye":
                uvs.append([patch_uv("eye")] * len(p.vertices))
            else:
                ou, ov = QUAD_UV[mat]
                uvs.append([(ou + uvl.data[li].uv[0] * 0.5, ov + uvl.data[li].uv[1] * 0.5) for li in p.loop_indices])
    n_skin = len(co)
    for o in objs.values():
        if o.type == "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    # ---- The harness: a collar with three bells round the neck, a girth band round the chest; skinned to them.
    nb = rest["Backbone.002"].translation
    hb = rest["Head"].translation
    girth = rest["Backbone.001"].translation
    skin = co[ranges["Body"][0]:ranges["Head"][1]]  # without the antlers

    def section(c, axis, u, half=0.03):
        """The skin's cross-section through c across `axis`: its middle and half sizes along u and axis x u."""
        v = axis.cross(u).normalized()
        pts = [p for p in skin if abs((p - c).dot(axis)) < half and (p - c).length < 0.45]
        a = [(p - c).dot(u) for p in pts]
        b = [(p - c).dot(v) for p in pts]
        mid = c + u * (max(a) + min(a)) / 2 + v * (max(b) + min(b)) / 2
        return mid, (max(a) - min(a)) / 2, (max(b) - min(b)) / 2, v

    extras = {}
    harness = []
    nax = (hb - nb).normalized()
    u = (Vector((1, 0, 0)) - nax * nax.x).normalized()
    cc, nru, nrv, v = section(nb.lerp(hb, 0.3), nax, u)
    collar = V["torus"](cc, 1.0, 0.022, 20, 6, Matrix((u * nru * 1.04, v * nrv * 1.04, nax)).transposed())
    harness.append((collar, "leather", {"Backbone.002": 1.0}))
    low = (cc - v * nrv * 1.08) if v.z < 0 else (cc + v * nrv * 1.08)
    down = (low - cc).normalized()
    for k, dx in enumerate((-0.055, 0.0, 0.055)):
        bc = low + u * dx + down * 0.025
        harness.append((V["ellipsoid"](bc, (0.024, 0.024, 0.024), 10, 6), "gold", {"Backbone.002": 1.0}))
    gax = Vector((0, 1, 0))
    gy = girth.y + 0.04
    pts = [p for p in skin if abs(p.y - gy) < 0.04 and p.z > 0.5]
    gcen = Vector((0, gy, (max(p.z for p in pts) + min(p.z for p in pts)) / 2))
    grx = max(abs(p.x) for p in pts) * 1.04
    grz = (max(p.z for p in pts) - min(p.z for p in pts)) / 2 * 1.04
    band = V["torus"](gcen, 1.0, 0.03, 28, 4, Matrix(((grx, 0, 0), (0, 0, 1), (0, grz, 0))))
    harness.append((band, "leather", {"Backbone.001": 0.7, "Backbone": 0.3}))
    gr = grx
    for side in (-1, 1):
        harness.append((V["ellipsoid"](gcen + Vector((side * gr * 1.02, 0, 0.0)), (0.02, 0.03, 0.03), 8, 5), "gold", {"Backbone.001": 0.7, "Backbone": 0.3}))
    for piece, patch, w in harness:
        vv, ff = piece
        base = len(co)
        co.extend(Vector(p) for p in vv)
        wts.extend(dict(w) for _ in vv)
        for f in ff:
            faces.append(tuple(base + i for i in f))
            uvs.append([patch_uv(patch)] * len(f))
    nose = min(co[ranges["Head"][0]:ranges["Head"][1]], key=lambda p: p.y)  # the nose's tip leads (the deer faces -y)
    horns = co[ranges["Horns"][0]:ranges["Horns"][1]]
    print(f"reindeer antlers: x {min(p.x for p in horns):.2f}..{max(p.x for p in horns):.2f}, y {min(p.y for p in horns):.2f}..{max(p.y for p in horns):.2f},"
          f" z {min(p.z for p in horns):.2f}..{max(p.z for p in horns):.2f}; body y {min(p.y for p in co[:n_skin]):.2f}..{max(p.y for p in co[:n_skin]):.2f}")
    extras["nose"] = [round(nose.x, 4), round(nose.z, 4), round(-nose.y, 4)]  # glTF axes: x, y up, z = -Blender y
    extras["girth"] = [round(gcen.x, 4), round(gcen.z, 4), round(-gcen.y, 4), round(gr * 1.06, 4)]
    extras["collar"] = [round(low.x, 4), round(low.z, 4), round(-low.y, 4)]
    # ---- The rig: the deer's skin bones at their places, the controls left behind.
    top = link(bpy.data.objects.new("reindeer", None))
    for kk, vv in extras.items():
        top[kk] = vv
    rdarm = bpy.data.armatures.new("reindeer_rig")
    rig = link(bpy.data.objects.new("reindeer_rig", rdarm))
    rig.parent = top
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for b in order:
        eb = rdarm.edit_bones.new("rd_" + RD_BONES[b])
        length = arm.data.bones[b].length * s
        eb.head = rest[b].translation
        eb.tail = rest[b].translation + rest[b].to_3x3() @ Vector((0, length, 0))
        eb.align_roll(rest[b].to_3x3() @ Vector((0, 0, 1)))
        if parent[b]:
            eb.parent = rdarm.edit_bones["rd_" + RD_BONES[parent[b]]]
    bpy.ops.object.mode_set(mode="OBJECT")
    rest2 = {b: rig.data.bones["rd_" + RD_BONES[b]].matrix_local.copy() for b in order}
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    bpy.data.objects.remove(arm, do_unlink=True)
    # The mesh.
    me = bpy.data.meshes.new("reindeer_body")
    me.from_pydata([p[:] for p in co], [], faces)
    me.update()
    uv = me.uv_layers.new(name="UVMap")
    for p, fu in zip(me.polygons, uvs):
        for li, t in zip(p.loop_indices, fu):
            uv.data[li].uv = t
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    mat = bpy.data.materials.new("reindeer")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.9
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = atlas_image(imgs)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    me.materials.append(mat)
    body = link(bpy.data.objects.new("reindeer_body", me))
    body.parent = rig
    groups = {b: body.vertex_groups.new(name="rd_" + RD_BONES[b]) for b in order}
    for i, w in enumerate(wts):
        top4 = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(x for _, x in top4) or 1.0
        if not top4:
            top4, tot = [("Head", 1.0)], 1.0
        for b, x in top4:
            groups[b].add([i], x / tot, "REPLACE")
    body.modifiers.new("Armature", "ARMATURE").object = rig
    # The far one: the same skin with far fewer triangles.
    far = body.copy()
    far.data = body.data.copy()
    far.name = far.data.name = "reindeer_far"
    link(far)
    bpy.context.view_layer.objects.active = far
    bpy.ops.object.select_all(action="DESELECT")
    far.select_set(True)
    dm = far.modifiers.new("thin", "DECIMATE")
    dm.ratio = 900 / sum(len(p.vertices) - 2 for p in me.polygons)
    dm.use_collapse_triangulate = True
    far.modifiers.move(len(far.modifiers) - 1, 0)
    bpy.ops.object.modifier_apply(modifier=dm.name)
    # ---- The clips, keyed from the samples (a key every other frame: 12 a second).
    rig.animation_data_create()
    for clip, frames in samples.items():
        name = f"reindeer_{clip}"
        act = bpy.data.actions.new(name)
        rig.animation_data.action = act
        prev = {}
        drift = Vector()
        if clip == "Run":  # in place: a gallop's loop that crept forward is pulled back
            drift = (frames[-1]["Hip"].translation - frames[0]["Hip"].translation) / max(1, len(frames) - 1)
            drift = Vector((0, drift.y, 0))
        for f, fr in enumerate(frames):
            if f % 2 and f != len(frames) - 1:
                continue
            M = {b: Matrix.Translation(-drift * f) @ fr[b] for b in order}
            for b in order:
                # A bone's pose relative to its rest under its parent's pose: what Blender keys.
                if parent[b]:
                    basis = (rest2[parent[b]].inverted() @ rest2[b]).inverted() @ M[parent[b]].inverted() @ M[b]
                else:
                    basis = rest2[b].inverted() @ M[b]
                loc, q, _ = basis.decompose()
                pb = rig.pose.bones["rd_" + RD_BONES[b]]
                if b in prev and prev[b].dot(q) < 0:
                    q.negate()
                prev[b] = q.copy()
                pb.rotation_quaternion = q
                pb.location = loc
                frame = round(f * FPS / DEER_FPS)
                pb.keyframe_insert("rotation_quaternion", frame=frame, group=pb.name)
                pb.keyframe_insert("location", frame=frame, group=pb.name)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
    print(f"reindeer: scale {s:.4f}, {len(faces)} faces, far {len(far.data.polygons)}; extras {extras}")
    return top, rig, body, extras


# ======== The sleigh.
# Its colour slots (u in the UVs; world/santa.ts SLEIGH_LOOK paints them).
LACQUER, GOLD, WOOD, VELVET, SACK, GIFT_A, GIFT_B, GIFT_C, GIFT_D, RIBBON, STRAP, ROPE = range(12)
TEAM = [(-0.62, -2.8), (0.62, -2.8), (-0.62, -5.0), (0.62, -5.0)]  # each reindeer's middle (x, y), Blender axes; the front pair last
POLE_Z = 0.78
SEAT = (0.0, 0.05, 0.42)  # where Santa sits: his feet's origin (the floor), the seat 45 cm above it


def build_sleigh(rd_extras):
    pieces = []

    def add(piece, slot, shade=1.0):
        pieces.append((piece, slot, shade))

    s = 1.0
    # The body's outline along its length (y, Blender -y is ahead): the top line high at the back and curled up at
    # the front, the bottom line rising at the front.
    def topz(y):
        return 0.86 + 0.42 * smooth((y - 0.45) / 0.7) + 0.34 * smooth((-0.6 - y) / 0.55)

    def botz(y):
        return 0.40 + 0.2 * smooth((-0.75 - y) / 0.45)

    def half_w(y, z):
        return 0.6 + 0.05 * math.sin(math.pi * (y + 1.2) / 2.4) + 0.07 * (z - 0.4)

    N = 28
    ys = [-1.2 + 2.4 * i / N for i in range(N + 1)]
    for sg in (-1, 1):
        # A side panel: a slab 4 cm thick along the outline, leaning out a little at the top.
        verts, faces = [], []
        for y in ys:
            zb, zt = botz(y), topz(y)
            xo_b, xo_t = half_w(y, zb), half_w(y, zt)
            verts += [Vector((sg * xo_b, y, zb)), Vector((sg * xo_t, y, zt)), Vector((sg * (xo_t - 0.04), y, zt)), Vector((sg * (xo_b - 0.04), y, zb))]
        for i in range(N):
            a, b = 4 * i, 4 * (i + 1)
            for k in range(4):
                k2 = (k + 1) % 4
                faces.append((a + k, a + k2, b + k2, b + k))
        faces.append((0, 1, 2, 3)[::-1])
        faces.append(tuple(4 * N + k for k in range(4)))
        add((verts, faces), LACQUER)
        # Gold trim along the top and the bottom edge, and a gold scroll line in the middle of the panel.
        add(V["tube"]([Vector((sg * (half_w(y, topz(y)) - 0.01), y, topz(y) + 0.008)) for y in ys], [0.022] * len(ys), 6), GOLD)
        add(V["tube"]([Vector((sg * half_w(y, botz(y)), y, botz(y))) for y in ys], [0.016] * len(ys), 6), GOLD)
        mid = [Vector((sg * (half_w(y, (topz(y) + botz(y)) / 2) + 0.004), y, botz(y) + 0.45 * (topz(y) - botz(y)))) for y in ys[3:-3]]
        add(V["tube"](mid, [0.009] * len(mid), 5), GOLD)
        # The runner: along the ground, curling up and over at the front.
        rx = sg * 0.56
        pts = [(1.32, 0.05), (0.8, 0.045), (0.0, 0.045), (-0.8, 0.05), (-1.2, 0.12), (-1.5, 0.34), (-1.62, 0.62), (-1.56, 0.84), (-1.42, 0.93), (-1.3, 0.87),
               (-1.3, 0.77), (-1.38, 0.75)]
        curve = catmull([Vector((rx, y, z)) for y, z in pts], 6)
        add(V["tube"](curve, [0.028] * len(curve), 8), GOLD)
        add(V["tube"]([Vector((rx, 1.32, 0.05)), Vector((rx, 1.4, 0.1)), Vector((rx, 1.38, 0.17))], [0.028, 0.026, 0.022], 8), GOLD)
        for y in (0.95, 0.15, -0.65):  # the uprights from the runner to the body
            add(V["tube"]([Vector((rx, y, 0.05)), Vector((sg * (half_w(y, botz(y)) - 0.03), y, botz(y) + 0.02))], [0.02, 0.02], 6), GOLD)
    # The front: a curved panel between the sides, below the curl; the back: an arched panel, high.
    def across(y_of, z0_of, z1_of, slot, thick=0.04, n=14):
        verts, faces = [], []
        for i in range(n + 1):
            x = -1 + 2 * i / n
            y = y_of(x)
            xx = x * half_w(y, z0_of(x)) * 0.97
            verts += [Vector((xx, y, z0_of(x))), Vector((xx, y, z1_of(x))), Vector((xx, y + thick, z1_of(x))), Vector((xx, y + thick, z0_of(x)))]
        for i in range(n):
            a, b = 4 * i, 4 * (i + 1)
            for k in range(4):
                k2 = (k + 1) % 4
                faces.append((a + k, b + k, b + k2, a + k2))
        faces.append((0, 1, 2, 3))
        faces.append(tuple(4 * n + k for k in range(4))[::-1])
        add((verts, faces), slot)

    yf = -1.1
    across(lambda x: yf + 0.12 * x * x, lambda x: botz(yf), lambda x: topz(yf) - 0.05, LACQUER)
    yb = 1.14
    across(lambda x: yb - 0.04, lambda x: 0.40, lambda x: topz(yb) + 0.1 * math.cos(math.pi * x / 2), LACQUER)
    add(V["tube"]([Vector((x * 0.6, yb - 0.04, topz(yb) + 0.1 * math.cos(math.pi * x / 2) + 0.01)) for x in [-1 + 2 * i / 14 for i in range(15)]], [0.022] * 15, 6), GOLD)
    add(V["tube"]([Vector((x * 0.6, yf + 0.12 * x * x - 0.01, topz(yf) - 0.04)) for x in [-1 + 2 * i / 14 for i in range(15)]], [0.02] * 15, 6), GOLD)
    # The floor, the seat and its back.
    add(V["box"](Vector((0, 0.0, 0.41)), (0.6, 1.12, 0.02)), WOOD)
    add(V["box"](Vector((0, SEAT[1] + 0.06, SEAT[2] + 0.36)), (0.56, 0.3, 0.09), bevel=0.06), VELVET)
    add(V["box"](Vector((0, SEAT[1] + 0.06, SEAT[2] + 0.14)), (0.55, 0.28, 0.14)), WOOD, 0.8)
    add(V["box"](Vector((0, SEAT[1] + 0.4, SEAT[2] + 0.62)), (0.56, 0.06, 0.3), bevel=0.05), VELVET, 0.9)
    add(V["box"](Vector((0, SEAT[1] + 0.47, SEAT[2] + 0.55)), (0.6, 0.02, 0.38)), LACQUER)
    add(V["tube"]([Vector((x * 0.6, SEAT[1] + 0.47, SEAT[2] + 0.94)) for x in (-1, -0.5, 0, 0.5, 1)], [0.02] * 5, 6), GOLD)
    # The sack behind the seat, full and lumpy, tied at the top, with presents in its mouth.
    sc = Vector((0.0, 0.78, 1.0))
    lump = lambda d: 1.0 + 0.07 * math.sin(4.0 * d.x + 2.0 * d.y) * math.cos(3.0 * d.z + 1.0) + 0.05 * math.sin(7 * d.y + 3 * d.z) - 0.1 * max(0.0, d.z) ** 3
    add(V["ellipsoid"](sc, (0.5, 0.3, 0.46), 18, 12, shape=lump), SACK)
    neck = [sc + Vector((0, 0.02, 0.38)), sc + Vector((0.0, 0.04, 0.5)), sc + Vector((0.02, 0.06, 0.6))]
    add(V["tube"](neck, [0.16, 0.1, 0.2], 12), SACK, 0.92)
    add(V["torus"](neck[1], 0.105, 0.018, 14, 5), ROPE)
    for (x, y, z, hx, hy, hz, rz, rx, slot) in ((-0.1, 0.84, 1.62, 0.13, 0.11, 0.1, 18, -12, GIFT_A), (0.13, 0.78, 1.57, 0.1, 0.1, 0.12, -25, 8, GIFT_B),
                                                (0.02, 0.9, 1.70, 0.08, 0.08, 0.08, 5, 20, GIFT_C)):
        gift(add, Vector((x, y, z)), (hx, hy, hz), Matrix.Rotation(math.radians(rz), 3, "Z") @ Matrix.Rotation(math.radians(rx), 3, "X"), slot)
    for (x, y, z, hx, hy, hz, rz, slot) in ((-0.35, -0.75, 0.56, 0.16, 0.14, 0.14, 12, GIFT_D), (0.36, -0.7, 0.53, 0.14, 0.12, 0.11, -20, GIFT_C),
                                            (0.32, 0.6, 0.53, 0.12, 0.12, 0.11, 30, GIFT_A)):
        gift(add, Vector((x, y, z)), (hx, hy, hz), Matrix.Rotation(math.radians(rz), 3, "Z"), slot)
    # The pole between the pairs, from the sleigh's front to the front pair, and the traces to each reindeer.
    gx, gz, gyo, grad = rd_extras["girth"]
    gy = -gyo  # back to Blender's y
    tip = Vector((0, TEAM[2][1] + gy - 0.5, POLE_Z + 0.12))
    add(V["tube"]([Vector((0, -1.05, 0.5)), Vector((0, -1.6, POLE_Z)), Vector((0, (TEAM[0][1] + TEAM[2][1]) / 2, POLE_Z + 0.06)), tip], [0.04, 0.038, 0.034, 0.03], 8), WOOD)
    add(V["ellipsoid"](tip + Vector((0, -0.04, 0)), (0.045, 0.06, 0.045), 10, 6), GOLD)
    for i, (x, y) in enumerate(TEAM):
        sg = 1 if x > 0 else -1
        band = Vector((x + gx, y + gy, gz))
        inner = band + Vector((-sg * grad, 0, 0))
        outer = band + Vector((sg * grad, 0, 0))
        add(V["tube"]([inner, Vector((0.0, y + gy + 0.25, POLE_Z + 0.03))], [0.013, 0.013], 5), STRAP)
        if i < 2:  # the rear pair's outer traces to the sleigh's front corners
            add(V["tube"]([outer, outer + Vector((0, 0.5, -0.06)), Vector((sg * 0.56, -1.12, 0.55))], [0.013] * 3, 5), STRAP)
        else:  # the front pair's back to the rear pair's band
            rear = Vector((TEAM[i - 2][0] + gx + sg * grad, TEAM[i - 2][1] + gy, gz))
            add(V["tube"]([outer, outer + Vector((0, 0.6, -0.05)), rear + Vector((0, -0.25, 0)), rear], [0.012] * 4, 5), STRAP)
    # One mesh, each piece's faces with its slot and shade in the UVs.
    co, faces, uvs = [], [], []
    for (vv, ff), slot, shade in pieces:
        base = len(co)
        co.extend(Vector(p) for p in vv)
        for f in ff:
            faces.append(tuple(base + i for i in f))
            uvs.append((slot + 0.5, 1.0 - shade))
    me = bpy.data.meshes.new("sleigh")
    me.from_pydata([p[:] for p in co], [], faces)
    me.update()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    uv = me.uv_layers.new(name="UVMap")
    for p, t in zip(me.polygons, uvs):
        for li in p.loop_indices:
            uv.data[li].uv = t
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(50))
    sm = bpy.data.materials.new("sleigh")
    me.materials.append(sm)
    o = link(bpy.data.objects.new("sleigh", me))
    o["team"] = [[round(x, 3), 0.0, round(-y, 3)] for x, y in TEAM]  # glTF axes
    o["seat"] = [SEAT[0], SEAT[2], -SEAT[1]]
    print(f"sleigh: {sum(len(f) - 2 for f in faces)} triangles, {len(co)} points")
    return o


def gift(add, c, half, m, slot):
    """A wrapped present: a box, two ribbons round it and a bow on top."""
    add(V["box"](c, half, m, bevel=0.012), slot)
    hx, hy, hz = half
    add(V["box"](c, (hx + 0.004, 0.018, hz + 0.004), m), RIBBON)
    add(V["box"](c, (0.018, hy + 0.004, hz + 0.004), m), RIBBON)
    topc = c + m @ Vector((0, 0, hz + 0.02))
    for sg in (-1, 1):
        add(V["torus"](topc + m @ Vector((sg * 0.035, 0, 0)), 0.03, 0.009, 10, 4, m @ Matrix.Rotation(math.radians(90), 3, "X") @ Matrix.Rotation(math.radians(sg * 20), 3, "Y")), RIBBON)


def catmull(pts, n):
    """A smooth line through the points (Catmull-Rom), n steps between each two."""
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t))
    out.append(pts[-1])
    return out


# ======== Build, export, repack.
santa_top, santa_rig, santa_mesh, SB = build_santa()
rd_top, rd_rig, rd_body, RD_EXTRAS = build_reindeer()
sleigh = build_sleigh(RD_EXTRAS)
bpy.ops.object.select_all(action="DESELECT")
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
    export_texcoords=True, export_normals=True, export_tangents=False, export_materials="EXPORT", export_image_format="JPEG",
    export_vertex_color="NONE", export_attributes=False,
    export_cameras=False, export_lights=False, export_extras=True,
    export_skins=True, export_influence_nb=4, export_all_influences=False, export_def_bones=False,
    export_morph=False, export_animations=True, export_animation_mode="ACTIONS", export_nla_strips=True,
    export_force_sampling=True, export_frame_step=STEP, export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=True, export_anim_slide_to_zero=True,
    export_reset_pose_bones=True, export_rest_position_armature=True, export_anim_single_armature=False,
    export_merge_animation="ACTION", export_bake_animation=False, export_leaf_bone=False,
    export_armature_object_remove=False, export_hierarchy_flatten_bones=False)


def repack(j, bin_):
    """villagers.py's repack (identical accessors once, weights as bytes, still channels dropped), keeping the
    reindeer's picture, which it doesn't know."""
    pics = []
    for im in j.get("images", []):
        bv = j["bufferViews"][im["bufferView"]]
        o = bv.get("byteOffset", 0)
        pics.append(bin_[o:o + bv["byteLength"]])
    j, blob = V["repack"](j, bin_)
    blob = bytearray(blob)
    for im, data in zip(j.get("images", []), pics):
        blob.extend(b"\0" * (-len(blob) % 4))
        j["bufferViews"].append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        im["bufferView"] = len(j["bufferViews"]) - 1
        blob.extend(data)
    j["buffers"] = [{"byteLength": len(blob)}]
    return j, bytes(blob)


size_raw = os.path.getsize(OUT)
j, bin_ = V["read_glb"](OUT)
j, bin_ = repack(j, bin_)
V["write_glb"](OUT, j, bin_)
print(f"GLB {OUT}: {size_raw} bytes from Blender, {os.path.getsize(OUT)} repacked")
print(f"GLB {OUT}: {size_raw} bytes; {len(j.get('animations', []))} clips: {[a['name'] for a in j.get('animations', [])]}")
for m in j["meshes"]:
    for pr in m["primitives"]:
        print(f"  mesh {m['name']}: {j['accessors'][pr['indices']]['count'] // 3} triangles, {j['accessors'][pr['attributes']['POSITION']]['count']} points,"
              f" attributes {sorted(pr['attributes'])}")
print("extras:", [(nd["name"], nd["extras"]) for nd in j["nodes"] if nd.get("extras")])

# ======== Previews.
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    pal = {SKIN: "#e3a98c", HAIR: "#f2f0ec", TOP: "#b3141b", BOTTOM: "#a51319", SHOES: "#171514", WHITE: "#f4f2ee", DARK: "#141212", METAL: "#d9a93a",
           LIPS: "#b8645c", SOLE: "#2a2522"}
    me = santa_mesh.data
    uvl = me.uv_layers[0]
    ca = me.color_attributes["Col"]
    for p in me.polygons:
        u, v = uvl.data[p.loop_indices[0]].uv
        col = V["rgb"](pal.get(int(u) % 16, "#ff00ff"))
        for li in p.loop_indices:
            ca.data[li].color_srgb = (col[0] * (1 - v), col[1] * (1 - v), col[2] * (1 - v), 1.0)
    for o in bpy.data.objects:
        if o.name.endswith("_far"):
            o.hide_render = True
    spal = ["#a3121a", "#d4a23a", "#4a2c1c", "#6e0f18", "#9c7a52", "#2f7a3a", "#2c4f9c", "#d8b13a", "#c4233a", "#f2efe8", "#4a1a14", "#c9a25a"]
    sm = sleigh.data
    sca = sm.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    suv = sm.uv_layers[0]
    for p in sm.polygons:
        u, v = suv.data[p.loop_indices[0]].uv
        col = V["rgb"](spal[int(u)])
        for li in p.loop_indices:
            sca.data[li].color_srgb = (col[0] * (1 - v), col[1] * (1 - v), col[2] * (1 - v), 1.0)
    sm.materials.clear()
    sm.materials.append(MAT)
    # The team: four reindeer (copies of the one) in their places, Santa beside the sleigh.
    for i, (x, y) in enumerate(TEAM):
        if i == 0:
            tp, r2 = rd_top, rd_rig
        else:
            tp = link(bpy.data.objects.new(f"rd_preview{i}", None))
            r2 = link(rd_rig.copy())
            r2.parent = tp
            b2 = link(rd_body.copy())
            b2.parent = r2
            b2.modifiers["Armature"].object = r2
        r2.animation_data_create()
        for tr in r2.animation_data.nla_tracks:
            tr.mute = True
        r2.animation_data.action = bpy.data.actions.get(["reindeer_Idle", "reindeer_Graze", "reindeer_Look", "reindeer_Idle"][i])
        tp.location = (x, y, 0)
    for tr in santa_rig.animation_data.nla_tracks:
        tr.mute = True
    santa_top.location = (-0.95, 0.2, 0)
    santa_top.rotation_euler = (0, 0, math.radians(-70))
    santa_rig.animation_data.action = bpy.data.actions.get("santa_Wave")
    scene.frame_set(12)
    V["render"](os.path.join(PREVIEW, "team.png"), (-5.5, -6.5, 2.6), (0.0, -1.8, 0.7), 35, (1200, 700))
    V["render"](os.path.join(PREVIEW, "team_side.png"), (-8.0, -1.5, 1.6), (0.0, -1.8, 0.8), 35, (1200, 600))
    V["render"](os.path.join(PREVIEW, "santa_front.png"), (-0.95 - 2.6, 0.2 - 1.0, 1.25), (-0.95, 0.2, 1.0), 50, (600, 700))
    V["render"](os.path.join(PREVIEW, "santa_side.png"), (-0.95 + 0.9 * 2.6, 0.2 - 0.33 * 2.6, 1.25), (-0.95, 0.2, 1.0), 50, (600, 700))
    V["render"](os.path.join(PREVIEW, "santa_face.png"), (-0.95 - 0.95, 0.2 - 0.35, 1.62), (-0.95, 0.2, 1.52), 50, (500, 500))
    santa_top.location = (SEAT[0], SEAT[1], SEAT[2])
    santa_top.rotation_euler = (0, 0, 0)
    santa_rig.animation_data.action = bpy.data.actions.get("santa_SitWave")
    for o in bpy.data.objects:
        if o.type == "ARMATURE" and o.name.startswith("reindeer_rig"):
            o.animation_data.action = bpy.data.actions.get("reindeer_Run")
    scene.frame_set(6)
    V["render"](os.path.join(PREVIEW, "flight.png"), (-5.0, 3.5, 2.2), (0.0, -1.6, 0.8), 35, (1200, 600))
    V["render"](os.path.join(PREVIEW, "flight_below.png"), (-2.5, -1.5, -4.0), (0.0, -1.8, 0.8), 35, (1200, 600))
    santa_rig.animation_data.action = bpy.data.actions.get("santa_Laugh")
    santa_top.location = (-0.95, 0.2, 0)
    santa_top.rotation_euler = (0, 0, math.radians(-70))
    scene.frame_set(20)
    V["render"](os.path.join(PREVIEW, "santa_laugh.png"), (-0.95 - 2.6, 0.2 - 1.0, 1.25), (-0.95, 0.2, 1.0), 50, (600, 700))
