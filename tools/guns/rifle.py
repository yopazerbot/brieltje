"""Build the carbine (`rifle`) in Blender, with the gloved hands that hold it in first person.

Run (Blender 5, no window):
  blender -b -P tools/guns/rifle.py -- <out.glb> [preview_dir]
It writes the GLB (web/public/models/gun-rifle.glb in the repository); the game takes the carbine from it instead of
from weapons.glb (weapon.ts GUN_FILES), and weapons.glb keeps the old one as the fallback. With preview_dir it also
renders small pictures there (tools/guns/rifleparts.py previews).

Our own design, no brand, maker or marking on it: a modern carbine of the common gas-operated class, 95 cm, from the
class's published sizes (a 40 cm barrel, a 30-round magazine about 19 cm long and 23 mm wide, a rail with its slots
10.0 mm apart, 5.2 mm wide and 3 mm deep, handguard slots 7 by 32 mm every 40 mm). From back to front:
  the stock: a polymer body that slides on the buffer tube, its release lever underneath, a lightening window, a sling
    slot through its toe, a ribbed rubber pad; the tube with its position holes, a notched castle nut, an end plate
    with a sling socket on the left;
  the lower receiver (anodised aluminium): the buffer tower, the rear takedown pin and the front pivot pin (their heads
    on the left), the hammer and trigger pins, the fire selector on the left (forward: safe), the bolt catch on the left
    over the magazine well (a paddle with a ridged pad), the magazine release on the right in its raised fence, the
    magazine well with a flared lip and recessed sides; a polymer trigger guard, a curved steel trigger, a polymer
    pistol grip with checkered panels and a cap underneath;
  the upper receiver (anodised aluminium): chamfered top edges, a rail on top, the charging handle's T at the back
    with its latch on the left, on the right the forward assist, the brass deflector and the ejection port with its
    dust cover hanging open on its hinge rod, the bolt carrier behind the port (bright steel, the forward assist's
    notches on its side) and the bolt's head with its gas rings and extractor in front of it;
  folding iron sights, folded down on the rail; a tube red-dot sight on a one-piece mount (a rail clamp with its cross
    bolt and nut, a ring with four cap screws), a rear and a front window (Lens), the dot (RedDot), the elevation and
    windage caps with click ridges, a brightness knob on the left;
  a free-float handguard (eight-sided, anodised), its rail on top, slots on the sides and underneath and vents on the
    upper corners, through which the barrel, the gas block and the gas tube show, two clamp screws at its back;
  the barrel (phosphated steel) with a crown and a 5.56 mm bore, a crush washer and a flash hider with five ports
    (none underneath).
Three dark finishes break it up: anodised aluminium (RifleAnodised), polymer (Polymer, Grip) and phosphated steel
(RiflePhosphate), with bright steel (Steel) and small dark hardware (Dark).

Frame and nodes as tools/weapons.py's header says for the carbine (the barrel along -z, up +y, right +x, metres, the
origin where the web of the right hand sits on the grip):
  rifle             the weapon (an empty at the origin)
    rifle_body      the parts that never move
    rifle_mag       the magazine; extras "out": the way it leaves (unit, the GLB's frame)
    rifle_optic     the red-dot sight and its mount (the game takes it off for a found scope)
    rifle_muzzle    where the shot leaves (the flash hider's face, on the bore's axis)
    rifle_sight     a point on the line of sight (the red dot)
    rifle_kit       Paintball's hopper and air tank
    rifle_hands     rifle_handR, rifle_handL: glove, cuff and sleeve; each origin at its wrist; extras "grip"
The grip, the trigger, the lower's line, the handguard's size, the muzzle and the line of sight are where they were in
weapons.glb, so the game's numbers for the carbine (weapon.ts HIP and its aim) and the hands' poses still fit.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rifleparts import *  # noqa: E402,F401,F403
from rifleparts import H, M, OUT, PREVIEW  # noqa: E402

B = 0.048          # the bore's height (and the buffer tube's, the bolt carrier's)
GRIP = Vector((0, -0.042, 0.006))
MUZZLE = (0, 0.566, B)
DOT = (0, 0.02, 0.108)   # the red dot: the line of sight
UH = 0.0122        # the upper receiver's half width
LH = 0.0125        # the lower's
RZ = 0.072         # the top of the receiver and of the handguard: the rail stands on it
HG = 0.0262        # the handguard's corner radius (eight sides: 24.2 mm from the bore to each flat)
body, optic, mag = [], [], []


# ---- The upper receiver ------------------------------------------------------------------------
# Its body, chamfered along the top, with the ejection port cut in its right side (dark inside) and a lip along its foot
# where it meets the lower, so the seam between the two shows.
# In section: straight sides from its foot to the bolt carrier's top, then a shoulder in to the rail's foot.
upper_cuts = [dark(box(0.0035, 0.02, 0.014, 0.078, 0.0415, 0.0565))]  # the ejection port
body.append(xprism("upper", [(-UH, 0.0295), (-UH + 0.0015, 0.028), (UH - 0.0015, 0.028), (UH, 0.0295), (UH, 0.0578), (0.0094, 0.0688), (0.0094, RZ),
                             (-0.0094, RZ), (-0.0094, 0.0688), (-UH, 0.0578)], -0.0735, 0.106, M["Anod"], 0.0010, 2, cuts=upper_cuts))
body.append(block("upperlip", -UH - 0.0005, UH + 0.0005, -0.0725, 0.105, 0.028, 0.0312, M["Anod"], 0.0005, 1))
body += rail("rail", -0.0715, 0.104, RZ, skip=[(-0.069, -0.045), (-0.010, 0.026)])
# The bolt carrier behind the port: bright steel, the forward assist's notches along its right side; ahead of it the
# bolt's head with three gas rings and the extractor on its right. Both run on inside the receiver, out of sight.
body.append(lathe("carrier", [(-0.060, 0), (-0.060, 0.0115), (-0.058, 0.0118), (0.0555, 0.0118), (0.058, 0.0110), (0.058, 0)], M["Steel"], 20, (0, 0, B)))
for k in range(7):
    y = 0.018 + k * 0.0042
    body.append(block("fanotch", 0.0108, 0.0119, y, y + 0.0016, B - 0.0040, B + 0.0040, M["Dark"], 0))
body.append(lathe("bolt", [(0.057, 0), (0.057, 0.0089), (0.0770, 0.0089), (0.0778, 0.0082), (0.0778, 0)], M["Steel"], 18, (0, 0, B)))
for y in (0.0600, 0.0628, 0.0656):
    body.append(lathe("gasring", [(y, 0), (y, 0.0091), (y + 0.0011, 0.0091), (y + 0.0011, 0)], M["Dark"], 12, (0, 0, B)))
body.append(block("extractor", 0.0050, 0.0093, 0.0610, 0.0772, B + 0.0010, B + 0.0062, M["Steel"], 0.0004, 1))
# The dust cover, hanging open from its hinge rod under the port: a thin steel plate with a rib and the latch's bump.
body.append(lathe("hinge", [(0.011, 0), (0.011, 0.0012), (0.079, 0.0012), (0.079, 0)], M["Phos"], 8, (UH + 0.0010, 0, 0.0400)))
body.append(prism("dustcover", [(0.0125, 0.0405), (0.0775, 0.0405), (0.0775, 0.0290), (0.0755, 0.0272), (0.0145, 0.0272), (0.0125, 0.0290)], 0.0006,
                  M["Phos"], 0.0003, 1, x=UH + 0.0014))
body.append(block("coverrib", UH + 0.0018, UH + 0.0026, 0.0150, 0.0750, 0.0338, 0.0352, M["Phos"], 0.0002, 1))
body.append(block("coverlatch", UH + 0.0018, UH + 0.0034, 0.0165, 0.0245, 0.0290, 0.0322, M["Phos"], 0.0004, 1))
# Behind the port on the right: the brass deflector, a raised wedge; behind it the forward assist, a housing on the
# receiver's flank and a ridged plunger pointing back.
body.append(prism("deflector", [(-0.012, 0.0465), (0.004, 0.0475), (0.012, 0.0540), (0.012, 0.0575), (-0.004, 0.0575), (-0.014, 0.0525)], 0.0020,
                  M["Anod"], 0.0010, 2, x=UH + 0.0014))
FA = (UH + 0.0030, 0, 0.0535)  # the forward assist's axis
body.append(block("fafairing", UH - 0.0010, UH + 0.0030, -0.0640, -0.0440, 0.0480, 0.0590, M["Anod"], 0.0010, 1))
body.append(lathe("fahousing", [(-0.0660, 0), (-0.0660, 0.0052), (-0.0650, 0.0060), (-0.0470, 0.0060), (-0.0410, 0.0036), (-0.0410, 0)], M["Anod"], 16, FA))
body.append(knob("faplunger", 0.0049, 0.0044, 10, -0.0745, -0.0660, M["Phos"], FA, "y"))
body.append(ring("facap", -0.0760, -0.0743, 0.0037, M["Phos"], FA, 14))
# The charging handle: its T out of the back under the rail, the wings tapering forward, the latch on the left wing.
ch_cuts = [zbox(s * 0.0170, -0.0752, 0.0115, 0.0115, 0.05, 0.09, math.radians(45)) for s in (-1, 1)]
body.append(prism("chargeT", [(-0.0868, 0.0632), (-0.0752, 0.0632), (-0.0752, 0.0712), (-0.0850, 0.0712), (-0.0868, 0.0694)], 0.0170, M["Anod"],
                  0.0010, 2, cuts=ch_cuts))
body.append(block("chargestem", -0.0045, 0.0045, -0.0760, -0.0700, 0.0640, 0.0705, M["Anod"], 0.0004, 1))
latch_cuts = [dark(box(-0.03, 0.0, y, y + 0.0007, 0.0729, 0.074)) for y in (-0.0846, -0.0826)]
body.append(prism("chargelatch", [(-0.0866, 0.0710), (-0.0792, 0.0710), (-0.0792, 0.0726), (-0.0800, 0.0734), (-0.0866, 0.0734)], 0.0037, M["Anod"],
                  0.0004, 1, x=-0.0130, cuts=latch_cuts))
body.append(ring("latchpin", 0.0712, 0.0738, 0.0013, M["Steel"], (-0.0105, -0.0800, 0), 10, "z"))

# ---- The lower receiver ------------------------------------------------------------------------
# The buffer tower behind the upper, the pins' bosses, the magazine well with a flared lip, the trigger's slot; the
# well's sides recessed a little inside a rim.
lower_cuts = [prism("inset", [(0.046, -0.029), (0.098, -0.029), (0.098, 0.004), (0.046, 0.004)], 0.0007, M["Dark"], 0, x=s * LH) for s in (-1, 1)]
body.append(prism("lower", [(-0.0865, 0.0600), (-0.0845, 0.0620), (-0.0740, 0.0620), (-0.0740, 0.028), (0.100, 0.028), (0.1075, 0.0262),
                            (0.1110, 0.0190), (0.1080, 0.0120), (0.1040, 0.0100), (0.1040, -0.034), (0.033, -0.034), (0.033, 0.0),
                            (-0.004, 0.0), (-0.050, 0.004), (-0.066, 0.008), (-0.080, 0.016), (-0.0865, 0.030)], LH, M["Anod"], 0.0016, 2,
                  cuts=lower_cuts))
body.append(prism("lip", [(0.031, -0.031), (0.1055, -0.031), (0.1080, -0.0435), (0.0290, -0.0435)], 0.0142, M["Anod"], 0.0016, 2,
                  cuts=[box(-0.0118, 0.0118, 0.035, 0.1015, -0.05, -0.02)]))
# The pins, their heads on the left and their ends flush on the right: the front pivot pin and the rear takedown pin
# (steel), the hammer and trigger pins (small, darker).
for y, z, r, mat in ((0.1062, 0.0190, 0.0033, M["Steel"]), (-0.0640, 0.0205, 0.0033, M["Steel"]), (0.0160, 0.0105, 0.0021, M["Phos"]),
                     (-0.0045, 0.0165, 0.0021, M["Phos"])):
    body.append(ring("pinL", -LH - 0.0009, -LH + 0.0004, r, mat, (0, y, z), 10, "x", 0.0004))
    body.append(ring("pinR", LH - 0.0004, LH + 0.0003, r * 0.8, mat, (0, y, z), 8, "x", 0))
# The fire selector on the left: a round boss and its lever, pointing forward (safe); its end on the right.
body.append(ring("selboss", -LH - 0.0010, -LH + 0.0004, 0.0057, M["Dark"], (0, -0.030, 0.0190), 18, "x", 0.0004))
body.append(prism("selector", [(-0.0335, 0.0165), (-0.0110, 0.0172), (-0.0085, 0.0196), (-0.0100, 0.0224), (-0.0300, 0.0226), (-0.0345, 0.0200)], 0.0007,
                  M["Steel"], 0.0003, 1, x=-LH - 0.0017,
                  cuts=[dark(box(-LH - 0.004, -LH - 0.0019, y, y + 0.0006, 0.016, 0.023)) for y in (-0.0150, -0.0136, -0.0122)]))
body.append(ring("selR", LH - 0.0004, LH + 0.0008, 0.0040, M["Dark"], (0, -0.030, 0.0190), 14, "x", 0.0003))
# The bolt catch on the left over the well's back: a paddle on a roll pin, its lower pad ridged.
body.append(prism("boltcatch", [(0.0312, 0.0262), (0.0408, 0.0262), (0.0428, 0.0110), (0.0424, 0.0035), (0.0330, 0.0035), (0.0314, 0.0110)], 0.0008,
                  M["Dark"], 0.0004, 1, x=-LH - 0.0009))
for z in (0.0048, 0.0068, 0.0088):
    body.append(block("catchrib", -LH - 0.0024, -LH - 0.0012, 0.0334, 0.0420, z, z + 0.0008, M["Dark"], 0.0002, 1))
body.append(ring("catchpin", -LH - 0.0020, -LH - 0.0010, 0.0014, M["Steel"], (0, 0.0362, 0.0228), 10, "x", 0.0002))
# The magazine release on the right: a ridged button in a raised fence.
body.append(lathe("fence", [(LH - 0.0005, 0.0060), (LH - 0.0005, 0.0084), (LH + 0.0018, 0.0084), (LH + 0.0022, 0.0078), (LH + 0.0022, 0.0066),
                            (LH + 0.0018, 0.0060)], M["Anod"], 16, (0, 0.0248, 0.0110), "x", loop=True))
body.append(knob("magrelease", 0.0047, 0.0042, 12, LH - 0.0004, LH + 0.0024, M["Dark"], (0, 0.0248, 0.0110), "x", 0.0005))
# Trigger guard, trigger.
body.append(trigger_guard("guard", -0.004, 0.03, 0.002, -0.026, 0.006))
body.append(prism("trigger", [(0.0160, 0.0), (0.0186, -0.0060), (0.0176, -0.0130), (0.0142, -0.0176), (0.0126, -0.0166), (0.0152, -0.0126),
                              (0.0158, -0.0062), (0.0128, 0.0)], 0.0032, M["Steel"], 0.0005, 1))
# The pistol grip: polymer, checkered panels on both sides, a cap underneath.
grip = [(-0.004, 0.002), (-0.012, -0.03), (-0.022, -0.065), (-0.03, -0.105), (-0.07, -0.108), (-0.068, -0.08), (-0.058, -0.04),
        (-0.048, -0.008), (-0.05, 0.004)]
body.append(prism("grip", grip, 0.0145, M["Polymer"], 0.003, 2))
panel = [(-0.012, -0.02), (-0.025, -0.095), (-0.063, -0.097), (-0.052, -0.02)]
body.append(prism("panel", panel, 0.0150, M["Grip"], 0.0008, 1))
pc = (sum(p[0] for p in panel) / 4, sum(p[1] for p in panel) / 4)
body.append(checker("checkR", (0.0150, pc[0], pc[1]), (0, 1, 0), (0, 0, 1), 11, 19, 0.0052, 0.0007, M["Grip"],
                    lambda a, b: inside_poly(panel, pc[0] + a, pc[1] + b)))
body.append(checker("checkL", (-0.0150, pc[0], pc[1]), (0, 0, 1), (0, 1, 0), 19, 11, 0.0052, 0.0007, M["Grip"],
                    lambda a, b: inside_poly(panel, pc[0] + b, pc[1] + a)))
body.append(prism("gripcap", [(-0.0306, -0.1040), (-0.0698, -0.1070), (-0.0702, -0.1100), (-0.0312, -0.1072)], 0.0130, M["Dark"], 0.0008, 1))

# ---- The stock and the buffer tube -------------------------------------------------------------
# The tube from the tower to just inside the stock (right by the eye the game draws the stock's back flat at the
# camera's near edge, and a tube end behind it would show through), its position holes underneath; the end plate with
# a sling socket on the left, a castle nut with three notches.
body.append(lathe("tube", [(-0.0865, 0), (-0.0865, 0.0146), (-0.2090, 0.0146), (-0.2105, 0.0132), (-0.2105, 0)], M["Anod"], 18, (0, 0, B)))
for k in range(4):
    body.append(ring("tubehole", B - 0.01465, B - 0.0138, 0.0021, M["Dark"], (0, -0.115 - k * 0.0200, 0), 8, "z", 0))
body.append(prism("endplate", [(-0.0886, 0.0185), (-0.0866, 0.0185), (-0.0866, 0.0640), (-0.0886, 0.0640)], 0.0138, M["Phos"], 0.0004, 1))
body.append(block("qdboss", -0.0192, -0.0130, -0.0935, -0.0866, 0.0225, 0.0365, M["Phos"], 0.0008, 1))
body.append(lathe("qdsocket", [(-0.0194, 0.0022), (-0.0194, 0.0036), (-0.0186, 0.0036), (-0.0186, 0.0022)], M["Dark"], 14, (0, -0.0900, 0.0295), "x", loop=True))
body.append(ring("qdhole", -0.0193, -0.0188, 0.0022, M["Dark"], (0, -0.0900, 0.0295), 12, "x", 0))
castle = ring("castle", -0.0960, -0.0886, 0.0176, M["Phos"], (0, 0, B), 20, chamfer=0.0005)
notches = []
for a in (30, 150, 270):
    notches.append(turn_about_bore(dark(box(0.0150, 0.0200, -0.0935, -0.0880, B - 0.0021, B + 0.0021)), math.radians(a), B))
body.append(cut(castle, notches))
# The stock: a polymer body on the tube, wider towards the butt, a lightening window, a sling slot through its toe,
# the release lever under its front, a ribbed rubber pad.
sw = lambda y: 0.0172 if y > -0.25 else 0.0172 + (-0.25 - y) * 0.034  # its half width
stock_cuts = [prism("window", [(-0.284, 0.0175), (-0.331, 0.0185), (-0.333, -0.030), (-0.327, -0.036), (-0.318, -0.030)], 0.05, M["Dark"], 0)]
stock_cuts.append(prism("slingslot", [(b, a) for a, b in rounded(-0.068, -0.046, -0.3480, 0.0048)], 0.05, M["Dark"], 0))
for s in (-1, 1):  # a recess along each flank of the tube's housing, inside a rim
    stock_cuts.append(prism("inset", [(-0.214, 0.0340), (-0.338, 0.0365), (-0.338, 0.0600), (-0.214, 0.0590)], 0.0008, M["Dark"], 0, x=s * 0.0178))
body.append(prism("stock", [(-0.2000, 0.0655), (-0.2150, 0.0685), (-0.3300, 0.0705), (-0.3520, 0.0712), (-0.3600, 0.0700), (-0.3620, -0.0740),
                            (-0.3520, -0.0820), (-0.3360, -0.0800), (-0.3000, -0.0300), (-0.2620, 0.0140), (-0.2320, 0.0260), (-0.2000, 0.0270)],
                  sw, M["Polymer"], 0.0026, 2, cuts=stock_cuts))
# A rubber cheek pad along its top, ribbed across (the player looks down on it from the hip); a sling socket on its
# left flank; the cross screw that holds the housing's lock.
body.append(prism("cheek", [(-0.2320, 0.0680), (-0.3440, 0.0700), (-0.3440, 0.0738), (-0.3380, 0.0754), (-0.2400, 0.0736), (-0.2320, 0.0712)],
                  0.0142, M["Grip"], 0.0012, 1,
                  cuts=[dark(zbox(0, y, 0.04, 0.0016, 0.0726, 0.08, math.radians(-14))) for y in (-0.322, -0.308, -0.294, -0.280, -0.266, -0.252)]))
body.append(lathe("stockqd", [(-0.0200, 0.0024), (-0.0200, 0.0052), (-0.0186, 0.0052), (-0.0186, 0.0024)], M["Dark"], 14, (0, -0.300, 0.050), "x", loop=True))
body.append(ring("stockqdhole", -0.0199, -0.0190, 0.0024, M["Dark"], (0, -0.300, 0.050), 12, "x", 0))
for s in (-1, 1):
    body.append(screw(s * 0.0172, -0.2110, 0.0470, s, 0.0021))
body.append(prism("stocklever", [(-0.2110, 0.0275), (-0.2140, 0.0200), (-0.2440, 0.0180), (-0.2480, 0.0215), (-0.2450, 0.0262)], 0.0050, M["Dark"],
                  0.0008, 1))
body.append(ring("leverpin", -0.0060, 0.0060, 0.0016, M["Steel"], (0, -0.2135, 0.0245), 10, "x", 0.0003))
pad_cuts = [dark(box(-0.03, 0.03, -0.3800, -0.3755, z, z + 0.0024)) for z in (-0.060, -0.040, -0.020, 0.000, 0.020, 0.040)]
body.append(prism("pad", [(-0.3605, 0.0705), (-0.3735, 0.0712), (-0.3768, 0.0665), (-0.3768, -0.0775), (-0.3735, -0.0835), (-0.3560, -0.0822)],
                  0.0215, M["Grip"], 0.0025, 1, cuts=pad_cuts))

# ---- The handguard, the barrel, the muzzle ------------------------------------------------------
# Eight-sided, anodised, free of the barrel: the barrel nut at its back, the rail on its top, slots with round ends on
# the sides and underneath (7 by 32 mm, every 40 mm), narrow vents on the upper corners; through them the barrel, the
# gas block and its tube show. Two clamp screws on each side at its back.
hg_cuts = []
for k in range(7):
    y0 = 0.125 + k * 0.040
    for a in (0, 180, 270):
        hg_cuts.append(turn_about_bore(slot(y0, y0 + 0.032, 0.0070, 0.017, 0.032, B, mark=False, corner=0.0016), math.radians(a), B))
    for a in (45, 135):
        hg_cuts.append(turn_about_bore(slot(y0 + 0.006, y0 + 0.026, 0.0036, 0.017, 0.032, B, mark=False, steps=2), math.radians(a), B))
hg = lathe("handguard", [(0.1085, 0.0222), (0.1085, HG), (0.4355, HG), (0.4355, 0.0222)], M["Anod"], 8, (0, 0, B), turn=math.pi / 8, loop=True)
body.append(cut(bevel(hg, 0.0008, 1), hg_cuts))
body += rail("hgrail", 0.1095, 0.4345, RZ, skip=[(0.400, 0.434)])
for s in (-1, 1):
    body.append(screw(s * 0.0242, 0.1162, B + 0.0045, s, 0.0019))
    body.append(screw(s * 0.0242, 0.1162, B - 0.0045, s, 0.0019))
body.append(ring("barrelnut", 0.1040, 0.1250, 0.0168, M["Phos"], (0, 0, B), 20))
body.append(lathe("barrel", [(0.110, 0), (0.110, 0.0102), (0.300, 0.0098), (0.300, 0.0094), (0.5062, 0.0092), (0.5062, 0.0078), (0.5118, 0.0078),
                             (0.5122, 0.0036), (0.5116, 0.0028), (0.5000, 0.0028), (0.5000, 0)], [M["Phos"], M["Dark"]], 16, (0, 0, B),
                  seg_mat=[0, 0, 0, 0, 0, 0, 0, 1, 1, 1]))
gb = [(-0.0118, B - 0.0095), (-0.0095, B - 0.0118), (0.0095, B - 0.0118), (0.0118, B - 0.0095), (0.0118, B + 0.0135), (0.0095, B + 0.0158),
      (-0.0095, B + 0.0158), (-0.0118, B + 0.0135)]
body.append(xprism("gasblock", gb, 0.322, 0.348, M["Phos"], 0.0006, 1))
for y in (0.3285, 0.3415):
    body.append(ring("gbscrew", B - 0.0123, B - 0.0116, 0.0019, M["Dark"], (0, y, 0), 10, "z", 0))
body.append(lathe("gastube", [(0.088, 0), (0.088, 0.0023), (0.323, 0.0023), (0.323, 0)], M["Phos"], 8, (0, 0, B + 0.0135)))
# The crush washer, and the flash hider: a cage with five ports round its front (none underneath, so the blast doesn't
# kick up dust), the bore dark inside it.
body.append(knob("washer", 0.0118, 0.0112, 12, 0.5058, 0.5100, M["Dark"], (0, 0, B), "y", 0.0003))
fh = lathe("hider", [(0.5100, 0.0066), (0.5100, 0.0106), (0.5115, 0.0112), (0.5630, 0.0112), (0.5660, 0.0098), (0.5660, 0.0066)],
           [M["Phos"], M["Dark"]], 20, (0, 0, B), loop=True, seg_mat=[0, 0, 0, 0, 0, 1])
fh_cuts = [turn_about_bore(slot(0.5265, 0.5575, 0.0027, 0.004, 0.016, B, mark=False, steps=2), math.radians(a), B) for a in (90, 18, 162, 306, 234)]
body.append(cut(bevel(fh, 0.0004, 1), fh_cuts))
# Folding iron sights, folded flat on the rail: the front one at the handguard's end (a clamp, guard wings round the
# folded post), the rear one at the back of the receiver (a clamp, the folded aperture leaf, a windage knob on its right).
body.append(block("fbase", -0.0115, 0.0115, 0.4035, 0.4300, 0.0755, 0.0850, M["Dark"], 0.0010, 1))
for s in (-1, 1):
    body.append(block("fwing", s * 0.0085, s * 0.0058, 0.3880, 0.4040, 0.0812, 0.0880, M["Dark"], 0.0006, 1))
body.append(block("fleaf", -0.0042, 0.0042, 0.3870, 0.4040, 0.0812, 0.0846, M["Dark"], 0.0005, 1))
body.append(block("fpost", -0.0011, 0.0011, 0.3880, 0.3960, 0.0846, 0.0858, M["Dark"], 0.0003, 1))
body.append(ring("fscrew", 0.0115, 0.0132, 0.0024, M["Steel"], (0, 0.4170, 0.0790), 12, "x", 0.0003))
body.append(block("rbase", -0.0115, 0.0115, -0.0680, -0.0460, 0.0755, 0.0850, M["Dark"], 0.0010, 1))
body.append(block("rleaf", -0.0080, 0.0080, -0.0460, -0.0300, 0.0812, 0.0846, M["Dark"], 0.0005, 1))
body.append(lathe("raperture", [(0.0846, 0.0018), (0.0846, 0.0034), (0.0856, 0.0034), (0.0856, 0.0018)], M["Dark"], 14, (0, -0.0360, 0), "z", loop=True))
body.append(knob("rknob", 0.0040, 0.0035, 12, 0.0115, 0.0150, M["Dark"], (0, -0.0570, 0.0810), "x", 0.0004))
body.append(ring("rscrew", -0.0132, -0.0115, 0.0024, M["Steel"], (0, -0.0570, 0.0790), 12, "x", 0.0003))

# ---- The red-dot sight -------------------------------------------------------------------------
# A tube on a one-piece mount: the rail clamp (jaws round the rail's dovetail, the cross bolt's nut on the right and
# its head on the left), a short riser, a ring round the tube held by four cap screws. The tube is hollow (dark inside):
# a window at each end, the dot on the back of the front one; the elevation cap on top and the windage cap on the
# right, each on its boss, with click ridges; a ridged brightness knob on the left; a sunshade's flare at the front.
OZ = DOT[2]
# Aimed, you look at the mount's back under the tube: the clamp's edges broad and bevelled to catch the light, the riser
# a tapered neck with a window through it, its back face sloping away from you.
optic.append(block("oclamp", -0.0128, 0.0128, -0.0080, 0.0240, 0.0790, 0.0855, M["Dark"], 0.0016, 2))
for s in (-1, 1):
    optic.append(block("ojaw", s * 0.0108, s * 0.0130, -0.0080, 0.0240, 0.0752, 0.0800, M["Dark"], 0.0004, 1))
optic.append(ring("onut", 0.0128, 0.0156, 0.0044, M["Steel"], (0, 0.0080, 0.0778), 6, "x", 0.0004))
optic.append(ring("obolt", -0.0146, -0.0128, 0.0030, M["Dark"], (0, 0.0080, 0.0778), 12, "x", 0.0003))
optic.append(xprism("oriser", [(-0.0110, 0.0845), (0.0110, 0.0845), (0.0072, OZ - 0.0180), (-0.0072, OZ - 0.0180)], -0.0030, 0.0150, M["Dark"], 0.0006, 1,
                    cuts=[dark(box(-0.02, 0.02, 0.0020, 0.0100, 0.0860, OZ - 0.0196))]))
optic.append(prism("oriserback", [(-0.0030, 0.0845), (-0.0030, OZ - 0.0180), (-0.0072, 0.0845)], 0.0090, M["Dark"], 0.0004, 1))
optic.append(lathe("oring", [(-0.0040, 0.0184), (-0.0040, 0.0204), (0.0160, 0.0204), (0.0160, 0.0184)], M["Dark"], 24, (0, 0, OZ), loop=True))
for s in (-1, 1):
    for y in (0.0010, 0.0110):
        optic.append(screw(s * 0.0203, y, OZ, s, 0.0016))
optic.append(lathe("otube", [(-0.0168, 0.0160), (-0.0168, 0.0176), (-0.0156, 0.0185), (0.0440, 0.0185), (0.0462, 0.0193), (0.0548, 0.0193),
                             (0.0558, 0.0186), (0.0558, 0.0168), (0.0470, 0.0162), (0.0420, 0.0160)],
                   [M["Anod"], M["Dark"]], 24, (0, 0, OZ), loop=True, seg_mat=[0, 0, 0, 0, 0, 0, 0, 1, 1, 1]))
optic.append(lathe("orear", [(-0.0172, 0.0158), (-0.0172, 0.0182), (-0.0160, 0.0182), (-0.0160, 0.0158)], M["Dark"], 24, (0, 0, OZ), loop=True))
optic.append(lathe("owindowR", [(-0.0150, 0), (-0.0150, 0.0161), (-0.0146, 0.0161), (-0.0146, 0)], M["Lens"], 24, (0, 0, OZ)))
optic.append(lathe("owindow", [(0.0400, 0), (0.0400, 0.0161), (0.0404, 0.0161), (0.0404, 0)], M["Lens"], 24, (0, 0, OZ)))
optic.append(lathe("odot", [(0.0, 0), (0.0, 0.0008), (0.0003, 0)], M["RedDot"], 10, (0, 0.0396, OZ)))
TY = 0.0300  # the caps' place along the tube
optic.append(ring("obossT", OZ + 0.0120, OZ + 0.0196, 0.0078, M["Anod"], (0, TY, 0), 20, "z", 0.0005))
optic.append(knob("ocapT", 0.0071, 0.0065, 12, OZ + 0.0194, OZ + 0.0252, M["Anod"], (0, TY, 0), "z"))
optic.append(ring("obossR", 0.0120, 0.0196, 0.0078, M["Anod"], (0, TY, OZ), 20, "x", 0.0005))
optic.append(knob("ocapR", 0.0071, 0.0065, 12, 0.0194, 0.0252, M["Anod"], (0, TY, OZ), "x"))
optic.append(ring("obossL", -0.0196, -0.0120, 0.0082, M["Anod"], (0, TY, OZ), 20, "x", 0.0005))
optic.append(knob("obright", 0.0090, 0.0082, 14, -0.0262, -0.0194, M["Dark"], (0, TY, OZ), "x"))

# ---- The magazine ------------------------------------------------------------------------------
# Polymer, curved, 30 rounds: ribs round its lower half for the hand, a raised panel on each side above them, a base
# plate that flares out.
front = [(0.099, 0.006), (0.101, -0.04), (0.106, -0.08), (0.114, -0.12), (0.124, -0.16), (0.132, -0.185)]
back = [(0.036, 0.006), (0.038, -0.045), (0.044, -0.09), (0.054, -0.13), (0.066, -0.17), (0.075, -0.197)]


mag.append(prism("mag", front + list(reversed(back)), 0.0112, M["Polymer"], 0.0015, 2))
for k in range(4):
    z = -0.128 - k * 0.0115
    mag.append(prism("magrib", [(edge_at(back, z) + 0.002, z), (edge_at(front, z) - 0.002, z), (edge_at(front, z - 0.0034) - 0.002, z - 0.0034),
                                (edge_at(back, z - 0.0034) + 0.002, z - 0.0034)], 0.0118, M["Polymer"], 0.0006, 1))
mpanel = [(edge_at(back, -0.058) + 0.006, -0.058), (edge_at(front, -0.058) - 0.006, -0.058), (edge_at(front, -0.112) - 0.006, -0.112),
          (edge_at(back, -0.112) + 0.006, -0.112)]
for s in (-1, 1):
    mag.append(prism("magpanel", mpanel, 0.0005, M["Polymer"], 0.0003, 1, x=s * 0.0114))
mag.append(prism("magbase", [(0.1338, -0.1780), (0.1392, -0.1915), (0.0772, -0.2088), (0.0700, -0.1960)], 0.0131, M["Polymer"], 0.0020, 2))
mag.append(prism("magtab", [(0.1360, -0.1840), (0.1430, -0.1880), (0.1410, -0.1935), (0.1380, -0.1915)], 0.0090, M["Polymer"], 0.0006, 1))

# ---- Paintball's kit, the hands ----------------------------------------------------------------
kit = hopper(-0.064, 0.12, 0.052, 0.042, side=UH) + tank(0.37, 0.50, 0.016, (0, B - HG - 0.018))
# The right hand round the grip as before (tools/weapons.py build_rifle), its thumb a little further out over the
# selector (as the laser rifle's): it rests on the lever, as a shooter's does. The left hand under the handguard, palm
# up, as before: the handguard has the same size.
gw = H["Wrap"]((0, -0.027, -0.001), (0, -0.026, -0.1), (0, 1, 0), 0.0215, 0.0148)
handR = H["hand"]("rifle_handR", gw,
                  [(0.034, 70, -1, 0.09, 0.0098, 0.0), (0.054, 72, -1, 0.086, 0.0094, 0.0), (0.073, 76, -1, 0.07, 0.0086, 0.0)],
                  [], (0.012, -0.10, -0.035), (0.25, -0.82, -0.5),
                  ([(-0.006, -0.05, 0.004), (-0.024, -0.03, 0.012), (-0.028, -0.008, 0.02), (-0.027, 0.014, 0.026), (-0.024, 0.03, 0.029)], 0.0105),
                  ([gw.at(0.01, 72, 0.01), (0.02, 0.0, -0.004), (0.016, 0.014, -0.006), (0.009, 0.017, -0.008), (0.004, 0.015, -0.01)], 0.0095))
hw = H["Wrap"]((0, 0.30, B), (0, 1, 0), (0, 0, -1), HG, HG)
handL = H["hand"]("rifle_handL", H["Wrap"]((0, 0.30, B), (0, -1, 0), (0, 0, -1), HG, HG),
                  [(-0.03, 13, 1, 0.062, 0.0098, -0.6), (-0.009, 38, 1, 0.064, 0.0096, -0.6), (0.012, 50, 1, 0.058, 0.009, -0.6),
                   (0.031, 59, 1, 0.048, 0.0084, -0.6)],
                  [], (-0.012, 0.225, B - 0.055), (-0.35, -0.5, -0.79),
                  ([hw.at(-0.03, 40, 0.016), hw.at(0.0, 65, 0.012), hw.at(0.025, 80, 0.011), hw.at(0.048, 88, 0.011), hw.at(0.066, 92, 0.011)], 0.0108),
                  side=-1)

ROOT = finish("rifle", GRIP, body, {"mag": (mag, (0, 0.068, 0.0), {"out": (0, 0.06, -1)}), "optic": (optic, (0, 0.0, 0.0795))},
              MUZZLE, DOT, kit, [handR, handL])
__import__("farcopy").far(ROOT)  # the light copy the others' figures and the pickups use (tools/guns/farcopy.py)
export(ROOT, OUT)

if PREVIEW:
    g = lambda x, y, z: Vector((x, y, z)) - GRIP  # a design point in the GLB's place (the grip at the origin)
    previews(ROOT, "rifle", PREVIEW, g(0, 0.095, 0.0), 0.95, (0.05, -0.045, -0.095), ads=(0.352, 46.8), closeups=[
        ("receiverL", g(-0.26, 0.00, 0.10), g(0, 0.01, 0.02), 50),
        ("receiverR", g(0.26, 0.02, 0.10), g(0, 0.03, 0.03), 50),
        ("muzzle", g(-0.10, 0.66, 0.10), g(0, 0.53, 0.048), 50),
        ("optic", g(-0.10, -0.14, 0.16), g(0, 0.02, 0.10), 50),
        ("stock", g(-0.24, -0.22, 0.10), g(0, -0.25, 0.0), 50),
    ])
