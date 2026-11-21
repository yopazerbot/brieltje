"""Build the tube launcher (the game's `bazooka`) in Blender, with the gloved hands that hold it in first person.

Run (Blender 5, no window):
  blender -b -P tools/guns/bazooka.py -- <out.glb> [preview_dir]
It writes the GLB (web/public/models/gun-bazooka.glb in the repository); the game takes the tube launcher from it in
place of the one in weapons.glb (weapon.ts GUN_FILES), which stays there as the fallback. With preview_dir it also
renders small pictures there: each view in clay and in the materials, the player's views with the hands, each hand.

Our own design, no maker, mark or text on it: a reusable shoulder-fired launcher of the 84 mm class, 1.33 m from the
venturi's lip to the muzzle, a 89 mm tube. It reads from back to front: the venturi (a flared steel cone with cooling
ribs, its throat seen from behind, a bright lip worn by use) held by a locking collar with its hinge on the right and its
lever on the left; a rubber face pad on the tube's left, where the cheek lies; a shoulder rest under the tube (a moulded
frame, a rubber pad hollowed for the shoulder, grooved along its sides) on a clamp band; the firing mechanism's housing
under the tube on two clamp bands, with a let-in side plate and its screws, the safety lever above the grip and the
cocking lever ahead of it (both on the left, under the right thumb), the grip with grooved rubber panels, its guard and
trigger; the optical sight on the left, clamped to a saddle by a knurled screw: a chamfered housing, an objective bell
with its lens set deep, a range drum on top with its marks, an elevation knob, a diopter ring and a rubber eye cup; a
carrying handle on the upper right with a rubber sleeve; raised reinforcing bands in the tube's paint; the front grip on
its clamp band, grooved for the fingers with a flared foot; a folded front iron sight on the left; sling swivels at the
front band and at the rest's band; at the muzzle a steel guard ring and a rubber bumper. In the muzzle the rocket: a
fuze with its cap, an olive head with a brass band, a steel obturating band, the motor body, and behind it a boom with
six fins folded round it and the nozzle (seen as the reload slides it in).
Olive paint (the game's finish wears it to bare metal on the edges and the bands' chamfers), black rubber, dark steel.

Frame and nodes as tools/weapons.py's header says for the bazooka: the barrel along -z, up +y, right +x, metres, the
origin where the web of the right hand sits on the grip;
  bazooka             the weapon (an empty)
    bazooka_body      the parts that never move
    bazooka_rocket    the rocket, its origin at its back end (the reload slides it in from the front)
    bazooka_muzzle    the muzzle's face, on the tube's axis
    bazooka_sight     a point on the optic's axis (its objective lens); the game aims the tube along its top (weapon.ts)
    bazooka_kit       Paintball's hopper, on the tube's top
    bazooka_hands     bazooka_handR, bazooka_handL: tools/weapons.py's hands, fitted as there (the grip and the front
                      grip are where they were)
Helpers, the hands, the bake and the packing: tools/guns/heavykit.py.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import heavykit as K  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

K.reset()
K.M.update(K.materials())
M = K.M
from heavykit import (band, block, box, chamfers, dark, knurl, lathe, prism, ring, rbox, screw, shell, sweep,  # noqa: E402
                      trigger_guard, yprism)

W = "bazooka"
T = 0.075   # the tube's axis over the grip
R = 0.0445  # the tube's outside
RI = 0.0405  # its bore
AX = (0, 0, T)
GRIP = (0, -0.032, 0.0)
body = []


def on_tube(ang, r=R):
    """(x, z) of a point on a circle of radius r round the tube's axis, `ang` degrees from the right, 90 up."""
    return r * math.cos(math.radians(ang)), T + r * math.sin(math.radians(ang))


def groove_ring(y, w, r_in, r_out=0.09):
    """A cutter: a ring round the tube's axis `w` long from y, from r_in out (a groove across a part laid on the tube)."""
    return dark(lathe("cut", [(y, r_in), (y + w, r_in), (y + w, r_out), (y, r_out)], M["Dark"], 40, AX, loop=True))


def grooved_panel(name, pts, half, z_from, z_to, step, deep=0.0009):
    """A rubber panel laid over a grip on both sides (`half` its half width), horizontal grooves cut into both faces."""
    cuts = []
    z = z_from
    while z > z_to:
        for s in (-1, 1):
            x0, x1 = (half - deep, half + 0.01) if s > 0 else (-half - 0.01, -half + deep)
            cuts.append(dark(box(x0, x1, -1, 1, z - 0.0011, z)))
        z -= step
    return prism(name, pts, half, M["Grip"], 0.0007, 1, cuts=cuts)


