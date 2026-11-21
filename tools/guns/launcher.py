"""Build the break-open grenade launcher (the game's `launcher`, the Brook Spirit's prize) in Blender, with its hands.

Run (Blender 5, no window):
  blender -b -P tools/guns/launcher.py -- <out.glb> [preview_dir]
It writes the GLB (web/public/models/gun-launcher.glb in the repository); the game takes the launcher from it in place
of the one in weapons.glb (weapon.ts GUN_FILES), which stays there as the fallback. With preview_dir it also renders
small pictures there: each view in clay and in the materials, the player's views with the hands, each hand alone.

Our own design on the classic lines of a single-shot 40 mm launcher, no maker, mark or text on it: 0.71 m, a 334 mm
barrel. The same layout as tools/weapons.py's (the grip, the fore grip, the hinge, the muzzle, the line of sight and
the round where they were), each part made again in detail:
- the break frame: a steel receiver rounded over the top and closed by a dome, its long edges chamfered; a side plate
  let into each side with a thin seam round it and socket screws; the hinge pin through both knuckles, its slotted
  head on the left; the trigger's and the hammer's pin heads; the standing breech with the firing pin's bushing;
- the latch on top: a lever on a round boss lying back along the tang, its thumb pad ridged across; behind it the sliding
  safety on the tang, ridged, in a slot, a white dot beside it;
- the barrel: its breech face with the extractor, a dark seam where it breaks from the frame, a reinforced muzzle with
  a chamfered crown, and the twelve-groove rifling inside; the olive handguard, eight-sided, with retaining rings at
  both ends, ribs over its top and heat slots cut into its sides; the fore grip shaped for the fingers on its mount;
  the front sight's blade, bead and guard ears; the folding leaf sight: a hinged base, a ladder with range marks up
  both rails, a slider with its aperture (the line of sight) and a knurled lock;
- the walnut stock, shaped through cross-sections with a raised comb, a ribbed rubber pad with its two screws, a sling
  swivel; the walnut grip with checkering on both sides and a steel cap; the trigger, curved, in a steel guard;
- the round: a steel rim and case with a crimp groove and the primer, a copper rotating band, an olive ogive with a
  brass band, and the fuze's nose.

Frame and nodes as tools/weapons.py's header says for the launcher: the barrel along -z, up +y, right +x, metres, the
origin where the web of the right hand sits on the grip;
  launcher             the weapon (an empty)
    launcher_body      the parts that never move
    launcher_barrel    the barrel with its handguard, fore grip and sights; it tips down about its origin, the hinge pin
    launcher_round     the grenade, its origin at its middle (the hand brings it, the breech takes it)
    launcher_muzzle    the muzzle's face, on the bore's axis
    launcher_sight     the leaf sight's aperture, on the line of sight
    launcher_kit       Paintball's air tank and paint balloons
    launcher_hands     launcher_handR, launcher_handL: tools/weapons.py's hands, fitted as there
Helpers, the hands, the bake and the packing: tools/guns/heavykit.py.
"""
import math
import os
import sys

import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import heavykit as K  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

K.reset()
K.M.update(K.materials())
M = K.M
# The walnut in the pump shotgun's brown (tools/guns/shotgun.py), not heavykit's lighter one, which read orange.
_wood = M["Wood"].node_tree.nodes["Principled BSDF"]
_wood.inputs["Base Color"].default_value = (*K.srgb("#43281a"), 1)
_wood.inputs["Roughness"].default_value = 0.45
from heavykit import (Matrix, Vector, block, box, chamfers, dark, knurl, lathe, prism, ring, screw, shell, sweep,  # noqa: E402
                      yprism, zprism)

W = "launcher"
B = 0.07            # the barrel's axis over the grip
HY, HZ = 0.088, B - 0.04  # the hinge pin, under the breech
DY = -0.05          # the fore grip, this much further back than the tube launcher's
R, BORE = 0.027, 0.020    # the barrel's outside, and its bore
FW = 0.0275         # the frame's half width
SY, SZ = 0.098, B + 0.048  # the leaf sight's aperture: the line of sight
AX = (0, 0, B)
GRIP = (0, -0.032, 0.0)
body = []


