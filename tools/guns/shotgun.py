"""Build the pump shotgun in Blender, with the gloved hands that hold it in first person and the shell they load.

Run (Blender 5, no window):
  blender -b -P tools/guns/shotgun.py -- <out.glb> [preview_dir]
It writes the GLB (web/public/models/gun-shotgun.glb in the repository); the game takes the shotgun from it instead of
from weapons.glb (weapon.ts GUN_FILES), and weapons.glb keeps its old shotgun as the fallback. With preview_dir it also
renders small pictures there (tools/guns/shop.py previews).

Our own design, no brand, maker or marking on it: a 12-bore pump gun with a 55 cm barrel and a magazine tube under it,
1.14 m long (the old shotgun's length and stock, which the hands and the views are set for), the bore, the barrel, the
receiver and the tube at the real sizes of the class (18.5 mm bore, a 37 mm wide receiver). From the back: a
walnut stock with a shaped comb, a semi-pistol-grip wrist with checkering (its cut grooves a fine dark grid), a dark spacer and
a ribbed rubber butt pad, a sling swivel under the butt. A blued steel receiver with flat sides and a rounded top:
the ejection port on the right with the bolt in it (its groove and extractor), the loading port underneath with the
shell lifter and the loading gate inside, four plugged screw holes on top, the trigger group's two pins. Under it the
trigger plate with the guard, the trigger, the cross-bolt safety behind it and the action release on the left.
Out front the barrel (a thicker ring where it leaves the receiver, a crowned muzzle with a bore you see into) under a
vent rib on posts with a mid bead and a brass front bead; the magazine tube under it to the barrel's lug and the cap,
ringed for the fingers, with the front sling swivel. The walnut fore-end (ringed, as a corncob fore-end is) on its
steel sleeve and its two action bars: it slides back and forth (shotgun_pump), and takes the bolt with it.

Frame and nodes as tools/weapons.py's shotgun, so the page reads it the same: the barrel along -z, up +y, right +x,
metres, the origin where the web of the right hand sits on the grip. shotgun (an empty), shotgun_body, shotgun_pump
(pivot as before), shotgun_muzzle, shotgun_sight (the bead's top), shotgun_kit (Paintball's hopper and air tank, as
before), shotgun_hands with shotgun_handR, shotgun_handL (weapons.py's own poses on the same wrist and fore-end) and
shotgun_shell in the left hand. The materials are weapons.py's names where the role is the same (Wood, Steel, Dark,
Grip for the pad, its spacer and the checkering's grooves, Brass, Warhead for the shell's hull), so the game's finish and the paint look take them; the blued receiver,
barrel and magazine tube have a name of their own, ShotgunBlued (a glossy blue-black; gunSurface.ts and weapon.ts ROLE
have its entries). Inside Blender the barrel runs along +y and up is +z; the exporter turns that into the above.
"""
import math
import os
import sys

import bmesh
import bpy