# ---- The tube -------------------------------------------------------------------------------
# Painted olive outside, dark in its bore. Raised bands in the same paint stiffen it; their chamfered edges are where
# the paint wears to metal first.
body.append(lathe("tube", [(-0.425, RI), (-0.425, R), (0.700, R), (0.700, RI)], [M["Olive"], M["Dark"]], 40, AX, seg_mat=[0, 0, 0, 1], loop=True))
for y in (-0.378, 0.496):
    body.append(band("rband", y, y + 0.024, R - 0.001, R + 0.0024, M["Olive"], AX, 32, 0.0011))

# ---- The venturi at the back: a locking collar, then the flared cone with cooling ribs and a bright lip; inside, the
# cone narrows to its throat and opens again into the tube.
cone = lambda y: 0.0618 + (0.048 - 0.0618) * (y + 0.540) / 0.085  # the cone's outside at y
VEN = [(-0.566, 0.0575), (-0.566, 0.0648), (-0.5635, 0.0668), (-0.5525, 0.0668), (-0.5490, 0.0632), (-0.540, cone(-0.540)), (-0.455, cone(-0.455)),
       (-0.446, 0.0480), (-0.446, RI), (-0.458, 0.0335), (-0.476, 0.0262), (-0.490, 0.0262), (-0.560, 0.0532)]
body.append(lathe("venturi", VEN, [M["Dark"], M["Steel"]], 32, AX, seg_mat=[1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0], loop=True))
for y in (-0.518, -0.492):
    r = cone(y + 0.002)
    body.append(lathe("rib", [(y, r - 0.002), (y, r + 0.0018), (y + 0.0035, r + 0.0018), (y + 0.0035, r - 0.002)], M["Dark"], 32, AX))
body.append(band("vcollar", -0.450, -0.404, R - 0.002, 0.0508, M["Dark"], AX, 32, 0.0012))
body.append(band("vcollarlip", -0.4115, -0.4075, 0.050, 0.0518, M["Steel"], AX, 32, 0.0006))
# The collar's hinge on the right (two knuckles and a pin along the tube) and its locking lever on the left.
hx, hz = on_tube(-10, 0.0535)
for y0, y1 in ((-0.449, -0.437), (-0.418, -0.406)):
    body.append(ring("knuckle", y0, y1, 0.0048, M["Dark"], (hx, 0, hz), 14, chamfer=0.0006))
body.append(ring("hingepin", -0.452, -0.403, 0.0022, M["Steel"], (hx, 0, hz), 10, chamfer=0.0004))
body.append(block("hingeweb", hx - 0.006, hx - 0.001, -0.437, -0.418, hz - 0.003, hz + 0.003, M["Dark"], 0.0006))
lx, lz = on_tube(172, 0.0525)
body.append(ring("latchboss", -0.0020, 0.0015, 0.0055, M["Dark"], (lx - 0.001, -0.428, lz), 16, "x", 0.0006))
body.append(sweep("latch", [(lx - 0.003, -0.428, lz), (lx - 0.0045, -0.410, lz - 0.003), (lx - 0.0055, -0.388, lz - 0.007), (lx - 0.0058, -0.376, lz - 0.008)],
                  [0.0030, 0.0027, 0.0025, 0.0025], M["Steel"], 10))
body.append(knurl("latchknob", -0.380, -0.368, 0.0042, 0.0005, 10, M["Dark"], (lx - 0.0058, 0, lz - 0.008)))

# ---- The face pad on the tube's left, where the cheek lies: rubber, grooved across.
body.append(shell("facepad", -0.232, -0.104, R - 0.001, R + 0.0068, 146, 206, M["Grip"], AX, 8, 0.0018,
                  cuts=[groove_ring(y, 0.0018, R + 0.0046) for y in (-0.204, -0.182, -0.160, -0.138)]))