def arc(cy, cz, r, a0, a1, steps):
    """Points (y, z) on a circle round (cy, cz) from angle a0 to a1 (degrees; 0 forward along y, 90 up)."""
    return [(cy + r * math.cos(math.radians(a0 + (a1 - a0) * i / steps)), cz + r * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]


def loft(name, sections, mat, sides=28, power=3.0):
    """A smooth body through cross-sections along y, closed at both ends (tools/weapons.py's): each (y, zc, hz, hw) a
    rounded rectangle (a superellipse of `power`) hz high and hw wide (half sizes) round (0, y, zc). The stock, its pad."""
    bm = bmesh.new()
    rings = []
    for y, zc, hz, hw in sections:
        rings.append([bm.verts.new((hw * math.copysign(abs(math.cos(2 * math.pi * k / sides)) ** (2 / power), math.cos(2 * math.pi * k / sides)), y,
                                    zc + hz * math.copysign(abs(math.sin(2 * math.pi * k / sides)) ** (2 / power), math.sin(2 * math.pi * k / sides))))
                      for k in range(sides)])
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.shade(K.mesh_obj(name, bm, [mat]), 60)


def rifled(name, t0, t1, r, depth, grooves, twist, mat, at):
    """The bore seen from inside, t0 to t1 along y round `at`: `grooves` lands and grooves `depth` deep, turning by
    `twist` (radians) over its length; its faces turned in, towards the axis."""
    bm = bmesh.new()
    n = grooves * 2
    rings = []
    for t in (t0, (t0 + t1) / 2, t1):
        turn = twist * (t - t0) / (t1 - t0)
        rings.append([bm.verts.new((at[0] + (r + (depth if k % 2 else 0.0)) * math.cos(2 * math.pi * k / n + turn), at[1] + t,
                                    at[2] + (r + (depth if k % 2 else 0.0)) * math.sin(2 * math.pi * k / n + turn))) for k in range(n)])
    for a, b in zip(rings, rings[1:]):
        for k in range(n):
            f = bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
            f.normal_update()
            c = f.calc_center_median()
            if f.normal.dot(Vector((c.x - at[0], 0, c.z - at[2]))) > 0:
                f.normal_flip()
    o = K.mesh_obj(name, bm, [mat])
    for p in o.data.polygons:
        p.use_smooth = False
    return o


def checkering(name, corners, x, s, cells_u, cells_v, height, mat):
    """A checkered panel on a flat side at x (s: -1 the left, +1 the right): the quad `corners` ((y, z) x 4, round)
    split into cells, each a little pyramid `height` proud: the diamonds of hand-cut checkering."""
    bm = bmesh.new()
    (y0, z0), (y1, z1), (y2, z2), (y3, z3) = corners

    def at(u, v, up=0.0):
        a = (y0 + (y1 - y0) * u, z0 + (z1 - z0) * u)
        b = (y3 + (y2 - y3) * u, z3 + (z2 - z3) * u)
        return Vector((x + s * up, a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v))

    grid = [[bm.verts.new(at(i / cells_u, j / cells_v)) for j in range(cells_v + 1)] for i in range(cells_u + 1)]
    for i in range(cells_u):
        for j in range(cells_v):
            top = bm.verts.new(at((i + 0.5) / cells_u, (j + 0.5) / cells_v, height))
            ring_ = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]
            for k in range(4):
                f = bm.faces.new((ring_[k], ring_[(k + 1) % 4], top))
                f.normal_update()
                if f.normal.x * s < 0:
                    f.normal_flip()
    o = K.mesh_obj(name, bm, [mat])
    for p in o.data.polygons:
        p.use_smooth = False
    return o


# ---- The frame ------------------------------------------------------------------------------
# The narrow trigger housing over the grip (the thumb lies along its left side) and the wider break frame above it,
# rounded over the top like the barrel and closed by a dome at the back; its long lower edges chamfered.
body.append(prism("housing", [(-0.066, 0.03), (-0.066, 0.008), (-0.05, -0.004), (0.05, -0.004), (0.064, 0.008), (0.066, 0.03)], 0.0155, M["Steel"],
                  0.0016, 2, cuts=chamfers(0.0155, 0.03, -0.004, 0, 0.0025, -0.1, 0.1)))
frame_cuts = chamfers(FW, B, 0.027, 0, 0.0035, -0.1, 0.1)
for s in (-1, 1):  # the side plate's recess
    frame_cuts.append(dark(box(s * FW - 0.0012 if s > 0 else -FW - 0.01, s * FW + 0.01 if s > 0 else -FW + 0.0012, -0.056, 0.040, 0.034, B - 0.006)))