bpy.ops.wm.read_factory_settings(use_empty=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shop as S  # noqa: E402
from shop import M, apply_mod, bevel, block, box, chamfers, clean, cut, dark, finish, join, lathe, material, mesh_obj, prism, ring, sweep  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

M.update({
    "Blued": material("ShotgunBlued", "#272b32", 0.28, 0.95),  # the receiver, barrel, magazine tube (its own finish in the game)
    "Steel": material("Steel", "#4d5056", 0.3, 1.0),     # the bolt, the action bars, the sleeve, pins, swivels
    "Dark": material("Dark", "#2a2c30", 0.42, 0.7),      # the trigger plate and guard, the safety, the insides of ports
    "Wood": material("Wood", "#43281a", 0.45, 0.0),      # oiled walnut: brown, not orange
    "Grip": material("Grip", "#1d1c1b", 0.9, 0.0),       # the rubber butt pad
    "Brass": material("Brass", "#b08a3e", 0.3, 0.9),      # the front bead, the shell's head
    "Warhead": material("Warhead", "#7c2a20", 0.55, 0.0),  # the shell's hull (Warhead: its old name, the paint look's body)
    "Hopper": material("Hopper", "#2f8cff", 0.15, 0.0),   # Paintball's kit
    "KitTrim": material("KitTrim", "#ffd23f", 0.4, 0.0),
    "Tank": material("Tank", "#dfe3e8", 0.3, 0.5),
    "Glove": material("Glove", "#26272a", 0.82, 0.0),     # the hands, as tools/weapons.py makes them
    "GloveTrim": material("GloveTrim", "#23251f", 0.8, 0.0),
    "Sleeve": material("Sleeve", "#4b4c3b", 0.9, 0.0),
})

B = 0.05        # the bore's axis height
MZ = 0.0195     # the magazine tube's
GRIP = (0, -0.062, 0.03)
MUZZLE = (0, 0.721, B)
SIGHT = (0, 0.70, 0.0695)
PUMP = (0, 0.39, 0.022)
RW = 0.0185     # the receiver's half width
body = []


def section(name, pts, y0, y1, mat):
    """A cross-section [(x, z), ...] pushed along y from y0 to y1, closed at both ends."""
    bm = bmesh.new()
    back = [bm.verts.new((x, y0, z)) for x, z in pts]
    front = [bm.verts.new((x, y1, z)) for x, z in pts]
    bm.faces.new(back)
    bm.faces.new(list(reversed(front)))
    n = len(pts)
    for i in range(n):
        bm.faces.new((back[i], back[(i + 1) % n], front[(i + 1) % n], front[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, [mat])


def arc(cx, cz, r, a0, a1, steps):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / steps)), cz + r * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]


def squash(o, centre, sx=1.0, sy=1.0, sz=1.0):
    c = Vector(centre)
    o.data.transform(Matrix.Translation(c) @ Matrix.Diagonal((sx, sy, sz, 1.0)) @ Matrix.Translation(-c))
    return o


# ---- The receiver -----------------------------------------------------------------------------
# Flat sides, a rounded top (an 8 mm radius into a flat 2 cm wide), its back sloping down into the stock: a section
# pushed along the gun, cut to its side outline. The ejection port on the right, the loading port underneath, four
# plugged screw holes on top, the trigger group's pins on both sides.
TOP, RC = 0.0705, 0.008
rsec = [(-RW, 0.0135), (-RW + 0.0015, 0.012), (RW - 0.0015, 0.012), (RW, 0.0135)] + arc(RW - RC, TOP - RC, RC, 0, 90, 6)[:] + arc(-RW + RC, TOP - RC, RC, 90, 180, 6)
rec = section("receiver", rsec, -0.040, 0.175, M["Blued"])
side = prism("outline", [(-0.041, 0.0), (0.176, 0.0), (0.176, 0.08), (0.004, 0.08), (-0.030, 0.0685), (-0.041, 0.0620)], 0.03, M["Blued"], 0)
apply_mod(rec, "BOOLEAN", operation="INTERSECT", object=side, solver="EXACT")
bpy.data.objects.remove(side, do_unlink=True)
clean(rec)
rec_cuts = [dark(box(0.003, 0.03, 0.060, 0.128, 0.033, 0.0612)),       # the ejection port, deep: you see into it with the bolt back
            dark(box(-0.0122, 0.0122, 0.066, 0.150, 0.004, 0.0185))]   # the loading port underneath