# ---- The shoulder rest under the tube: a moulded frame on a clamp band and on the housing, a rubber pad hollowed
# across for the shoulder, two grooves along each side.
body.append(band("restband", -0.262, -0.244, R - 0.002, 0.0478, M["Dark"], AX, 24, 0.0008))
body.append(prism("restframe", [(-0.268, 0.040), (-0.056, 0.040), (-0.056, 0.030), (-0.074, 0.021), (-0.252, 0.017), (-0.268, 0.024)], 0.0195,
                  M["Polymer"], 0.002, 2))
pad_cuts = [dark(lathe("hollow", [(-0.32, 0), (-0.32, 0.0305), (-0.02, 0.0305), (-0.02, 0)], M["Dark"], 32, (0, 0, -0.0300)))]
for s in (-1, 1):
    for z in (0.0035, 0.0105):
        pad_cuts.append(dark(box(s * 0.0272 - 0.0012, s * 0.0272 + 0.0012, -0.27, -0.08, z, z + 0.0016)))
body.append(prism("restpad", [(-0.284, 0.019), (-0.076, 0.019), (-0.068, 0.012), (-0.071, 0.002), (-0.090, -0.006), (-0.262, -0.006), (-0.280, 0.000),
                              (-0.288, 0.010)], 0.0272, M["Grip"], 0.0028, 2, cuts=pad_cuts))
for s in (-1, 1):
    body.append(screw(s * 0.0195, -0.235, 0.030, s, 0.0024))
    body.append(screw(s * 0.0195, -0.090, 0.030, s, 0.0024))

# ---- The firing mechanism: a housing under the tube on two clamp bands, a side plate let into each side.
for y in (-0.064, 0.084):
    body.append(band("hband", y, y + 0.014, R - 0.002, 0.0478, M["Dark"], AX, 24, 0.0008))
    body.append(block("hbandbolt", 0.020, 0.030, y + 0.002, y + 0.012, T - 0.046, T - 0.034, M["Dark"], 0.0012))
    body.append(screw(0.030, y + 0.007, T - 0.040, 1, 0.0028))
HW = 0.0175
house_cuts = chamfers(HW, 0.042, -0.004, 0.0, 0.0032, -0.1, 0.1)
for s in (-1, 1):
    house_cuts.append(dark(prism("plate", [(-0.042, 0.004), (0.062, 0.004), (0.062, 0.032), (-0.042, 0.032)], 0.0008, M["Dark"], 0, x=s * HW)))
body.append(prism("housing", [(-0.058, 0.042), (0.094, 0.042), (0.094, 0.027), (0.082, 0.010), (0.072, -0.004), (-0.040, -0.004), (-0.058, 0.012)], HW,
                  M["Dark"], 0.0016, 2, cuts=house_cuts))
for s in (-1, 1):
    for y, z in ((-0.037, 0.008), (0.057, 0.008), (-0.037, 0.028), (0.057, 0.028)):
        body.append(screw(s * HW, y, z, s, 0.0019))
# The grip: moulded, rubber panels grooved across; the guard round the trigger.
GRIP_PTS = [(0.005, 0.0), (-0.003, -0.04), (-0.012, -0.095), (-0.05, -0.098), (-0.045, -0.06), (-0.036, -0.02), (-0.035, 0.0)]
body.append(prism("grip", GRIP_PTS, 0.0145, M["Polymer"], 0.003, 2))
body.append(grooved_panel("gpanel", [(-0.005, -0.024), (-0.013, -0.086), (-0.046, -0.089), (-0.040, -0.024)], 0.0152, -0.031, -0.084, 0.0088))
body.append(prism("gcap", [(-0.011, -0.093), (-0.051, -0.096), (-0.052, -0.103), (-0.012, -0.100)], 0.0148, M["Dark"], 0.0015, 2))
body.append(trigger_guard("guard", 0.005, 0.055, 0.0, -0.03, 0.0062, mat=M["Steel"]))
body.append(prism("trigger", [(0.026, -0.001), (0.029, -0.010), (0.026, -0.020), (0.022, -0.020), (0.025, -0.010), (0.022, -0.001)], 0.003, M["Steel"], 0.0005, 1))
# The safety, above the grip on the left under the thumb: a lever on a round boss, a white dot for "safe".
body.append(ring("safeboss", -0.0012, 0.0, 0.0056, M["Dark"], (-HW, -0.016, 0.024), 16, "x", 0.0004))
body.append(prism("safety", [(-0.013, 0.027), (-0.036, 0.017), (-0.037, 0.0115), (-0.033, 0.0105), (-0.012, 0.020)], 0.0009, M["Steel"], 0.0004, 1,
                  x=-HW - 0.0019))