body.append(prism("frame", [(-0.07, B), (-0.074, 0.04), (-0.062, 0.027), (0.05, 0.027), (0.0565, 0.034), (0.0565, B)], FW, M["Steel"], 0.0016, 2,
                  cuts=frame_cuts))
# The rounded top, and at the back a long dome that slopes down into the tang (aimed, the eye looks over it: a short
# full dome showed as a dark round mass at the foot of the view); the safety's slot cut into the tang.
TZ = B + 0.0185  # the tang's top where the safety slides
body.append(lathe("shroud", [(-0.080, 0.0), (-0.0795, 0.008), (-0.076, 0.014), (-0.066, 0.019), (-0.052, 0.024), (-0.042, FW), (0.0545, FW),
                             (0.0565, 0.0255), (0.0565, 0)], M["Steel"], 32, AX))
body[-1] = K.cut(body[-1], [dark(box(-0.0055, 0.0055, -0.0715, -0.0575, TZ - 0.0012, B + 0.05))])
for s in (-1, 1):
    body.append(block("plate", s * (FW - 0.0012), s * (FW - 0.0004), -0.0553, 0.0393, 0.0347, B - 0.0067, M["Dark"], 0.0004, 1))
    for y, z in ((-0.047, 0.040), (0.031, 0.040), (-0.047, B - 0.013), (0.031, B - 0.013)):
        body.append(screw(s * (FW - 0.0004), y, z, s, 0.0022))
# The pins through the housing: the trigger's and the hammer's, their heads on both sides.
for s in (-1, 1):
    for y, z in ((0.022, 0.006), (-0.034, 0.014)):
        body.append(ring("pin", *((0.0155, 0.0163) if s > 0 else (-0.0163, -0.0155)), 0.0024, M["Dark"], (0, y, z), 12, "x", 0.0003))
# The standing breech's face (the barrel's breech closes on it) with the firing pin's bushing and hole.
body.append(lathe("face", [(0.0555, 0), (0.0555, 0.0215), (0.0572, 0.0215), (0.0572, 0.0048), (0.0578, 0.0042), (0.0578, 0.0018), (0.0572, 0.0018),
                           (0.0572, 0)], [M["Dark"], M["Steel"]], 32, AX, seg_mat=[0, 0, 0, 1, 1, 1, 0]))
# The side knuckles the barrel hinges between, and the hinge pin through them: a slotted head on the left, a small
# retaining screw on the right.
knuckle = [(0.05, HZ + 0.0115)] + arc(HY, HZ, 0.0115, 90, -90, 10) + [(0.05, HZ - 0.0115)]
for s in (-1, 1):
    body.append(prism("knuckle", knuckle, 0.005, M["Steel"], 0.0012, 2, x=s * (FW - 0.005)))
body.append(ring("hingepin", -FW - 0.0006, FW + 0.0006, 0.0058, M["Dark"], (0, HY, HZ), 20, "x", 0.0004))
body.append(K.cut(ring("pinhead", -FW - 0.0022, -FW - 0.0004, 0.0070, M["Steel"], (0, HY, HZ), 20, "x", 0.0006),
                  [dark(box(-FW - 0.004, -FW - 0.0012, HY - 0.0062, HY + 0.0062, HZ - 0.0006, HZ + 0.0006))]))
body.append(screw(FW + 0.0006, HY, HZ, 1, 0.0034))
# The latch on top: a round boss, the lever lying back along the tang, its thumb pad ridged across.
LZ = B + FW
body.append(lathe("boss", [(LZ - 0.002, 0), (LZ - 0.002, 0.0070), (LZ + 0.0032, 0.0070), (LZ + 0.0040, 0.0062), (LZ + 0.0040, 0)], M["Dark"], 20,
                  (0, -0.030, 0), "z"))
body.append(ring("bossscrew", LZ + 0.0040, LZ + 0.0050, 0.0030, M["Steel"], (0, -0.030, 0), 12, "z", 0.0003))
# Closed, it lies straight back along the tang on the centre line, its thumb pad towards you (aimed, you look over it).
d = Vector((0.0, -1.0, 0))
n = Vector((-d.y, d.x, 0))
p0, p1 = Vector((0.0, -0.030, 0)), Vector((0.0, -0.043, 0))
lever = [p0 - n * 0.0040 - d * 0.004, p1 - n * 0.0046, p1 + d * 0.0005 - n * 0.0062, p1 + d * 0.0125 - n * 0.0062, p1 + d * 0.0135 - n * 0.004,
         p1 + d * 0.0135 + n * 0.004, p1 + d * 0.0125 + n * 0.0062, p1 + d * 0.0005 + n * 0.0062, p1 + n * 0.0046, p0 + n * 0.0040 - d * 0.004]