rec_cuts += [dark(box(s * RW - 0.0005, s * RW + 0.0005, -0.036, 0.170, 0.0128, 0.0134)) for s in (-1, 1)]  # the seam over the trigger plate
# A shallow milled panel on each side, its edges catching the light (the flat sides read as one slab without it).
PANEL = [(0.004, 0.0215), (0.163, 0.0215), (0.167, 0.0255), (0.167, 0.0545), (0.163, 0.0585), (0.004, 0.0585), (0.000, 0.0545), (0.000, 0.0255)]
rec_cuts += [prism("panel", PANEL, 0.0005, M["Blued"], 0, x=s * RW) for s in (-1, 1)]
cut(rec, rec_cuts)
body.append(bevel(rec, 0.0012, 2))
for y in (0.016, 0.040, 0.112, 0.136):  # the screw holes for a sight mount, plugged
    body.append(lathe("plug", [(TOP - 0.0006, 0), (TOP - 0.0006, 0.0021), (TOP + 0.0002, 0.0019), (TOP + 0.0004, 0)], M["Steel"], 10, (0, y, 0), "z"))
    body.append(block("plugslot", -0.0016, 0.0016, y - 0.00025, y + 0.00025, TOP + 0.0001, TOP + 0.0006, M["Dark"], 0, 1))
for y in (0.010, 0.052):
    for s in (-1, 1):
        body += S.pin(s * RW, y, 0.0185, s, 0.0022)
# Inside the ports: the shell lifter seen from below (a plate with its slot), the loading gate along the right wall.
body.append(prism("lifter", [(0.068, 0.0150), (0.148, 0.0150), (0.148, 0.0172), (0.068, 0.0172)], 0.0098, M["Steel"], 0.0004, 1,
                  cuts=[dark(box(-0.0035, 0.0035, 0.115, 0.15, 0.0140, 0.0180))]))
body.append(block("gate", 0.0098, 0.0120, 0.080, 0.148, 0.0055, 0.0150, M["Steel"], 0.0004, 1))
body.append(block("portback", 0.002, 0.0035, 0.060, 0.128, 0.033, 0.0612, M["Dark"], 0, 1))

# ---- The trigger group --------------------------------------------------------------------------
body.append(prism("tplate", [(-0.026, 0.0128), (0.064, 0.0128), (0.064, 0.0060), (0.058, 0.0030), (0.000, 0.0030), (-0.018, 0.0060), (-0.026, 0.0090)], 0.0165,
                  M["Dark"], 0.0012, 2))


def trigger_guard(name, y0, y1, ztop, zbot, half, t=0.0042):
    pts = [(y0 - 0.006, ztop - 0.012), (y0, zbot + 0.005), (y0 + 0.007, zbot), (y1 - 0.007, zbot), (y1, zbot + 0.006), (y1, ztop),
           (y1 - t, ztop), (y1 - t, zbot + t + 0.003), (y1 - t - 0.004, zbot + t), (y0 + 0.008, zbot + t), (y0 + t, zbot + t + 0.005), (y0 - 0.006 + t, ztop - 0.012)]
    return prism(name, pts, half, M["Dark"], 0.0009, 2)


body.append(trigger_guard("guard", 0.0, 0.058, 0.0035, -0.022, 0.0062))
body.append(prism("trigger", [(0.0215, 0.0035), (0.0270, 0.0035), (0.0262, -0.0030), (0.0270, -0.0090), (0.0292, -0.0128), (0.0262, -0.0128), (0.0232, -0.0085),
                              (0.0222, -0.0030)], 0.0030, M["Steel"], 0.0005, 1))
# The cross-bolt safety through the plate behind the trigger, 2.5 mm out on each side, a ring cut round it.
body.append(lathe("safety", [(-0.019, 0), (-0.019, 0.0031), (0.019, 0.0031), (0.019, 0)], M["Dark"], 16, (0, 0.006, 0.0075), "x"))
for s in (-1, 1):
    body.append(ring("safetyring", *((0.0164, 0.0168) if s > 0 else (-0.0168, -0.0164)), 0.0041, M["Steel"], (0, 0.006, 0.0075), 16, "x", 0.0001))
# The action release on the left, ahead of the guard: a short lever with a ribbed tip.
body.append(prism("release", [(0.058, 0.0100), (0.066, 0.0100), (0.071, 0.0060), (0.071, 0.0030), (0.066, 0.0030), (0.061, 0.0065), (0.058, 0.0065)], 0.0007,
                  M["Steel"], 0.0003, 1, x=-0.0172))