body.append(ring("safedot", -0.0003, 0.0, 0.0013, M["Dot"], (-HW, -0.006, 0.033), 10, "x", 0.0))
# The cocking lever ahead of it: pivoted high at the front, its arm swept back to a knurled knob.
body.append(ring("cockboss", -0.0016, 0.0, 0.0062, M["Dark"], (-HW, 0.074, 0.024), 16, "x", 0.0005))
body.append(sweep("cocklever", [(-HW - 0.0022, 0.074, 0.024), (-HW - 0.0030, 0.064, 0.020), (-HW - 0.0038, 0.052, 0.014), (-HW - 0.0042, 0.046, 0.011)],
                  [0.0028, 0.0026, 0.0024, 0.0024], M["Steel"], 10))
body.append(knurl("cockknob", -HW - 0.0105, -HW - 0.0030, 0.0046, 0.0005, 10, M["Dark"], (0, 0.045, 0.0105), "x"))

# ---- The optic on the left: a saddle clamped to the tube, a bracket with a dovetail and a knurled clamp screw; the
# housing, chamfered, the objective bell with its lens set deep, the range drum on top with its marks, an elevation
# knob on the left, a diopter ring and a rubber eye cup at the back with the eyepiece's lens inside.
OX, OZ = -0.083, T + 0.028
OA = (OX, 0, OZ)
body.append(shell("saddle", -0.036, 0.046, R - 0.001, R + 0.0042, 128, 206, M["Dark"], AX, 6, 0.0009))
body.append(block("bracket", -0.067, -0.046, -0.028, 0.038, OZ - 0.042, OZ - 0.022, M["Dark"], 0.0012, 2))
body.append(prism("dovetail", [(-0.032, OZ - 0.0275), (0.042, OZ - 0.0275), (0.042, OZ - 0.0215), (-0.032, OZ - 0.0215)], lambda y: 0.016, M["Dark"], 0.0008, 1,
                  x=OX + 0.004))
body.append(knurl("clamp", -0.0045, 0.0045, 0.0062, 0.0006, 12, M["Steel"], (OX - 0.0165, 0.004, OZ - 0.0245), "x"))
body.append(ring("clampcap", -0.0058, -0.0045, 0.0044, M["Dark"], (OX - 0.0165, 0.004, OZ - 0.0245), 12, "x", 0.0004))
HX, HZ, C = 0.0160, 0.0205, 0.0052
oct_ = [(OX - HX + C, OZ - HZ), (OX + HX - C, OZ - HZ), (OX + HX, OZ - HZ + C), (OX + HX, OZ + HZ - C), (OX + HX - C, OZ + HZ), (OX - HX + C, OZ + HZ),
        (OX - HX, OZ + HZ - C), (OX - HX, OZ - HZ + C)]
seams = []  # where the housing's end caps meet its body: a seam 0.8 mm deep round its four flats
for y in (-0.074, 0.032):
    seams += [dark(box(OX - 0.03, OX + 0.03, y, y + 0.0011, OZ + HZ - 0.0008, OZ + 0.03)), dark(box(OX - 0.03, OX + 0.03, y, y + 0.0011, OZ - 0.03, OZ - HZ + 0.0008)),
              dark(box(OX - 0.03, OX - HX + 0.0008, y, y + 0.0011, OZ - 0.03, OZ + 0.03)), dark(box(OX + HX - 0.0008, OX + 0.03, y, y + 0.0011, OZ - 0.03, OZ + 0.03))]
body.append(yprism("ohousing", oct_, -0.092, 0.048, M["Dark"], 0.0014, 1, cuts=seams))
body.append(lathe("objective", [(0.046, 0.0170), (0.052, 0.0188), (0.086, 0.0198), (0.0895, 0.0194), (0.0895, 0.0172), (0.062, 0.0163)],
                  [M["Dark"]], 32, OA, loop=True))
body.append(ring("olens", 0.0605, 0.0625, 0.0164, M["Glass"], OA, 32, chamfer=0.0))
body.append(ring("eyepiece", -0.110, -0.090, 0.0152, M["Dark"], OA, 28, chamfer=0.0006))
body.append(knurl("diopter", -0.104, -0.095, 0.0168, 0.0005, 16, M["Dark"], OA))
body.append(lathe("eyecup", [(-0.137, 0.0172), (-0.137, 0.0204), (-0.1335, 0.0214), (-0.1285, 0.0208), (-0.118, 0.0180), (-0.105, 0.0168),
                             (-0.105, 0.0151), (-0.122, 0.0155), (-0.131, 0.0164)], M["Grip"], 28, OA, loop=True, smooth_angle=50))