body.append(zprism("lever", [(p.x, p.y) for p in lever], LZ + 0.0018, LZ + 0.0052, M["Dark"], 0.0007, 1))
for k in range(5):
    c = p1 + d * (0.0015 + 0.0024 * k)
    rid = [c - d * 0.0005 - n * 0.0056, c + d * 0.0005 - n * 0.0056, c + d * 0.0005 + n * 0.0056, c - d * 0.0005 + n * 0.0056]
    body.append(zprism("ridge", [(p.x, p.y) for p in rid], LZ + 0.0050, LZ + 0.0063, M["Dark"], 0.0002, 1))
# The sliding safety on the tang behind it, ridged, a white dot beside it ("safe").
body.append(block("safety", -0.0046, 0.0046, -0.0700, -0.0590, TZ - 0.0016, TZ + 0.0026, M["Dark"], 0.0007, 1,
                  cuts=[dark(box(-0.01, 0.01, y, y + 0.0009, TZ + 0.0018, TZ + 0.004)) for y in (-0.0672, -0.0650, -0.0628, -0.0606)]))
body.append(ring("safedot", B + 0.0160, B + 0.0168, 0.0012, M["Dot"], (0.0075, -0.064, 0), 10, "z", 0.0))
# The grip in walnut, checkered on both sides, a steel cap; the trigger, curved, and the guard in a smooth curve.
GRIP_PTS = [(0.005, 0.0), (-0.003, -0.04), (-0.012, -0.095), (-0.05, -0.098), (-0.045, -0.06), (-0.036, -0.02), (-0.035, 0.0)]
body.append(prism("grip", GRIP_PTS, 0.0145, M["Wood"], 0.0038, 2))
for s in (-1, 1):
    body.append(checkering("checker", [(-0.0062, -0.024), (-0.0136, -0.084), (-0.0425, -0.086), (-0.0368, -0.024)], s * 0.01452, s, 7, 13, 0.00055, M["Wood"]))
body.append(prism("gcap", [(-0.011, -0.093), (-0.051, -0.096), (-0.052, -0.103), (-0.012, -0.100)], 0.0148, M["Steel"], 0.0015, 2))
body.append(ring("capscrew", -0.1032, -0.1020, 0.0025, M["Dark"], (0, -0.031, 0), 8, "z", 0.0003))
body.append(prism("trigger", [(0.0255, -0.001), (0.0285, -0.008), (0.0280, -0.016), (0.0245, -0.0215), (0.0215, -0.0205), (0.0240, -0.0155),
                              (0.0245, -0.0085), (0.0220, -0.001)], 0.0029, M["Steel"], 0.0005, 1))
yc, zc, ry, rz, t = 0.03, -0.004, 0.026, 0.028, 0.0034
outer = [(yc + (ry + t / 2) * math.cos(math.radians(a)), zc + (rz + t / 2) * math.sin(math.radians(a))) for a in range(10, -165, -10)]
inner = [(yc + (ry - t / 2) * math.cos(math.radians(a)), zc + (rz - t / 2) * math.sin(math.radians(a))) for a in range(-160, 11, 10)]
body.append(prism("guard", outer + inner, 0.0042, M["Steel"], 0.0009, 2))
# The stock: walnut through cross-sections, a slim wrist behind the grip, a comb rising under the cheek to its nose and
# falling away from there to the heel, wider towards the butt; a ribbed rubber pad with two screws; a sling swivel under it.
stock = [(-0.064, 0.04, 0.042, 0.0145), (-0.085, 0.033, 0.043, 0.014), (-0.11, 0.018, 0.04, 0.0135), (-0.14, 0.015, 0.047, 0.0148),
         (-0.17, 0.011, 0.055, 0.0165), (-0.21, 0.00525, 0.05875, 0.018), (-0.25, -0.00085, 0.06185, 0.0193), (-0.285, -0.0055, 0.0635, 0.0203),
         (-0.297, -0.00685, 0.06435, 0.0205), (-0.2995, -0.00675, 0.06375, 0.0202)]