# ---- The barrel, its rib and the magazine ------------------------------------------------------
BAR = [(0.150, 0), (0.150, 0.0128), (0.212, 0.0128), (0.218, 0.0117), (0.712, 0.0108), (0.7180, 0.0106), (0.7210, 0.0099), (0.7210, 0.0094),
       (0.6400, 0.0093), (0.6400, 0)]
body.append(lathe("barrel", BAR, [M["Blued"], M["Dark"]], 28, (0, 0, B), seg_mat=[0, 0, 0, 0, 0, 0, 0, 1, 1]))
bar_r = lambda y: 0.0117 + (0.0108 - 0.0117) * (y - 0.218) / (0.712 - 0.218)
RIB0, RIB1 = 0.0636, 0.0658  # the rib's underside and top
body.append(prism("rib", [(0.226, RIB0), (0.712, RIB0), (0.714, RIB0 + 0.0011), (0.712, RIB1), (0.232, RIB1), (0.226, RIB0 + 0.0012)], 0.0033, M["Blued"], 0.0005, 1))
y = 0.236
while y < 0.70:
    body.append(block("ribpost", -0.0017, 0.0017, y, y + 0.006, B + bar_r(y) - 0.0012, RIB0 + 0.0002, M["Blued"], 0.0003, 1))
    y += 0.040
body.append(lathe("bead", [(RIB1 - 0.0002, 0), (RIB1 - 0.0002, 0.0016), (RIB1 + 0.0010, 0.0023), (RIB1 + 0.0028, 0.0018), (SIGHT[2], 0)], M["Brass"], 12,
                  (0, 0.706, 0), "z", smooth_angle=80))
body.append(lathe("midbead", [(RIB1 - 0.0002, 0), (RIB1 - 0.0002, 0.0011), (RIB1 + 0.0010, 0.0011), (RIB1 + 0.0016, 0)], M["Steel"], 10, (0, 0.47, 0), "z",
                  smooth_angle=80))
body.append(lathe("magtube", [(0.170, 0), (0.170, 0.0105), (0.652, 0.0105), (0.652, 0)], M["Blued"], 24, (0, 0, MZ)))
# The barrel's lug over the tube's end: a ring round the tube and a web up to the barrel, a screw through the web.
body.append(ring("lug", 0.638, 0.652, 0.0123, M["Blued"], (0, 0, MZ), 24, chamfer=0.0007))
body.append(block("lugweb", -0.0058, 0.0058, 0.638, 0.652, MZ + 0.004, B - 0.006, M["Blued"], 0.0008, 2))
# The cap, ringed for the fingers, and the sling swivel on its face.
cap = [(0.652, 0), (0.652, 0.0122)]
for k in range(4):
    t = 0.6545 + k * 0.0040
    cap += [(t, 0.0124), (t + 0.0022, 0.0124), (t + 0.0024, 0.0117), (t + 0.0033, 0.0117), (t + 0.0035, 0.0124)]
cap += [(0.6715, 0.0124), (0.6740, 0.0112), (0.6750, 0.0060), (0.6750, 0)]
body.append(lathe("cap", cap, M["Blued"], 20, (0, 0, MZ), smooth_angle=40))
body.append(lathe("stud", [(0.6745, 0), (0.6745, 0.0032), (0.6800, 0.0030), (0.6830, 0.0024), (0.6830, 0)], M["Steel"], 12, (0, 0, MZ - 0.003)))
sw = [(0, 0.6815 + 0.0058 * math.sin(2 * math.pi * k / 16), MZ - 0.0085 - 0.0058 * math.cos(2 * math.pi * k / 16)) for k in range(17)]
body.append(sweep("swivel", sw, [0.0012] * len(sw), M["Steel"], 6))