body.append(ring("ocular", -0.1125, -0.1105, 0.0150, M["Glass"], OA, 32, chamfer=0.0))
body.append(knurl("rangedrum", OZ + HZ - 0.0005, OZ + HZ + 0.0105, 0.0108, 0.0006, 18, M["Dark"], (OX, -0.012, 0), "z"))
body.append(ring("drumcap", OZ + HZ + 0.0100, OZ + HZ + 0.0122, 0.0088, M["Steel"], (OX, -0.012, 0), 20, "z", 0.0005))
for k in range(5):  # the range marks round the drum's cap: plain lines
    a = math.radians(-60 + 30 * k)
    mark = block("rmark", -0.0004, 0.0004, 0.0038, 0.0074 if k % 2 else 0.0084, OZ + HZ + 0.0121, OZ + HZ + 0.0126, M["Dot"], 0.0)
    K.turned(mark, a, "Z", (0, 0, 0))
    mark.data.transform(K.Matrix.Translation((OX, -0.012, 0)))
    body.append(mark)
body.append(block("index", OX - 0.0004, OX + 0.0004, 0.0, 0.004, OZ + HZ - 0.0002, OZ + HZ + 0.0004, M["Dot"], 0.0))
body.append(knurl("elevation", OX - HX - 0.0085, OX - HX + 0.0005, 0.0080, 0.0005, 14, M["Dark"], (0, 0.016, OZ + 0.002), "x"))
body.append(ring("elevcap", OX - HX - 0.0098, OX - HX - 0.0085, 0.0062, M["Steel"], (0, 0.016, OZ + 0.002), 16, "x", 0.0004))

# ---- The carrying handle on the upper right: two lugs on clamp bands, a steel bar standing off the tube, a rubber sleeve.
HA = 52  # its angle round the tube
for y in (0.112, 0.252):
    body.append(band("handband", y, y + 0.013, R - 0.002, 0.0476, M["Dark"], AX, 24, 0.0007))
    lug = block("lug", -0.0045, 0.0045, y + 0.0005, y + 0.0125, R + 0.001, R + 0.0115, M["Dark"], 0.0012, 2)
    K.turned(lug, math.radians(90 - HA), "Y", (0, 0, 0))
    lug.data.transform(K.Matrix.Translation((0, 0, T)))
    body.append(lug)
hand_pts = []
for y, r in ((0.1185, 0.0535), (0.126, 0.0600), (0.142, 0.0630), (0.222, 0.0630), (0.238, 0.0600), (0.2455, 0.0535)):
    x, z = on_tube(HA, r)
    hand_pts.append((x, y, z))
body.append(sweep("handle", hand_pts, [0.0034] * len(hand_pts), M["Steel"], 10))
hx, hz = on_tube(HA, 0.0630)
body.append(lathe("sleeve", [(0.148, 0), (0.148, 0.0050), (0.151, 0.0062), (0.213, 0.0062), (0.216, 0.0050), (0.216, 0)], M["Grip"], 12, (hx, 0, hz),
                  smooth_angle=50))

# ---- The front grip on its clamp band: grooved for the fingers in front, a flared foot, rubber panels on its sides.
body.append(band("fband", 0.302, 0.362, R - 0.002, 0.0480, M["Dark"], AX, 24, 0.0012))
body.append(block("fmount", -0.016, 0.016, 0.300, 0.364, T - 0.054, T - 0.040, M["Dark"], 0.0018, 2))
for s in (-1, 1):
    body.append(screw(s * 0.016, 0.332, T - 0.047, s, 0.0026))
front = [(0.351, 0.024)]
for z in (0.010, -0.010, -0.030):  # a finger's groove, then a ridge before the next
    front += [(0.3488, z + 0.006), (0.3484, z - 0.002), (0.3518, z - 0.0085)]