body.append(loft("stock", stock, M["Wood"], 32, 2.4))
body.append(loft("pad", [(-0.2985, -0.0075, 0.0645, 0.0212), (-0.315, -0.0075, 0.0645, 0.0212), (-0.3172, -0.0075, 0.0632, 0.0205),
                         (-0.3185, -0.0075, 0.0612, 0.0192)], M["Grip"], 28, 2.4))
for k in range(8):
    z = -0.054 + k * 0.0148
    body.append(block("prib", -0.0165, 0.0165, -0.3205, -0.3175, z, z + 0.0045, M["Grip"], 0.0006, 1))
for z in (-0.0443, 0.0445):  # between the ribs
    body.append(lathe("padscrew", [(-0.3198, 0), (-0.3198, 0.0024), (-0.3180, 0.0028), (-0.3180, 0)], M["Dark"], 8, (0, 0, z)))
body.append(block("stud", -0.0045, 0.0045, -0.256, -0.244, -0.07, -0.0605, M["Steel"], 0.001, 1))
body.append(sweep("swivel", [(0, -0.25 + 0.0075 * math.cos(math.radians(a)), -0.0765 + 0.0065 * math.sin(math.radians(a))) for a in range(80, 431, 30)],
                  [0.0014] * 12, M["Steel"], 6))

# ---- The barrel (it moves: it tips down about the pin) --------------------------------------
# Its outside in one turn: the breech face, a dark seam where it breaks from the frame, a collar where it leaves the
# handguard, the reinforced muzzle and its chamfered crown; inside, the rifling.
barrel = []
BP = [(0.0632, BORE + 0.0004), (0.0632, 0.0212), (0.0580, 0.0212), (0.0580, R - 0.0008), (0.0588, R), (0.0640, R), (0.0646, R - 0.0004), (0.0652, R), (0.3150, R), (0.3155, 0.0292),
      (0.3220, 0.0292), (0.3225, R), (0.3710, R), (0.3722, 0.0298), (0.3734, 0.0306), (0.3900, 0.0306), (0.3920, 0.0290), (0.3920, 0.0236),
      (0.3895, BORE + 0.0011), (0.3880, BORE + 0.0004)]