# ---- The stock ---------------------------------------------------------------------------------
# Walnut: rounded sections from the receiver to the butt, narrower at the comb than below. The top line dips at the
# wrist and rises into the comb's nose; the bottom line comes down from the trigger guard into the semi-pistol grip
# and runs on to the toe. Checkering on both sides of the wrist: its cut grooves as a fine dark diamond grid.


def line(pts, y):
    """The height at y on a line of (y, z) points (y falling), smoothed between them."""
    for (y0, z0), (y1, z1) in zip(pts, pts[1:]):
        if y1 <= y <= y0:
            t = (y0 - y) / (y0 - y1)
            t = t * t * (3 - 2 * t)
            return z0 + (z1 - z0) * t
    return pts[-1][1]


# Over the wrist as high as before (the right thumb lies over it), then the comb falls to 1.5 cm and the heel to 3 cm
# under the rib's line.
TOPL = [(-0.040, 0.0620), (-0.070, 0.0602), (-0.100, 0.0580), (-0.135, 0.0560), (-0.260, 0.0465), (-0.395, 0.0370)]
BOTL = [(-0.040, 0.0120), (-0.055, 0.0060), (-0.072, -0.0070), (-0.088, -0.0220), (-0.104, -0.0360), (-0.118, -0.0460), (-0.135, -0.0515),
        (-0.152, -0.0525), (-0.172, -0.0490), (-0.205, -0.0490), (-0.300, -0.0690), (-0.395, -0.0900)]
HALF = [(-0.040, 0.0183), (-0.080, 0.0160), (-0.125, 0.0166), (-0.170, 0.0178), (-0.260, 0.0198), (-0.395, 0.0212)]
TOPW = [(-0.040, 1.0), (-0.100, 0.95), (-0.170, 0.70), (-0.395, 0.74)]
# Sections every centimetre or so up to the comb, then one straight run to the butt. Aimed, the eye is 4 cm behind the
# butt (weapon.ts: the shotgun's aim 0.38 m behind the grip): the game keeps what lies closer than the camera's near
# edge, down to a last few centimetres it cuts (gunSurface.ts NEAR_KEPT). The straight run's points are all either
# past the near edge or in those last centimetres, so the stock is cut where the near edge crosses it, and you see its
# comb run out under the receiver as before, not a sheet of wood up into the view.
ys = [-0.040 - 0.222 * i / 20 for i in range(21)] + [-0.395]
POW = [(-0.040, 5.0), (-0.095, 3.6), (-0.160, 2.6), (-0.395, 2.6)]  # square at the receiver's back, rounder from the wrist on
stock = S.loft("stock", [(y, line(BOTL, y), line(TOPL, y), line(HALF, y), line(TOPW, y), line(POW, y)) for y in ys], M["Wood"], 32, 2.6)
CHECK = [(-0.060, 0.042), (-0.084, 0.044), (-0.108, 0.030), (-0.118, -0.006), (-0.110, -0.030), (-0.090, -0.016), (-0.072, 0.004), (-0.058, 0.026)]
for s in (-1, 1):
    body.append(S.grooves("checkering", stock, CHECK, s, M["Grip"], pitch=0.0021, width=0.00055, turns=(-62 + 28, -62 - 28), step=0.0035))
body.append(stock)
# The spacer and the ribbed rubber pad on the butt, its grooves round its sides; the sling swivel under the butt.
end = (line(BOTL, -0.395), line(TOPL, -0.395), line(HALF, -0.395), line(TOPW, -0.395))
body.append(S.loft("spacer", [(-0.3948, end[0] - 0.0003, end[1] + 0.0003, end[2] + 0.0003, end[3]), (-0.3985, end[0] - 0.0006, end[1] + 0.0006, end[2] + 0.0005, end[3])],
                   M["Grip"], 32, 2.6))  # (in Grip, not a material more: the others' copies stay at four draws)