front += [(0.354, -0.055), (0.357, -0.063), (0.354, -0.070), (0.348, -0.072)]
FG = front + [(0.312, -0.072), (0.306, -0.070), (0.304, -0.063), (0.308, -0.055), (0.310, 0.024)]
body.append(prism("fgrip", FG, 0.0140, M["Polymer"], 0.0032, 2))
body.append(prism("fpanel", [(0.313, 0.016), (0.343, 0.016), (0.343, -0.050), (0.313, -0.050)], 0.0146, M["Grip"], 0.0009, 1))  # under the hand

# ---- The front iron sight, folded down on the left, and the sling swivels.
body.append(shell("fsbase", 0.548, 0.580, R - 0.001, R + 0.0050, 136, 196, M["Dark"], AX, 5, 0.0009))
fx, fz = on_tube(164, R + 0.0072)
body.append(ring("fspin", 0.548, 0.580, 0.0021, M["Steel"], (fx, 0, fz), 10, chamfer=0.0004))
body.append(block("fsblade", fx - 0.0012, fx + 0.0012, 0.551, 0.598, fz - 0.0030, fz + 0.0034, M["Dark"], 0.0005, 1))
body.append(block("fspost", fx - 0.0014, fx + 0.0014, 0.590, 0.598, fz - 0.0030, fz + 0.0034, M["Dot"], 0.0003, 1))


def swivel(y, ang):
    x, z = on_tube(ang, R + 0.0030)
    out = [block("swbase", x - 0.0035, x + 0.0035, y - 0.006, y + 0.006, z - 0.0035, z + 0.0035, M["Dark"], 0.0010, 1)]
    cx, cz = on_tube(ang, R + 0.0115)
    rad = math.radians(ang)
    n = (math.cos(rad), math.sin(rad))
    loop = [(cx + n[0] * 0.0060 * math.cos(2 * math.pi * k / 12), y + 0.0075 * math.sin(2 * math.pi * k / 12), cz + n[1] * 0.0060 * math.cos(2 * math.pi * k / 12))
            for k in range(13)]
    out.append(sweep("swivel", loop, [0.0014] * len(loop), M["Steel"], 6))
    return out


body += swivel(0.508, 222)
body += swivel(-0.253, 205)

# ---- The muzzle: a steel guard ring, a rubber bumper with a rolled lip.
body.append(lathe("mguard", [(0.698, RI), (0.698, 0.0480), (0.699, 0.0490), (0.723, 0.0490), (0.724, 0.0480), (0.724, RI)], M["Dark"], 32, AX, loop=True))
body.append(lathe("bumper", [(0.722, RI + 0.0005), (0.722, 0.0498), (0.748, 0.0516), (0.7585, 0.0530), (0.7635, 0.0526), (0.765, 0.0508), (0.765, 0.0442),
                             (0.758, 0.0425), (0.740, RI + 0.0005)], M["Grip"], 32, AX, loop=True, smooth_angle=50))
for k in range(6):  # ribs round the bumper
    a = 2 * math.pi * (k + 0.5) / 6
    rib = block("bumprib", -0.0018, 0.0018, 0.726, 0.752, 0.0505, 0.0532, M["Grip"], 0.0007, 1)
    K.turned(rib, a, "Y", (0, 0, 0))
    rib.data.transform(K.Matrix.Translation((0, 0, T)))
    body.append(rib)

# ---- The rocket (it moves: gone with the shot, slid in from the front by the reload). Its origin at its back end.
rocket = []
rocket.append(lathe("nozzle", [(0.627, 0), (0.627, 0.0070), (0.6205, 0.0112), (0.6205, 0.0148), (0.623, 0.0162), (0.677, 0.0162), (0.677, 0)],
                    M["Dark"], 20, AX))
for k in range(6):  # six fins folded round the boom
    a0 = 60 * k + 6
    rocket.append(shell("fin", 0.626, 0.669, 0.0163, 0.0181, a0, a0 + 48, M["Dark"], AX, 3, 0.0))
rocket.append(lathe("motor", [(0.668, 0), (0.668, 0.0300), (0.676, 0.0362), (0.737, 0.0368), (0.737, 0)], M["Dark"], 24, AX))
rocket.append(ring("obturator", 0.735, 0.745, 0.0399, M["Steel"], AX, 28, chamfer=0.0006))
ogive = []
for i in range(11):
    t = i / 10
    ogive.append((0.744 + 0.084 * t, 0.0145 + (0.0392 - 0.0145) * math.cos(t * math.pi / 2) ** 0.75))
