"""Build the bolt-action rifle with a scope (`sniper`) in Blender, with the gloved hands that hold it in first person.

Run (Blender 5, no window):
  blender -b -P tools/guns/sniper.py -- <out.glb> [preview_dir]
It writes the GLB (web/public/models/gun-sniper.glb in the repository); the game takes the rifle from it instead of from
weapons.glb (weapon.ts GUN_FILES), and weapons.glb keeps the old one as the fallback. With preview_dir it also renders
small pictures there (tools/guns/rifleparts.py previews).

Our own design, no brand, maker or marking on it: a precision bolt-action rifle, 1.1 m, from the class's published sizes
(a heavy 49 cm barrel, a 34 mm scope tube with a 50 mm objective, a 10-round box magazine, rail slots 10.0 mm apart).
From back to front:
  the stock (a dark grey-green composite): a ribbed rubber butt pad on an aluminium spacer, an adjustable cheek riser on
    two steel posts with its locking knob on the left, a near-vertical grip with checkered panels, the fore-end with a
    barrel channel (the barrel floats free), recessed panels on its sides, sling studs front and back;
  the bottom metal (anodised aluminium): the trigger guard, a straight steel trigger, the magazine release paddle in front
    of it, the magazine well's flared lip, the two action screws;
  the action (phosphated steel): a round receiver bedded in the stock, its ejection port on the right (the bolt shows
    through it), the notch for the bolt handle, the bolt release on the left, the safety lever on the right behind the
    handle, a recoil lug and a rail on top;
  the bolt (bright steel, it moves): three flutes, two locking lugs, the handle with a large ridged knob, the shroud at
    the back with its cocking indicator;
  a detachable box magazine (steel, two pressed ribs, a polymer base plate);
  the barrel: a heavy contour with six flutes, threaded at the muzzle for a brake with three ports on each side, two
    vents on top and the bore at its face;
  a bipod folded forward under the barrel: its clamp on the fore-end's tip with a knob, the pivot, two legs (anodised
    upper tubes, a lock button, steel lower legs with their notches, rubber feet);
  the scope (anodised aluminium): a rubber eyecup, the ocular housing with a ridged zoom ring and its throw lever, the
    34 mm tube, a saddle with the elevation turret on top and the windage turret on the right (ridged caps on plain
    skirts ringed with click marks, an index line on the saddle), the side-focus wheel on the left, the objective bell;
    the lenses (Glass) at both ends; two rings with their cap screws and cross bolts, clamped to the rail. No caps.

Frame and nodes as tools/weapons.py's header says for the bolt-action rifle (the barrel along -z, up +y, right +x,
metres, the origin where the web of the right hand sits on the grip):
  sniper            the weapon (an empty at the origin)
    sniper_body     the parts that never move
    sniper_bolt     the bolt, its pivot on the bore's axis; extras "knob": the handle's knob from the pivot
    sniper_mag      the magazine; extras "out": the way it leaves (straight down)
    sniper_muzzle   where the shot leaves (the brake's face, on the bore's axis)
    sniper_sight    a point on the line of sight (the scope's axis)
    sniper_kit      Paintball's air tank
    sniper_hands    sniper_handR, sniper_handL: glove, cuff and sleeve; each origin at its wrist; extras "grip"
The grip, the trigger, the fore-end's size where the left hand holds it, the muzzle, the scope's axis and the bolt's
knob are where they were in weapons.glb, so the game's numbers (weapon.ts HIP, the bolt's working, the scope's view)
and the hands' poses still fit.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rifleparts import *  # noqa: E402,F401,F403
from rifleparts import H, M, OUT, PREVIEW  # noqa: E402

B = 0.045          # the bore's height
S = B + 0.05       # the scope's axis
GRIP = Vector((0, -0.046, 0.004))
MUZZLE = (0, 0.684, B)
SIGHT = (0, 0.0, S)
KNOB = (0.04, -0.066, B - 0.02)  # the bolt handle's knob (the right hand reaches for it)
SW = 0.0195        # the stock's half width
RT = B + 0.0175    # the receiver's top: the rail stands on it
body, bolt, mag = [], [], []

# ---- The stock --------------------------------------------------------------------------------
# One moulding from the fore-end's tip to the butt, its edges well rounded: the fore-end with a channel the barrel floats
# in, a notch on the right for the bolt handle, a recessed panel along each side of the fore-end; the butt's underside
# straight down to the toe.
stock_cuts = [lathe("channel", [(0.150, 0), (0.150, 0.0152), (0.450, 0.0152), (0.450, 0)], M["Dark"], 20, (0, 0, B)),
              box(0.010, 0.030, -0.082, -0.046, 0.030, 0.060)]
for s in (-1, 1):
    stock_cuts.append(prism("inset", [(0.170, 0.0150), (0.392, 0.0165), (0.392, 0.0380), (0.170, 0.0380)], 0.0008, M["Dark"], 0, x=s * SW))
    stock_cuts.append(prism("inset", [(-0.160, 0.0440), (-0.335, 0.0440), (-0.350, 0.0300), (-0.350, -0.0640), (-0.338, -0.0700), (-0.300, -0.0500),
                                      (-0.240, -0.0380), (-0.170, -0.0240), (-0.150, -0.0100), (-0.150, 0.0320)], 0.0010, M["Dark"], 0, x=s * SW))
body.append(prism("stock", [(0.4180, 0.0440), (0.4245, 0.0400), (0.4255, 0.0200), (0.4205, 0.0120), (0.4080, 0.0090), (0.2500, 0.0078),
                            (0.1300, 0.0070), (0.1240, 0.0035), (-0.0700, 0.0035), (-0.0800, -0.0060), (-0.1400, -0.0280), (-0.2400, -0.0480),
                            (-0.3000, -0.0600), (-0.3480, -0.0840), (-0.3560, -0.0980), (-0.3660, -0.1020), (-0.3750, -0.0990), (-0.3750, 0.0520),
                            (-0.3710, 0.0565), (-0.1500, 0.0565), (-0.1100, 0.0520), (-0.0850, 0.0445)], SW, M["Stock"], 0.0040, 2, cuts=stock_cuts))
# The grip, near upright, with checkered rubber panels.
grip = [(0.0, 0.004), (-0.012, -0.04), (-0.02, -0.098), (-0.06, -0.101), (-0.06, -0.06), (-0.055, -0.02), (-0.065, 0.004)]
body.append(prism("grip", grip, 0.0145, M["Stock"], 0.003, 2))
panel = [(-0.010, -0.022), (-0.018, -0.088), (-0.054, -0.090), (-0.052, -0.022)]
body.append(prism("panel", panel, 0.0150, M["Grip"], 0.0008, 1))
pc = (sum(p[0] for p in panel) / 4, sum(p[1] for p in panel) / 4)
body.append(checker("checkR", (0.0150, pc[0], pc[1]), (0, 1, 0), (0, 0, 1), 10, 17, 0.0050, 0.0007, M["Grip"],
                    lambda a, b: inside_poly(panel, pc[0] + a, pc[1] + b)))
body.append(checker("checkL", (-0.0150, pc[0], pc[1]), (0, 0, 1), (0, 1, 0), 17, 10, 0.0050, 0.0007, M["Grip"],
                    lambda a, b: inside_poly(panel, pc[0] + b, pc[1] + a)))
# The cheek riser on two steel posts (the gap between shows them), its locking knob on the left.
body.append(prism("cheek", [(-0.168, 0.0625), (-0.330, 0.0625), (-0.330, 0.0790), (-0.322, 0.0822), (-0.186, 0.0822), (-0.172, 0.0775)], 0.0175,
                  M["Stock"], 0.0040, 2))
body.append(lathe("buttqd", [(-SW - 0.0003, 0.0026), (-SW - 0.0003, 0.0054), (-SW + 0.0012, 0.0054), (-SW + 0.0012, 0.0026)], M["Dark"], 14,
                  (0, -0.3300, -0.0420), "x", loop=True))
body.append(ring("buttqdhole", -SW - 0.0002, -SW + 0.0010, 0.0026, M["Dark"], (0, -0.3300, -0.0420), 12, "x", 0))
for y in (-0.195, -0.305):
    body.append(ring("post", 0.0520, 0.0640, 0.0036, M["Steel"], (0, y, 0), 12, "z", 0.0003))
body.append(knob("cheekknob", 0.0064, 0.0057, 12, -SW - 0.0080, -SW + 0.0005, M["Dark"], (0, -0.250, 0.0420), "x", 0.0010))
# The butt pad on an aluminium spacer, ribbed across its back, two screws on the spacer's left.
body.append(prism("spacer", [(-0.3745, 0.0540), (-0.3810, 0.0540), (-0.3810, -0.0990), (-0.3745, -0.0990)], 0.0178, M["Anod"], 0.0008, 1))
for z in (0.030, -0.065):
    body.append(screw(-0.0178, -0.3778, z, -1, 0.0016))
pad_cuts = [dark(box(-0.03, 0.03, -0.4000, -0.3955, z, z + 0.0026)) for z in (-0.080, -0.058, -0.036, -0.014, 0.008, 0.030)]
body.append(prism("pad", [(-0.3810, 0.0580), (-0.3930, 0.0575), (-0.3965, 0.0520), (-0.3965, -0.0960), (-0.3930, -0.1030), (-0.3810, -0.1035)],
                  0.0200, M["Grip"], 0.0030, 1, cuts=pad_cuts))
# Sling studs: under the butt and under the fore-end, each a steel post with its cross hole.
for y, z0, z1 in ((-0.300, -0.0690, -0.0570), (0.345, -0.0010, 0.0090)):
    body.append(ring("stud", z0, z1, 0.0032, M["Steel"], (0, y, 0), 10, "z", 0.0006))
    body.append(ring("studhole", -0.0034, 0.0034, 0.0013, M["Dark"], (0, y, z0 + 0.0035), 8, "x", 0))

# ---- The bottom metal ---------------------------------------------------------------------------
# A plate let into the stock's underside from behind the trigger to past the magazine; the trigger guard; a straight
# trigger; the magazine's release paddle in front of the guard; the well's flared lip; the two action screws.
body.append(block("bottommetal", -0.0150, 0.0150, -0.0140, 0.1260, 0.0010, 0.0050, M["Anod"], 0.0008, 1))
body.append(trigger_guard("guard", -0.002, 0.040, 0.002, -0.026, 0.0065, mat=M["Anod"]))
body.append(prism("trigger", [(0.0148, 0.0020), (0.0186, 0.0020), (0.0186, -0.0158), (0.0168, -0.0176), (0.0148, -0.0162)], 0.0030, M["Steel"],
                  0.0005, 1))
body.append(prism("magrelease", [(0.0406, 0.0012), (0.0452, 0.0012), (0.0452, -0.0108), (0.0432, -0.0128), (0.0406, -0.0118)], 0.0070, M["Anod"],
                  0.0006, 1))
body.append(prism("lip", [(0.0460, 0.0012), (0.1220, 0.0012), (0.1240, -0.0045), (0.0440, -0.0045)], 0.0158, M["Anod"], 0.0012, 2,
                  cuts=[box(-0.0126, 0.0126, 0.0478, 0.1202, -0.02, 0.01)]))
for y in (-0.0090, 0.1300):
    body.append(ring("actionscrew", 0.0002, 0.0012, 0.0036, M["Steel"], (0, y, 0), 12, "z", 0.0003))

# ---- The action -------------------------------------------------------------------------------
# A round receiver: the ejection port on the right from the top down to the bore's line (dark inside: the bolt shows
# through it), a notch at the back for the bolt handle. A recoil lug and the barrel's tenon in front, a rail on top, the
# bolt release on the left, the safety on the right behind the handle.
rec_cuts = [dark(box(-0.0020, 0.030, 0.035, 0.097, B - 0.0010, B + 0.030)), dark(box(0.004, 0.030, -0.0705, -0.0495, B - 0.025, B + 0.004))]
rec = lathe("receiver", [(-0.0860, 0), (-0.0860, 0.0160), (-0.0845, 0.0175), (0.1485, 0.0175), (0.1500, 0.0165), (0.1500, 0)], M["Phos"], 24, (0, 0, B))
body.append(cut(rec, rec_cuts))
body.append(ring("lug", 0.1500, 0.1550, 0.0195, M["Dark"], (0, 0, B), 24, chamfer=0.0005))
body.append(ring("tenon", 0.1540, 0.1660, 0.0152, M["Phos"], (0, 0, B), 24, chamfer=0.0005))
body += rail("rail", -0.0800, 0.1450, RT, skip=[(-0.040, -0.016), (0.064, 0.088)])
body.append(prism("boltrelease", [(-0.0800, B + 0.0020), (-0.0640, B + 0.0020), (-0.0640, B + 0.0090), (-0.0760, B + 0.0100)], 0.0008, M["Dark"], 0.0003, 1,
                  x=-0.0182))
body.append(ring("releasepin", -0.0192, -0.0175, 0.0012, M["Steel"], (0, -0.0660, B + 0.0055), 8, "x", 0))
body.append(block("safetybase", 0.0140, 0.0200, -0.0940, -0.0800, 0.0440, 0.0480, M["Dark"], 0.0006, 1))
body.append(prism("safety", [(-0.0960, 0.0440), (-0.0830, 0.0440), (-0.0850, 0.0505), (-0.0930, 0.0515)], 0.0008, M["Dark"], 0.0003, 1, x=0.0208))

# ---- The barrel and the brake ------------------------------------------------------------------
# A heavy contour, plain at the chamber, six flutes along the middle (each fading out at its ends), plain again to the
# thread's shoulder; the brake: a block with three ports through each side, two vents on top, the bore at its face.
R = lambda y: 0.0140 - (0.0140 - 0.0112) * max(0.0, min(1.0, (y - 0.230) / (0.600 - 0.230)))  # the contour


def fluted(name, y0, y1, flutes, depth, run=0.016):
    """The barrel from y0 to y1 with `flutes` straight flutes `depth` deep, fading in and out over `run` at the ends."""
    n = flutes
    rings_ = []
    for y, d in ((y0, 0.0), (y0 + run, depth), (y1 - run, depth), (y1, 0.0)):
        pts = []
        for k in range(n):
            a = 2 * math.pi * k / n + math.pi / n / 2
            step = math.pi / n
            for da, dd in ((-0.42 * step, 0.0), (0.42 * step, 0.0), (0.72 * step, d), (1.28 * step, d)):
                r = R(y) - dd
                pts.append((r * math.cos(a + da), y, B + r * math.sin(a + da)))
        rings_.append(pts)
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in ring_] for ring_ in rings_]
    m = len(vs[0])
    for a_, b_ in zip(vs, vs[1:]):
        for k in range(m):
            bm.faces.new((a_[k], a_[(k + 1) % m], b_[(k + 1) % m], b_[k]))
    bm.faces.new(vs[0])
    bm.faces.new(list(reversed(vs[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [M["Phos"]])
    return shade(o, 40)


body.append(lathe("barrel1", [(0.1650, 0), (0.1650, 0.0140), (0.2420, R(0.2420)), (0.2420, 0)], M["Phos"], 24, (0, 0, B)))
body.append(fluted("barrel2", 0.2410, 0.5510, 6, 0.0020))
body.append(lathe("barrel3", [(0.5500, 0), (0.5500, R(0.5500)), (0.6000, R(0.6000)), (0.6020, 0.0098), (0.6140, 0.0098), (0.6140, 0)], M["Phos"], 24,
                  (0, 0, B)))
brake_cuts = [dark(box(-0.05, 0.05, y, y + 0.0075, B - 0.0085, B + 0.0085)) for y in (0.6250, 0.6410, 0.6570)]
brake_cuts += [dark(lathe("vent", [(B, 0), (B, 0.0022), (B + 0.03, 0.0022), (B + 0.03, 0)], M["Dark"], 10, (0, y, 0), "z")) for y in (0.6705, 0.6775)]
brake_cuts.append(dark(lathe("borecut", [(0.6650, 0), (0.6650, 0.0048), (0.7000, 0.0048), (0.7000, 0)], M["Dark"], 14, (0, 0, B))))
body.append(xprism("brake", [(-0.0135, B - 0.0085), (-0.0095, B - 0.0125), (0.0095, B - 0.0125), (0.0135, B - 0.0085), (0.0135, B + 0.0085),
                             (0.0095, B + 0.0125), (-0.0095, B + 0.0125), (-0.0135, B + 0.0085)], 0.6120, 0.6840, M["Phos"], 0.0008, 1, cuts=brake_cuts))
body.append(knob("jamnut", 0.0128, 0.0122, 12, 0.6060, 0.6125, M["Dark"], (0, 0, B), "y", 0.0003))

# ---- The bipod, folded forward -----------------------------------------------------------------
BZ = -0.0040  # the legs' axis height
body.append(block("bipodmount", -0.0090, 0.0090, 0.3800, 0.4120, -0.0020, 0.0090, M["Anod"], 0.0012, 1))
body.append(knob("bipodknob", 0.0050, 0.0045, 10, -0.0145, -0.0090, M["Dark"], (0, 0.3940, 0.0035), "x", 0.0006))
body.append(ring("bipodpivot", -0.0180, 0.0180, 0.0056, M["Anod"], (0, 0.4040, BZ), 16, "x", 0.0006))
for s in (-1, 1):
    x = s * 0.0128
    body.append(lathe("legupper", [(0.3990, 0), (0.3990, 0.0058), (0.4070, 0.0062), (0.4800, 0.0062), (0.4820, 0.0057), (0.4980, 0.0057),
                                   (0.4980, 0)], M["Anod"], 14, (x, 0, BZ)))
    body.append(ring("leglock", s * 0.0050 - 0.0014, s * 0.0050 + 0.0014, 0.0022, M["Steel"], (x, 0.4900, BZ), 10, "x", 0.0003))
    body.append(lathe("leglower", [(0.4970, 0), (0.4970, 0.0043), (0.5780, 0.0043), (0.5780, 0)], M["Phos"], 12, (x, 0, BZ)))
    for y in (0.5200, 0.5400):
        body.append(lathe("legnotch", [(y, 0.0040), (y, 0.0045), (y + 0.0024, 0.0045), (y + 0.0024, 0.0040)], M["Dark"], 10, (x, 0, BZ), loop=True))
    body.append(lathe("legfoot", [(0.5770, 0), (0.5770, 0.0058), (0.5860, 0.0061), (0.5920, 0.0049), (0.5950, 0)], M["Grip"], 12, (x, 0, BZ),
                      smooth_angle=60))

# ---- The scope --------------------------------------------------------------------------------
# One lathe from the ocular to the objective bell (dark inside its ends, the glass in front of that), a rubber eyecup,
# a ridged zoom ring with its throw lever; the saddle with the turrets and the side-focus wheel; the rings.
body.append(lathe("scope", [(-0.1205, 0), (-0.1205, 0.0166), (-0.1260, 0.0170), (-0.1260, 0.0200), (-0.1245, 0.0208), (-0.0640, 0.0208),
                            (-0.0500, 0.0172), (0.0980, 0.0172), (0.1520, 0.0268), (0.1910, 0.0272), (0.1950, 0.0264), (0.1950, 0.0242),
                            (0.1890, 0.0238), (0.1890, 0)], [M["Anod"], M["Dark"]], 28, (0, 0, S), seg_mat=[1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]))
body.append(lathe("eyecup", [(-0.1380, 0.0176), (-0.1380, 0.0198), (-0.1330, 0.0212), (-0.1225, 0.0214), (-0.1225, 0.0200), (-0.1330, 0.0186)],
                  M["Grip"], 28, (0, 0, S), loop=True, smooth_angle=50))
body.append(lathe("eyelens", [(-0.1216, 0), (-0.1214, 0.0080), (-0.1207, 0.0165), (-0.1200, 0.0165), (-0.1200, 0)], M["Glass"], 28, (0, 0, S),
                  smooth_angle=80))
body.append(lathe("objlens", [(0.1880, 0), (0.1880, 0.0237), (0.1887, 0.0237), (0.1894, 0.0120), (0.1896, 0)], M["Glass"], 28, (0, 0, S),
                  smooth_angle=80))
body.append(knob("zoom", 0.0217, 0.0210, 24, -0.0920, -0.0770, M["Anod"], (0, 0, S), "y", 0.0008))
body.append(turn_about_bore(block("throwlever", 0.0205, 0.0285, -0.0880, -0.0810, S - 0.0030, S + 0.0030, M["Anod"], 0.0010, 1), math.radians(50), S))
body.append(xprism("saddle", [(-0.0205, S - 0.0120), (-0.0120, S - 0.0190), (0.0120, S - 0.0190), (0.0205, S - 0.0120), (0.0205, S + 0.0120),
                              (0.0140, S + 0.0205), (-0.0140, S + 0.0205), (-0.0205, S + 0.0120)], -0.0060, 0.0500, M["Anod"], 0.0016, 2))
TY = 0.0220  # the turrets' place along the scope


def ticks(name, axis, centre, r, t0, n=30):
    """Click marks round a turret's skirt: `n` thin raised lines, every fifth one longer, in the marks' white."""
    parts = []
    for k in range(n):
        a = 2 * math.pi * k / n
        long_ = 0.0042 if k % 5 == 0 else 0.0026
        o = block(name, r - 0.0002, r + 0.00035, -0.00035, 0.00035, t0, t0 + long_, M["Dot"], 0)
        turn = Matrix.Rotation(a, 4, "Z")
        if axis == "x":  # a turret on the right: its t along +x, round it in y and z
            turn = Matrix.Rotation(a, 4, "X") @ Matrix.Rotation(math.pi / 2, 4, "Y")
        parts.append(moved(o, Matrix.Translation(centre) @ turn))
    return parts


# Elevation on top: a collar, a plain skirt with its click marks, a ridged cap, a top. The index line on the saddle.
body.append(ring("ecollar", S + 0.0195, S + 0.0235, 0.0125, M["Anod"], (0, TY, 0), 24, "z", 0.0004))
body.append(ring("eskirt", S + 0.0235, S + 0.0310, 0.0158, M["Anod"], (0, TY, 0), 30, "z", 0.0005))
body += ticks("etick", "z", Vector((0, TY, 0)), 0.0158, S + 0.0238)
body.append(knob("ecap", 0.0160, 0.0152, 30, S + 0.0310, S + 0.0410, M["Anod"], (0, TY, 0), "z", 0.0008))
body.append(ring("etop", S + 0.0405, S + 0.0420, 0.0128, M["Anod"], (0, TY, 0), 24, "z", 0.0004))
body.append(block("eindex", -0.0004, 0.0004, TY - 0.0200, TY - 0.0162, S + 0.0200, S + 0.0212, M["Dot"], 0))
# Windage on the right, smaller.
body.append(ring("wcollar", 0.0195, 0.0235, 0.0118, M["Anod"], (0, TY, S), 24, "x", 0.0004))
body.append(ring("wskirt", 0.0235, 0.0295, 0.0145, M["Anod"], (0, TY, S), 28, "x", 0.0005))
body += ticks("wtick", "x", Vector((0, TY, S)), 0.0145, 0.0238, 24)
body.append(knob("wcap", 0.0147, 0.0140, 26, 0.0295, 0.0375, M["Anod"], (0, TY, S), "x", 0.0007))
body.append(block("windex", 0.0200, 0.0212, TY - 0.0185, TY - 0.0150, S - 0.0004, S + 0.0004, M["Dot"], 0))
# The side-focus wheel on the left: a collar and a big ridged wheel.
body.append(ring("fcollar", -0.0235, -0.0195, 0.0120, M["Anod"], (0, TY, S), 24, "x", 0.0004))
body.append(knob("focus", 0.0188, 0.0180, 36, -0.0340, -0.0235, M["Anod"], (0, TY, S), "x", 0.0009))
body.append(ring("fcap", -0.0352, -0.0338, 0.0110, M["Anod"], (0, TY, S), 20, "x", 0.0004))
# The rings: a band round the tube, its cap held by two screws on each side, a base clamped on the rail (jaws on its
# dovetail, a cross bolt with a nut on the left).
for y0 in (-0.0400, 0.0640):
    y1 = y0 + 0.0240
    body.append(lathe("ring", [(y0 + 0.004, 0.0170), (y0 + 0.004, 0.0198), (y1 - 0.004, 0.0198), (y1 - 0.004, 0.0170)], M["Dark"], 28, (0, 0, S),
                      loop=True))
    for s in (-1, 1):
        for y in (y0 + 0.0080, y1 - 0.0080):
            body.append(screw(s * 0.0198, y, S, s, 0.0015))
    body.append(block("ringbase", -0.0105, 0.0105, y0 + 0.0040, y1 - 0.0040, RT + 0.0065, S - 0.0180, M["Dark"], 0.0010, 1))
    body.append(block("ringclamp", -0.0130, 0.0130, y0, y1, RT + 0.0060, RT + 0.0110, M["Dark"], 0.0010, 1))
    for s in (-1, 1):
        body.append(block("ringjaw", s * 0.0108, s * 0.0130, y0, y1, RT + 0.0028, RT + 0.0065, M["Dark"], 0.0004, 1))
    body.append(ring("ringnut", -0.0158, -0.0130, 0.0042, M["Steel"], (0, (y0 + y1) / 2, RT + 0.0048), 6, "x", 0.0004))
    body.append(ring("ringbolt", 0.0130, 0.0146, 0.0028, M["Dark"], (0, (y0 + y1) / 2, RT + 0.0048), 12, "x", 0.0003))

# ---- The bolt ---------------------------------------------------------------------------------
# Bright steel: the body with three straight flutes and two lugs at its head (both show through the port), the handle's
# root and its stem out and down to a large ridged knob, the shroud at the back with the cocking indicator.
bolt.append(lathe("boltbody", [(-0.0860, 0), (-0.0860, 0.0094), (0.0950, 0.0094), (0.0965, 0.0086), (0.0965, 0)], M["Steel"], 20, (0, 0, B)))
for a in (40, 160, 280):
    bolt.append(turn_about_bore(block("flute", 0.0088, 0.0096, -0.0300, 0.0750, B - 0.0015, B + 0.0015, M["Dark"], 0), math.radians(a), B))
for a in (0, 180):
    bolt.append(turn_about_bore(block("boltlug", 0.0080, 0.0118, 0.0860, 0.0960, B - 0.0042, B + 0.0042, M["Steel"], 0.0005, 1), math.radians(a), B))
bolt.append(ring("handleroot", -0.0665, -0.0535, 0.0104, M["Steel"], (0, 0, B), 20, chamfer=0.0008))
bolt.append(sweep("handle", [(0.0060, -0.0600, B - 0.0030), (0.0200, -0.0620, B - 0.0090), (0.0320, -0.0650, B - 0.0160)], [0.0044, 0.0040, 0.0036],
                  M["Steel"], 10))
bolt.append(knob("boltknob", 0.0090, 0.0082, 10, KNOB[0] - 0.0090, KNOB[0] + 0.0090, M["Anod"], KNOB, "x", 0.0030))
bolt.append(lathe("shroud", [(-0.1220, 0), (-0.1220, 0.0085), (-0.1180, 0.0115), (-0.0950, 0.0128), (-0.0880, 0.0128), (-0.0860, 0.0110),
                             (-0.0860, 0)], M["Phos"], 20, (0, 0, B)))
bolt.append(ring("indicator", -0.1265, -0.1215, 0.0022, M["Steel"], (0, 0, B), 10, chamfer=0.0004))

# ---- The magazine -----------------------------------------------------------------------------
mag.append(prism("mag", [(0.0482, 0.0040), (0.1198, 0.0040), (0.1198, -0.0330), (0.0482, -0.0330)], 0.0118, M["Dark"], 0.0010, 1))
for z in (-0.0120, -0.0230):
    mag.append(block("magrib", -0.0122, 0.0122, 0.0530, 0.1150, z, z + 0.0022, M["Dark"], 0.0006, 1))
mag.append(prism("magbase", [(0.0460, -0.0320), (0.1220, -0.0320), (0.1230, -0.0380), (0.1210, -0.0405), (0.0480, -0.0405), (0.0460, -0.0380)], 0.0135,
                 M["Polymer"], 0.0015, 1))

# ---- Paintball's kit, the hands ----------------------------------------------------------------
kit = tank(0.322, 0.378, 0.015, (0, 0.0085 - 0.0165))
# The right hand round the grip as before (tools/weapons.py build_sniper), its thumb along the stock's left side (it lay
# a little inside the old one's flank). The left hand under the fore-end, palm up, as before: the same size there.
gw = H["Wrap"]((0, -0.03, -0.0), (0, -0.018, -0.1), (0, 1, 0), 0.021, 0.0148)
handR = H["hand"]("sniper_handR", gw,
                  [(0.032, 70, -1, 0.09, 0.0098, 0.0), (0.052, 72, -1, 0.086, 0.0094, 0.0), (0.071, 76, -1, 0.07, 0.0086, 0.0)],
                  [], (0.012, -0.10, -0.03), (0.25, -0.82, -0.5),
                  ([(-0.006, -0.053, 0.006), (-0.026, -0.035, 0.015), (-0.0305, -0.012, 0.024), (-0.030, 0.008, 0.030), (-0.027, 0.024, 0.033)], 0.0105),
                  ([gw.at(0.01, 72, 0.01), (0.02, 0.003, -0.004), (0.016, 0.018, -0.006), (0.009, 0.021, -0.008), (0.004, 0.019, -0.01)], 0.0095))
fz = 0.026  # the fore-end's middle height
pw = H["Wrap"]((0, 0.28, fz), (0, -1, 0), (0, 0, -1), 0.019, 0.0185)
hw = H["Wrap"]((0, 0.28, fz), (0, 1, 0), (0, 0, -1), 0.019, 0.0185)
handL = H["hand"]("sniper_handL", pw,
                  [(-0.03, 13, 1, 0.062, 0.0098, -0.6), (-0.009, 38, 1, 0.064, 0.0096, -0.6), (0.012, 50, 1, 0.058, 0.009, -0.6),
                   (0.031, 59, 1, 0.048, 0.0084, -0.6)],
                  [], (-0.012, 0.205, fz - 0.052), (-0.35, -0.5, -0.79),
                  ([hw.at(-0.03, 40, 0.016), hw.at(0.0, 65, 0.012), hw.at(0.025, 80, 0.011), hw.at(0.048, 88, 0.011), hw.at(0.066, 92, 0.011)], 0.0108),
                  side=-1)

ROOT = finish("sniper", GRIP, body, {"bolt": (bolt, (0, -0.06, B), {"knob": KNOB}), "mag": (mag, (0, 0.082, 0.0), {"out": (0, 0.0, -1)})},
              MUZZLE, SIGHT, kit, [handR, handL])
__import__("farcopy").far(ROOT)  # the light copy the others' figures and the pickups use (tools/guns/farcopy.py)
export(ROOT, OUT)

if PREVIEW:
    g = lambda x, y, z: Vector((x, y, z)) - GRIP  # a design point in the GLB's place (the grip at the origin)
    previews(ROOT, "sniper", PREVIEW, g(0, 0.15, 0.0), 1.1, (0.05, -0.046, -0.095), ads=(0.4, 54.0), closeups=[
        ("actionR", g(0.24, 0.02, 0.12), g(0, 0.02, 0.05), 50),
        ("actionL", g(-0.26, -0.02, 0.10), g(0, -0.02, 0.04), 50),
        ("scope", g(-0.20, 0.10, 0.22), g(0, 0.03, 0.09), 50),
        ("muzzle", g(-0.12, 0.80, 0.10), g(0, 0.62, 0.03), 50),
        ("butt", g(-0.26, -0.40, 0.14), g(0, -0.27, 0.0), 50),
    ])