pad = S.loft("pad", [(-0.3980, end[0] - 0.0006, end[1] + 0.0006, end[2] + 0.0005, end[3]), (-0.4150, end[0] - 0.0016, end[1] + 0.0016, end[2] + 0.0012, end[3]),
                     (-0.4205, end[0] - 0.0005, end[1] + 0.0005, end[2] + 0.0002, end[3]), (-0.4225, end[0] + 0.004, end[1] - 0.004, end[2] - 0.004, end[3])],
             M["Grip"], 32, 2.6)
pad_cuts = []
for k in range(9):
    z = end[0] + 0.012 + k * 0.0135
    for s in (-1, 1):
        x0 = s * (end[2] + 0.0012 - 0.0011)
        pad_cuts.append(dark(box(min(x0, s * 0.05), max(x0, s * 0.05), -0.4185, -0.4005, z, z + 0.0022)))
body.append(S.shade(cut(pad, pad_cuts)))
zb = line(BOTL, -0.330)
body.append(lathe("buttstud", [(zb - 0.0055, 0), (zb - 0.0055, 0.0026), (zb - 0.004, 0.0032), (zb + 0.003, 0.0034), (zb + 0.003, 0)], M["Steel"], 12,
                  (0, -0.330, 0), "z"))
bs = [(0, -0.330 + 0.0062 * math.sin(2 * math.pi * k / 16), zb - 0.0105 - 0.0062 * math.cos(2 * math.pi * k / 16)) for k in range(17)]
body.append(sweep("buttswivel", bs, [0.0013] * len(bs), M["Steel"], 6))

# ---- The pump (it slides): the fore-end on its sleeve, the action bars, the bolt -----------------
prof = [(0.296, 0.0122), (0.300, 0.0200), (0.304, 0.0226), (0.312, 0.0232)]
y = 0.318
while y < 0.462:
    prof += [(y, 0.0230), (y + 0.0115, 0.0230), (y + 0.0135, 0.0210), (y + 0.0185, 0.0210), (y + 0.0205, 0.0230)]
    y += 0.024
prof += [(0.468, 0.0232), (0.476, 0.0226), (0.480, 0.0200), (0.484, 0.0122)]
fore = lathe("fore", prof, M["Wood"], 28, (0, 0, PUMP[2]), loop=True, smooth_angle=50)  # the inside back along the sleeve
pump = [squash(fore, PUMP, sx=0.95, sz=0.92)]
for t0, t1 in ((0.290, 0.297), (0.483, 0.490)):
    pump.append(ring("sleeve", t0, t1, 0.0119, M["Steel"], (0, 0, MZ), 24, chamfer=0.0006))
pump.append(lathe("sleevetube", [(0.170, 0.0109), (0.490, 0.0109), (0.490, 0.0106), (0.170, 0.0106)], M["Steel"], 24, (0, 0, MZ), loop=True))
for s in (-1, 1):
    pump.append(block("actionbar", *sorted((s * 0.0107, s * 0.0124)), 0.130, 0.298, MZ - 0.0028, MZ + 0.0028, M["Steel"], 0.0003, 1))
bolt_cuts = [dark(box(0.0125, 0.02, 0.072, 0.118, 0.0455, 0.0485))]
pump.append(block("bolt", 0.0025, 0.0148, 0.0605, 0.1275, 0.0335, 0.0608, M["Steel"], 0.0006, 2))
pump[-1] = cut(pump[-1], bolt_cuts)
pump.append(block("extractor", 0.0128, 0.0152, 0.1215, 0.1275, 0.0490, 0.0560, M["Dark"], 0.0003, 1))

# ---- The shell the left hand loads -------------------------------------------------------------
shell = [lathe("hull", [(-0.0002, 0), (-0.0002, 0.0106), (0.0520, 0.0106), (0.0548, 0.0098), (0.0574, 0.0045), (0.0578, 0)], M["Warhead"], 16,
               (0, 0, 0), smooth_angle=50),
         lathe("head", [(-0.0130, 0), (-0.0130, 0.0113), (-0.0118, 0.0113), (-0.0115, 0.0108), (0.0001, 0.0108), (0.0001, 0)], M["Brass"], 16, (0, 0, 0)),
         lathe("primer", [(-0.0133, 0), (-0.0133, 0.0028), (-0.0129, 0.0028), (-0.0129, 0)], M["Steel"], 10, (0, 0, 0))]