rocket.append(lathe("head", [(0.744, 0)] + ogive + [(0.828, 0)], M["Warhead"], 24, AX, smooth_angle=50))
rocket.append(lathe("hband", [(0.7565, 0.0384), (0.7565, 0.03905), (0.7625, 0.03905), (0.7625, 0.0384)], M["Brass"], 28, AX))
rocket.append(lathe("fuze", [(0.827, 0), (0.827, 0.0147), (0.833, 0.0132), (0.8375, 0.0132), (0.8385, 0.0122), (0.8395, 0.0124), (0.846, 0.0094), (0.846, 0)],
                    M["Steel"], 20, AX))
rocket.append(lathe("fuzecap", [(0.8455, 0), (0.8455, 0.0093), (0.850, 0.0086), (0.854, 0.0062), (0.8565, 0.0028), (0.857, 0)], M["Brass"], 24, AX,
                    smooth_angle=60))

# Paintball's hopper on the tube's top.
kit = K.hopper(0.0, 0.42, T + R, 0.06)

# ---- The hands: tools/weapons.py's, fitted as there (the grip and the front grip are where they were).
H = K.weapons_hands()
gw = H["Wrap"]((0, -0.015, -0.002), (0, -0.018, -0.1), (0, 1, 0), 0.021, 0.0148)
right = H["hand"]("bazooka_handR", gw,
                  [(0.032, 70, -1, 0.09, 0.0098, 0.0), (0.052, 72, -1, 0.086, 0.0094, 0.0), (0.071, 76, -1, 0.07, 0.0086, 0.0)],
                  [], (0.012, -0.085, -0.03), (0.25, -0.82, -0.5),
                  ([(-0.006, -0.04, 0.004), (-0.02, -0.022, 0.01), (-0.024, 0.0, 0.016), (-0.023, 0.02, 0.02), (-0.021, 0.036, 0.022)], 0.0105),
                  ([gw.at(0.01, 72, 0.01), (0.02, 0.012, -0.006), (0.016, 0.026, -0.008), (0.009, 0.029, -0.01), (0.004, 0.027, -0.012)], 0.0095))
fw = H["Wrap"]((0, 0.332, T - 0.045), (0, -0.01, -1), (0, 1, 0), 0.016, 0.0145)
left = H["hand"]("bazooka_handL", fw,
                 [(0.012, -60, 1, 0.07, 0.0098, 0.0), (0.032, -60, 1, 0.07, 0.0096, 0.0), (0.052, -62, 1, 0.066, 0.009, 0.0), (0.07, -64, 1, 0.055, 0.0084, 0.0)],
                 [], (-0.03, 0.285, -0.035), (-0.35, -0.6, -0.72),
                 ([fw.at(0.0, -160, 0.01), fw.at(-0.004, -185, 0.011), fw.at(-0.007, -215, 0.011), fw.at(-0.009, -240, 0.011)], 0.0108),
                 side=-1)

ROOT = K.finish(W, GRIP, body, {"rocket": (rocket, (0, 0.62, T))}, (0, 0.765, T), (OX, 0.0615, OZ), kit, [right, left])
K.export(OUT, ROOT, H)

if PREVIEW:
    from mathutils import Vector
    C = Vector((0, 0.13, 0.07))
    views = [("left", C + Vector((-2.2, 0, 0.05)), C, 50), ("right", C + Vector((2.2, 0, 0.05)), C, 50),
             ("top", C + Vector((0, 0.001, 2.3)), C, 50), ("front34", C + Vector((-1.2, 1.5, 0.5)), C, 50),
             ("rear34", C + Vector((-1.2, -1.55, 0.6)), C, 50),
             ("optic", Vector((-0.30, -0.42, 0.25)), Vector((-0.083, -0.02, 0.10)), 50),
             ("venturi", Vector((-0.28, -0.85, 0.22)), Vector((0, -0.48, 0.075)), 50),
             ("muzzle", Vector((-0.25, 1.15, 0.20)), Vector((0, 0.78, 0.075)), 50),
             ("grip", Vector((-0.45, 0.10, -0.02)), Vector((0, 0.05, 0.02)), 50)]
    hands = [h for e in ROOT.children if e.name.endswith("_hands") for h in e.children]
    K.previews(PREVIEW, W, ROOT, hands, C, views, (0.072, -0.048, -0.1), ((-0.012 / 0.25, -0.1 / 0.25, 0.06 / 0.25), 57.6))