barrel.append(lathe("tube", BP, [M["Steel"], M["Dark"]], 36, AX, seg_mat=[0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
barrel.append(rifled("bore", 0.0632, 0.3882, BORE + 0.0004, 0.0009, 12, 0.5, M["Dark"], AX))
barrel.append(block("extractor", -0.0062, 0.0062, 0.0574, 0.0581, B - R + 0.0022, B - BORE - 0.0012, M["Steel"], 0.0003, 1))
# Its own knuckle round the pin, between the frame's.
bk = arc(HY, HZ, 0.0105, -90, 70, 10) + [(0.105, B - 0.02), (0.06, B - 0.02), (0.06, HZ - 0.0105)]
barrel.append(prism("bknuckle", bk, 0.0098, M["Steel"], 0.001, 2))
# The handguard: olive, eight-sided, its edges catching the light; a retaining ring at each end; ribs along its top;
# three heat slots cut into each side.
flat = 0.0335 * math.cos(math.pi / 8)  # its flat faces' distance from the axis
hg_cuts = [dark(box(s * flat - 0.004 if s > 0 else -flat - 0.01, s * flat + 0.01 if s > 0 else -flat + 0.004, y, y + 0.032, B - 0.0048, B + 0.0048))
           for s in (-1, 1) for y in (0.151, 0.201, 0.251)]
barrel.append(K.bevel(K.cut(lathe("hguard", [(0.127, 0), (0.127, 0.0300), (0.131, 0.0335), (0.311, 0.0335), (0.315, 0.0300), (0.315, 0)], M["Olive"], 8,
                                  AX, turn=math.pi / 8, smooth_angle=20), hg_cuts), 0.0009, 1, 30))
for y0, y1 in ((0.120, 0.128), (0.314, 0.322)):
    barrel.append(lathe("hgring", [(y0, R - 0.001), (y0, 0.0318), (y0 + 0.001, 0.0328), (y1 - 0.001, 0.0328), (y1, 0.0318), (y1, R - 0.001)], M["Dark"], 32, AX))
for y in (0.142, 0.162, 0.182, 0.202, 0.222, 0.242, 0.262, 0.282):
    barrel.append(block("rib", -0.0105, 0.0105, y, y + 0.008, B + flat - 0.0005, B + flat + 0.0028, M["Olive"], 0.0008, 1))
# The fore grip below it, a groove for each finger, a flared foot; its mount and the screw through it.
y0, y1 = 0.31 + DY, 0.35 + DY
front = [(y1, 0.036)]
for z in (0.024, 0.004, -0.016, -0.034):
    front += [(y1 - 0.0025, z + 0.004), (y1 - 0.0028, z - 0.003), (y1 + 0.0004, z - 0.0085)]
front += [(y1 + 0.003, -0.058), (y1 + 0.004, -0.066), (y1 - 0.002, -0.07)]
barrel.append(prism("fgrip", front + [(y0 - 0.002, -0.07), (y0 - 0.004, -0.066), (y0 + 0.004, -0.058), (y0 + 0.002, 0.0), (y0, 0.036)], 0.014,
                    M["Polymer"], 0.0032, 2))
barrel.append(block("fmount", -0.015, 0.015, 0.30 + DY, 0.36 + DY, B - 0.04, B - 0.03, M["Dark"], 0.0018, 2))
for s in (-1, 1):
    barrel.append(screw(s * 0.015, 0.33 + DY, B - 0.035, s, 0.0024))
# The front sight on the muzzle ring: a blade with a bead on its top, between two guard ears.
barrel.append(block("fbase", -0.0065, 0.0065, 0.374, 0.39, B + 0.029, B + 0.0345, M["Steel"], 0.0009, 1))
barrel.append(prism("fpost", [(0.379, B + 0.032), (0.385, B + 0.032), (0.384, B + 0.0455), (0.380, B + 0.0455)], 0.0012, M["Dark"], 0.0003, 1))
barrel.append(lathe("bead", [(B + 0.0448, 0.0), (B + 0.0452, 0.0016), (B + 0.047, 0.0019), (B + 0.0488, 0.0016), (B + 0.0492, 0.0)], M["Brass"], 12,
                    (0, 0.382, 0), "z"))
for s in (-1, 1):
    barrel.append(prism("ear", [(0.375, B + 0.032), (0.389, B + 0.032), (0.386, B + 0.05), (0.378, B + 0.05)], 0.001, M["Steel"], 0.0003, 1, x=s * 0.0055))
# The leaf sight, folded up: a hinged base on the barrel, the ladder's two rails and its rungs, range marks up the
# back of both rails, and the slider with its aperture on the line of sight and a knurled lock on its right.
barrel.append(block("lbase", -0.0098, 0.0098, 0.086, 0.111, B + 0.0255, B + 0.031, M["Dark"], 0.0008, 1))
barrel.append(block("lspring", -0.0045, 0.0045, 0.101, 0.110, B + 0.030, B + 0.0335, M["Steel"], 0.0005, 1))
for s in (-1, 1):
    barrel.append(ring("lknuckle", *((0.0062, 0.0098) if s > 0 else (-0.0098, -0.0062)), 0.0032, M["Dark"], (0, SY, B + 0.0325), 12, "x", 0.0004))
barrel.append(ring("lhinge", -0.0104, 0.0104, 0.0016, M["Steel"], (0, SY, B + 0.0325), 10, "x", 0.0003))
for s in (-1, 1):
    barrel.append(block("rail", s * 0.0078 - 0.0013, s * 0.0078 + 0.0013, SY - 0.0018, SY + 0.0018, B + 0.031, B + 0.0705, M["Dark"], 0.0003, 1))
for z in (B + 0.034, B + 0.0685):
    barrel.append(block("rung", -0.009, 0.009, SY - 0.0016, SY + 0.0016, z - 0.0018, z + 0.0018, M["Dark"], 0.0003, 1))
for s in (-1, 1):
    for k in range(9):
        z = B + 0.0375 + k * 0.0034
        long_ = k % 2 == 0
        x0, x1 = (0.0066, 0.0084 if not long_ else 0.0091) if s > 0 else (-0.0091 if long_ else -0.0084, -0.0066)
        barrel.append(block("mark", x0, x1, SY - 0.0022, SY - 0.0018, z - 0.00035, z + 0.00035, M["Dot"], 0.0, 1))
barrel.append(lathe("aperture", [(SY - 0.0024, 0.0038), (SY + 0.0024, 0.0038), (SY + 0.0024, 0.0064), (SY - 0.0024, 0.0064)], M["Dark"], 20, (0, 0, SZ),
                    loop=True, smooth_angle=30))
for s in (-1, 1):
    barrel.append(block("slider", min(s * 0.0060, s * 0.0099), max(s * 0.0060, s * 0.0099), SY - 0.0030, SY + 0.0030, SZ - 0.0042, SZ + 0.0042, M["Dark"],
                        0.0005, 1))
barrel.append(knurl("lock", 0.0099, 0.0130, 0.0034, 0.0004, 8, M["Steel"], (0, SY, SZ), "x"))

# ---- The round (it moves: gone with the shot, the hand brings a new one) ---------------------
RB = 0.0188  # its body's radius
round_ = [lathe("rim", [(0.0598, 0.0), (0.0598, 0.0201), (0.0602, 0.0205), (0.0628, 0.0205), (0.0632, 0.0201), (0.0636, 0.0186), (0.0636, 0.0)],
                M["Steel"], 28, AX),
          lathe("case", [(0.0636, 0.0), (0.0636, 0.0186), (0.066, RB), (0.0985, RB), (0.0990, RB - 0.0007), (0.1000, RB - 0.0007), (0.1005, RB), (0.1035, RB),
                         (0.1035, 0.0)], M["Steel"], 28, AX),
          lathe("rband", [(0.1035, 0), (0.1035, 0.0194), (0.1095, 0.0194), (0.1095, 0)], M["Brass"], 28, AX)]
ogive = [(0.1095 + 0.034 * math.sin(math.radians(a)), 0.0066 + (RB - 0.0066) * math.cos(math.radians(a))) for a in range(0, 91, 10)]
round_.append(lathe("head", [(0.1095, 0)] + ogive + [(0.1435, 0)], M["Warhead"], 28, AX, smooth_angle=50))
round_.append(lathe("hband", [(0.1135, RB - 0.0002), (0.1135, RB + 0.0002), (0.1165, RB + 0.0001), (0.1165, RB - 0.0004)], M["Brass"], 28, AX, loop=True))
round_.append(lathe("nose", [(0.1430, 0), (0.1430, 0.0068), (0.1470, 0.0060), (0.1495, 0.0038), (0.1505, 0.0)], M["Steel"], 16, AX, smooth_angle=60))
round_.append(lathe("primer", [(0.0592, 0), (0.0592, 0.0042), (0.0598, 0.0046), (0.0598, 0)], M["Brass"], 12, AX))

# ---- Paintball's kit: an air tank strapped to the stock's left, three paint balloons in a tray on its right.
ty0, ty1, tr, tx, tz = -0.255, -0.115, 0.0145, -0.037, -0.018
kit = [lathe("tank", [(ty0, 0), (ty0 + tr * 0.3, tr * 0.7), (ty0 + tr * 0.9, tr), (ty1 - tr * 0.9, tr), (ty1 - tr * 0.3, tr * 0.7), (ty1, 0)], M["Tank"], 14,
             (tx, 0, tz), smooth_angle=60),
       lathe("reg", [(ty1 - tr * 1.6, 0), (ty1 - tr * 1.6, tr * 1.08), (ty1 - tr * 0.6, tr * 1.08), (ty1 - tr * 0.6, 0)], M["KitTrim"], 14, (tx, 0, tz))]
for y in (-0.225, -0.165):
    kit.append(block("strap", tx, -0.015, y, y + 0.012, tz - 0.009, tz + 0.009, M["KitTrim"], 0.001, 1))
kit.append(block("tray", 0.0185, 0.0235, -0.235, -0.105, B - 0.05, B - 0.012, M["KitTrim"], 0.002, 1))
for y in (-0.21, -0.17, -0.13):
    kit.append(lathe("balloon", [(-0.019, 0.0), (-0.016, 0.009), (-0.006, 0.0165), (0.006, 0.0165), (0.015, 0.011), (0.02, 0.0)], M["Hopper"], 12,
                     (0.04, y, B - 0.031), "z", smooth_angle=60))

# ---- The hands: tools/weapons.py's, fitted as there.
H = K.weapons_hands()
gw = H["Wrap"]((0, -0.015, -0.002), (0, -0.018, -0.1), (0, 1, 0), 0.021, 0.0148)
right = H["hand"]("launcher_handR", gw,
                  [(0.032, 70, -1, 0.09, 0.0098, 0.0), (0.052, 72, -1, 0.086, 0.0094, 0.0), (0.071, 76, -1, 0.07, 0.0086, 0.0)],
                  [], (0.012, -0.085, -0.03), (0.25, -0.82, -0.5),
                  ([(-0.006, -0.04, 0.004), (-0.02, -0.022, 0.01), (-0.024, 0.0, 0.016), (-0.023, 0.02, 0.02), (-0.021, 0.036, 0.022)], 0.0105),
                  ([gw.at(0.01, 72, 0.01), (0.02, 0.012, -0.006), (0.016, 0.026, -0.008), (0.009, 0.029, -0.01), (0.004, 0.027, -0.012)], 0.0095))
fw = H["Wrap"]((0, 0.332 + DY, 0.075 - 0.045), (0, -0.01, -1), (0, 1, 0), 0.016, 0.0145)
left = H["hand"]("launcher_handL", fw,
                 [(0.012, -60, 1, 0.07, 0.0098, 0.0), (0.032, -60, 1, 0.07, 0.0096, 0.0), (0.052, -62, 1, 0.066, 0.009, 0.0), (0.07, -64, 1, 0.055, 0.0084, 0.0)],
                 [], (-0.03, 0.285 + DY, -0.035), (-0.35, -0.6, -0.72),
                 ([fw.at(0.0, -160, 0.01), fw.at(-0.004, -185, 0.011), fw.at(-0.007, -215, 0.011), fw.at(-0.009, -240, 0.011)], 0.0108),
                 side=-1)

ROOT = K.finish(W, GRIP, body, {"barrel": (barrel, (0, HY, HZ)), "round": (round_, (0, 0.114, B))}, (0, 0.393, B), (0, SY, SZ), kit, [right, left])
__import__("farcopy").far(ROOT)  # the light copy the others' figures and the pickups use (tools/guns/farcopy.py)
K.export(OUT, ROOT, H)

if PREVIEW:
    C = Vector((0, 0.06, 0.03))
    views = [("left", C + Vector((-1.3, 0, 0.05)), C, 50), ("right", C + Vector((1.3, 0, 0.05)), C, 50),
             ("top", C + Vector((0, 0.001, 1.4)), C, 50), ("front34", C + Vector((-0.7, 0.9, 0.35)), C, 50),
             ("rear34", C + Vector((-0.75, -0.85, 0.45)), C, 50),
             ("breech", Vector((-0.20, -0.12, 0.20)), Vector((0, 0.06, 0.07)), 50),
             ("muzzle", Vector((-0.12, 0.72, 0.16)), Vector((0, 0.42, 0.07)), 50),
             ("sight", Vector((-0.06, 0.02, 0.17)), Vector((0, 0.13, 0.115)), 60),
             ("grip", Vector((-0.40, 0.0, -0.02)), Vector((0, -0.02, 0.0)), 50)]
    hands = [h for e in ROOT.children if e.name.endswith("_hands") for h in e.children]
    K.previews(PREVIEW, W, ROOT, hands, C, views, (0.054, -0.05, -0.095), ((0, -0.4, SZ), 57.6))
    # The barrel broken open and the round half in, from the left and behind: the reload as the player sees it.
    import bpy
    bar = next(o for o in ROOT.children if o.name == "launcher_barrel")
    rnd = next(o for o in ROOT.children if o.name == "launcher_round")
    for h in hands:
        h.hide_render = True
    piv = bar.location.copy()
    bar.rotation_euler = (-0.85, 0, 0)
    rp = rnd.location.copy()
    off = Matrix.Rotation(-0.85, 4, "X") @ (rp - piv) + piv
    rnd.location = off
    rnd.rotation_euler = (-0.85, 0, 0)
    rnd.location += Matrix.Rotation(-0.85, 3, "X") @ Vector((0, -0.06, 0))
    for label, at, target in (("open", Vector((-0.42, -0.25, 0.22)), Vector((0, 0.10, 0.02))), ("openback", Vector((-0.12, -0.32, 0.20)), Vector((0, 0.09, 0.03)))):
        cam = bpy.context.scene.camera
        cam.location = at
        cam.data.sensor_fit = "AUTO"
        cam.data.lens = 50
        cam.rotation_euler = (target - at).to_track_quat("-Z", "Y").to_euler()
        bpy.context.scene.render.filepath = os.path.join(PREVIEW, f"launcher_final_{label}.png")
        bpy.ops.render.render(write_still=True)