for k in range(3):  # three rings pressed into the head
    shell.append(ring("headring", -0.0098 + k * 0.0032, -0.0090 + k * 0.0032, 0.01095, M["Brass"], (0, 0, 0), 16, chamfer=0.0001))


# ---- Paintball's kit: the hopper on the receiver's left and the air tank under the barrel (as weapons.py's) ----
def hopper(x, y, ztop, r, side):
    c = Vector((x, y, ztop - r * 1.15))
    neck = [block("neck", x + r * 0.7, -side + 0.002, y - r * 0.28, y + r * 0.28, c.z - r * 0.28, c.z + r * 0.28, M["KitTrim"], 0.002)]
    pr = [(-0.85, 0.35), (-0.78, 0.7), (-0.55, 0.93), (-0.2, 1.0), (0.25, 0.97), (0.6, 0.85), (0.85, 0.62)]
    tub = lathe("hopper", [(c.z - r * 0.85, 0)] + [(c.z + r * t, r * s) for t, s in pr] + [(c.z + r * 0.85, 0)], M["Hopper"], 18, (c.x, c.y, 0), "z")
    lid = lathe("lid", [(c.z + r * 0.82, 0), (c.z + r * 0.82, r * 0.66), (c.z + r * 0.95, r * 0.6), (c.z + r * 1.0, r * 0.4), (c.z + r * 1.0, 0)],
                M["KitTrim"], 18, (c.x, c.y, 0), "z")
    return neck + [squash(o, c, sy=1.25) for o in (tub, lid)]


def tank(y0, y1, r, at):
    x, z = at
    pr = [(y0, 0), (y0 + r * 0.3, r * 0.7), (y0 + r * 0.9, r), (y1 - r * 0.9, r), (y1 - r * 0.3, r * 0.7), (y1, 0)]
    return [lathe("tank", pr, M["Tank"], 14, (x, 0, z)),
            lathe("reg", [(y0 + r * 0.6, 0), (y0 + r * 0.6, r * 1.08), (y0 + r * 1.6, r * 1.08), (y0 + r * 1.6, 0)], M["KitTrim"], 14, (x, 0, z)),
            block("mount", x - r * 0.35, x + r * 0.35, (y0 + y1) / 2 - 0.02, (y0 + y1) / 2 + 0.02, z + r * 0.6, z + r * 1.6, M["KitTrim"], 0.001)]


kit = hopper(-0.068, 0.10, 0.058, 0.042, RW) + tank(0.50, 0.63, 0.015, (0, MZ - 0.0105 - 0.017))

# ---- The hands: tools/weapons.py's shotgun hands, on the same wrist and fore-end ----------------
H = S.hands_kit()
Wrap, hand = H["Wrap"], H["hand"]
gw = Wrap((0, -0.062, 0.028), (0, -0.04, -0.1), (0, 1, 0.25), 0.023, 0.0165)
right = hand("shotgun_handR", gw,
             [(0.03, 30, -1, 0.07, 0.0098, 0.0), (0.05, 34, -1, 0.07, 0.0094, -0.3), (0.069, 36, -1, 0.062, 0.0086, -1.0)],
             [gw.at(0.018, 95, 0.004), gw.at(0.08, 100, 0.004), gw.at(0.018, 150, 0.004), gw.at(0.08, 150, 0.006),
              gw.at(0.012, 200, 0.002), gw.at(0.065, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
             (0.012, -0.135, 0.0), (0.28, -0.7, -0.66),
             # The thumb over the wrist's top-left corner and down its left side (6 mm further out than weapons.py's: the
             # rounded walnut no longer hides its inside).
             ([(-0.010, -0.085, 0.046), (-0.026, -0.064, 0.056), (-0.030, -0.042, 0.062), (-0.028, -0.02, 0.066), (-0.026, -0.002, 0.068)], 0.0105),
             ([gw.at(0.008, 70, 0.01), (0.02, 0.012, 0.004), (0.015, 0.025, 0.0), (0.008, 0.028, -0.004), (0.003, 0.026, -0.006)], 0.0095))
pw = Wrap(PUMP, (0, -1, 0), (0, 0, -1), 0.0228, 0.0228 * 0.95)
hw = Wrap(PUMP, (0, 1, 0), (0, 0, -1), 0.0228, 0.0228)
left = hand("shotgun_handL", pw,
            [(-0.03, 13, 1, 0.062, 0.0098, -0.6), (-0.009, 38, 1, 0.064, 0.0096, -0.6), (0.012, 50, 1, 0.058, 0.009, -0.6), (0.031, 59, 1, 0.048, 0.0084, -0.6)],
            [hw.at(-0.04, -10, 0.004), hw.at(0.04, -10, 0.004), hw.at(-0.04, 40, 0.004), hw.at(0.04, 40, 0.004),
             hw.at(-0.03, 10, 0.026), hw.at(0.035, 10, 0.026), hw.at(0.0, 45, 0.02)],
            (-0.012, 0.315, 0.022 - 0.055), (-0.35, -0.5, -0.79),
            ([hw.at(-0.03, 40, 0.016), hw.at(0.0, 65, 0.012), hw.at(0.025, 80, 0.011), hw.at(0.048, 88, 0.011), hw.at(0.066, 92, 0.011)], 0.0108),
            side=-1)
sh = join("shotgun_shell", shell)
for p in sh.data.polygons:
    p.use_smooth = True
sh.location = Vector((-0.006, 0.39, 0.022 - 0.045))  # in the hand's fingers, across the palm, pointing forward
bpy.context.view_layer.update()
sh.parent = left
sh.matrix_parent_inverse = left.matrix_world.inverted()

ROOT = finish("shotgun", GRIP, body, {"pump": (pump, PUMP)}, MUZZLE, SIGHT, kit, [right, left])
__import__("farcopy").far(ROOT)  # the light copy the others' figures and the pickups use (tools/guns/farcopy.py)
H["drop_arms"]()
S.bake_shade(ROOT)
S.export(OUT)

if PREVIEW:
    C = Vector((0, 0.27, 0.0))  # about the middle of the gun, grip at the origin
    hx, hy, hz = 0.05, -0.046, -0.095
    hip_far = math.tan(math.radians(36)) / math.tan(math.radians(27))
    s = Vector(SIGHT) - Vector(GRIP)
    g = Vector(GRIP)
    S.previews("shotgun", ROOT, [right, left], PREVIEW, C,
               [("left", C + Vector((-1.75, 0, 0.03)), C, 50), ("right", C + Vector((1.75, 0, 0.03)), C, 50),
                ("front34", C + Vector((-0.9, 1.1, 0.4)), C, 50), ("rear34", C + Vector((-0.9, -1.15, 0.5)), C, 50),
                ("top", C + Vector((-0.3, -0.05, 1.6)), C, 50),
                ("receiver", Vector((0.09, 0.22, 0.10)) - g, Vector((0, 0.06, 0.035)) - g, 50),
                ("under", Vector((-0.08, 0.10, -0.16)) - g, Vector((0, 0.10, 0.012)) - g, 50),
                ("wrist", Vector((-0.20, -0.16, 0.02)) - g, Vector((0, -0.10, 0.005)) - g, 50),
                ("muzzle", Vector((-0.08, 0.86, 0.10)) - g, Vector((0, 0.68, 0.045)) - g, 50)],
               ((-hx / 0.25, hz * hip_far / 0.25, -hy / 0.25), 54), ((s.x, -0.4, s.z), 57.6))
