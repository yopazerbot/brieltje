"""Build the pistol in Blender, with the gloved hands that hold it in first person.

Run (Blender 5, no window):
  blender -b -P tools/guns/pistol.py -- <out.glb> [preview_dir]
It writes the GLB (web/public/models/gun-pistol.glb in the repository); the game takes the pistol from it instead of
from weapons.glb (weapon.ts GUN_FILES), and weapons.glb keeps its old pistol as the fallback. With preview_dir it also
renders small pictures there (tools/guns/shop.py previews).

Our own design, no brand, maker or marking on it: a polymer-framed 9 mm service pistol, 185 mm long (the common
compact's length), a 24 mm slide over a 24 mm frame, a 9 mm bore in a 12 mm barrel; its grip, and so its height (154
mm with the magazine), the old pistol's, which the hands are posed on.
From the top: a matt black slide with rounded top edges, slanted grooves at its back and its front (the serrations),
a front chamfered in plan and in profile, the ejection port on the right with the barrel's hood filling it and the
extractor behind it, the barrel's crown and the recoil spring's guide rod in its nose, three-dot sights in dovetails (a
notched rear sight, a front blade). Its back, which is what you see when you aim: upright grooves across the rear face
that cut the glare, a plate over the striker with the striker's indicator at its top, and a channel down the middle of
the top from the rear sight to the front sight. The frame: a dust cover with a rail of
three slots, the trigger guard with a square front, a trigger with its safety blade, the slide stop over the trigger
on the left with its pin's end on the right, the takedown lever ahead of it on the left, the magazine release behind
the trigger guard on the left, sunk in a recess; two cross pins; a grip with a beavertail, stippled sides as fine
raised points, raised bands across the backstrap, a seam where the backstrap fits, a lanyard hole at its foot. The magazine: a steel body with witness
holes, a round on top, a polymer base pad with a lip at the front. The slide moves (it kicks back with each shot and
stays back when empty, showing the barrel and the spring in the nose and the open chamber in the port); the
magazine leaves on a reload.

Frame and nodes as tools/weapons.py's pistol, so the page reads it the same: the barrel along -z, up +y, right +x,
metres, the origin where the web of the right hand sits on the grip. pistol (an empty), pistol_body, pistol_slide
(pivot as before), pistol_mag (extras "out"), pistol_muzzle (the crown), pistol_sight (the front sight's top),
pistol_kit (Paintball's air cartridge, as before), pistol_hands with pistol_handR and pistol_handL (weapons.py's own
poses: the grip, the trigger and the frame's lines are those of the pistol in weapons.py). The materials are
weapons.py's names (Steel, Dark, Polymer, Grip, Dot, Brass), so the game's finish and the paint look take them:
the sights, the levers and the magazine's body Dark, the frame and the magazine's base Polymer, the barrel, the guide
rod and the pins Steel, the stippling Grip; the slide has a name of its own, PistolSlide (a glossier black than Dark,
so it stands apart from the matt frame; gunSurface.ts and weapon.ts ROLE have its entries). Inside Blender the barrel runs along +y and up is +z; the exporter turns that into the above.
"""
import math
import os
import sys

import bpy

bpy.ops.wm.read_factory_settings(use_empty=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shop as S  # noqa: E402
from shop import M, block, box, chamfers, cut, dark, finish, lathe, material, prism, ring, sweep, zbox  # noqa: E402
from mathutils import Vector  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

# The colours are the game's finish for these names (gunSurface.ts LOOKS); the preview shows them so.
M.update({
    "Steel": material("Steel", "#4d5056", 0.3, 1.0),     # the barrel, the guide rod, the pins, the extractor
    "Slide": material("PistolSlide", "#2b2e33", 0.26, 0.85),  # the slide: black nitride with a soft gloss (its own finish in the game)
    "Dark": material("Dark", "#2a2c30", 0.42, 0.7),      # the sights, the levers, the magazine's body, the insides of cuts
    "Polymer": material("Polymer", "#232426", 0.6, 0.0),  # the frame, the trigger, the magazine's base pad
    "Grip": material("Grip", "#202123", 0.88, 0.0),      # the stippling
    "Dot": material("Dot", "#e8e4d0", 0.4, 0.0),          # the sights' white dots
    "Brass": material("Brass", "#b08a3e", 0.3, 0.9),      # the round on top of the magazine
    "Tank": material("Tank", "#dfe3e8", 0.3, 0.5),       # Paintball's kit
    "KitTrim": material("KitTrim", "#ffd23f", 0.4, 0.0),
    "Glove": material("Glove", "#26272a", 0.82, 0.0),     # the hands, as tools/weapons.py makes them
    "GloveTrim": material("GloveTrim", "#23251f", 0.8, 0.0),
    "Sleeve": material("Sleeve", "#4b4c3b", 0.9, 0.0),
})

B = 0.024                # the bore's axis height
GRIP = (0, -0.023, -0.004)
MUZZLE = (0, 0.152, B)       # the flash's place, as before (the crown is at 0.1505)
SIGHT = (0, 0.139, 0.047)
FH = 0.0119              # the frame's half width at the dust cover
SH = 0.0122              # the slide's
GH = 0.0142              # the grip's
body = []

# ---- The frame -------------------------------------------------------------------------------
# The dust cover and the frame's upper line, 0.4 mm under the slide (a seam where they meet), its front slanted.
body.append(prism("frame", [(-0.034, 0.0088), (0.1455, 0.0088), (0.1455, 0.0035), (0.1415, -0.0035), (0.128, -0.0058), (0.074, -0.008), (0.024, -0.008),
                            (0.008, -0.004), (-0.012, 0.0), (-0.034, 0.004)], FH, M["Polymer"], 0.0012, 2))
# The rail under the dust cover: a neck and a head with three cross slots at the standard 10 mm pitch.
body.append(prism("railneck", [(0.097, -0.0040), (0.139, -0.0040), (0.139, -0.0078), (0.097, -0.0078)], 0.0072, M["Polymer"], 0.0005, 1))
body.append(prism("rail", [(0.097, -0.0072), (0.1395, -0.0072), (0.1395, -0.0105), (0.097, -0.0105)], 0.0101, M["Polymer"], 0.0007, 2,
                  cuts=chamfers(0.0101, -0.0072, -0.0105, 0.0016, 0.0008, 0.09, 0.15) + [dark(box(-0.02, 0.02, y, y + 0.0052, -0.0112, -0.0083)) for y in (0.1025, 0.1125, 0.1225)]))
# The grip, 18 degrees back, its beavertail over the web of the hand (weapons.py's lines: the hands are posed on them).
# The magazine well cut into its foot, a lanyard hole through the backstrap, the backstrap's seam on each side, the
# magazine release's recess on the left.
# Its top a level ledge under the frame from the trigger guard back to the beavertail (the thumb rests over it).
GRIP_PTS = [(0.0245, 0.0015), (0.0245, -0.004), (0.020, -0.030), (0.0165, -0.052), (0.012, -0.076), (0.008, -0.098), (-0.041, -0.098), (-0.037, -0.07),
            (-0.031, -0.04), (-0.026, -0.016), (-0.029, -0.004), (-0.04, 0.004), (-0.036, 0.008), (-0.016, 0.008), (-0.0105, 0.0015)]
seam = [(-0.0215, -0.006), (-0.0245, -0.030), (-0.0290, -0.058), (-0.0335, -0.084), (-0.0352, -0.0985)]
grip_cuts = [dark(prism("well", [(0.0110, -0.080), (0.0002, -0.1), (-0.0347, -0.1), (-0.0300, -0.080)], 0.0107, M["Dark"], 0))]
grip_cuts.append(dark(lathe("lanyard", [(-0.03, 0), (-0.03, 0.0015), (0.03, 0.0015), (0.03, 0)], M["Dark"], 10, (0, -0.0365, -0.0915), "x")))
for s in (-1, 1):
    strip = [(y + 0.0004, z) for y, z in seam] + [(y - 0.0004, z) for y, z in reversed(seam)]
    grip_cuts.append(dark(prism("seam", strip, 0.0006, M["Dark"], 0, x=s * GH)))
REL = [(0.0105, -0.0125), (0.0185, -0.0125), (0.0195, -0.0115), (0.0195, -0.0055), (0.0185, -0.0045), (0.0105, -0.0045), (0.0095, -0.0055), (0.0095, -0.0115)]
rel_c = (0.0145, -0.0085)
grip_cuts.append(dark(prism("relrecess", [(rel_c[0] + (y - rel_c[0]) * 1.3, rel_c[1] + (z - rel_c[1]) * 1.3) for y, z in REL], 0.0008, M["Dark"], 0, x=-GH)))
grip = prism("grip", GRIP_PTS, GH, M["Polymer"], 0.003, 2, cuts=grip_cuts)
body.append(grip)
# Stippling: fine raised points over each side of the grip, inside the hand's reach of the edges.
STIP = [(0.0175, -0.024), (0.0063, -0.088), (-0.0315, -0.088), (-0.0265, -0.058), (-0.021, -0.024)]
for s in (-1, 1):
    body.append(S.texture("stipple", grip, STIP, s, M["Grip"], pitch=0.0029, height=0.00042))
# A palm stop in the grip's front strap under the trigger guard, finely grooved across.
for k in range(7):
    z = -0.030 - k * 0.0072
    yf = 0.0245 + (0.008 - 0.0245) * (-0.004 - z) / 0.094
    body.append(block("strapgroove", -0.0095, 0.0095, yf - 0.0006, yf + 0.0004, z, z + 0.0028, M["Grip"], 0.0003, 1))
# The backstrap, which you look down on when you aim: raised bands across it under the beavertail, each catching a line
# of light (the grip's texture where the web of the hand sits).
for k in range(14):
    z = -0.013 - k * 0.0038
    yb = -0.026 + (-0.037 + 0.026) * (-0.016 - z) / 0.054 if z < -0.016 else -0.026
    body.append(block("backgroove", -0.0096, 0.0096, yb - 0.0005, yb + 0.0005, z - 0.0008, z + 0.0008, M["Grip"], 0.0003, 1))


def trigger_guard(name, y0, y1, ztop, zbot, half, t=0.0042):
    """The guard: a square front, a flat bottom, the rear swept into the grip."""
    pts = [(y0 - 0.006, ztop - 0.012), (y0, zbot + 0.004), (y0 + 0.006, zbot), (y1 - 0.003, zbot), (y1, zbot + 0.003), (y1, ztop),
           (y1 - t, ztop), (y1 - t, zbot + t + 0.002), (y1 - t - 0.002, zbot + t), (y0 + 0.007, zbot + t), (y0 + t, zbot + t + 0.004), (y0 - 0.006 + t, ztop - 0.012)]
    return prism(name, pts, half, M["Polymer"], 0.0009, 2)


body.append(trigger_guard("guard", 0.022, 0.074, -0.004, -0.033, 0.0075))
# The trigger: a curved blade, its face hollowed, and the safety blade standing out of a slot in its face.
trig = [(0.0412, -0.006), (0.0460, -0.006), (0.0442, -0.013), (0.0446, -0.020), (0.0466, -0.0245), (0.0436, -0.0245), (0.0412, -0.019), (0.0406, -0.012)]
body.append(prism("trigger", trig, 0.0034, M["Polymer"], 0.0006, 1, cuts=[box(-0.0009, 0.0009, 0.0425, 0.05, -0.0236, -0.0125)]))
body.append(prism("safety", [(0.0432, -0.0128), (0.0450, -0.0128), (0.0451, -0.0195), (0.0472, -0.0236), (0.0446, -0.0236), (0.0426, -0.0195)], 0.0008,
                  M["Steel"], 0.0003, 1))
# The slide stop on the left over the trigger, just under the slide: a long lever with a ribbed thumb tab at its back,
# its pin through the frame to a round end on the right. The takedown lever ahead of it on the left, a round boss
# with a short arm; on the right its spindle's end. Two cross pins over the trigger and ahead of it.
body.append(prism("slidestop", [(0.012, 0.0032), (0.040, 0.0032), (0.0425, 0.0052), (0.0415, 0.0083), (0.012, 0.0083), (0.010, 0.0060)], 0.0007,
                  M["Dark"], 0.0003, 1, x=-FH - 0.0006))
body.append(prism("stoptab", [(0.0105, 0.0030), (0.0205, 0.0030), (0.0215, 0.0086), (0.0105, 0.0086), (0.0095, 0.0060)], 0.0008, M["Dark"], 0.0004, 1,
                  x=-FH - 0.0017))
for k in range(3):
    body.append(block("stopridge", -FH - 0.0029, -FH - 0.0023, 0.0122 + k * 0.0028, 0.0136 + k * 0.0028, 0.0036, 0.0080, M["Dark"], 0.0002, 1))
body.append(S.screw(-FH - 0.0012, 0.0385, 0.0060, -1, 0.0017, M["Steel"], 10))
body += S.pin(FH, 0.0385, 0.0060, 1, 0.0018)
body.append(ring("takedown", -FH - 0.0011, -FH, 0.0038, M["Dark"], (0, 0.064, 0.0028), 16, "x", 0.0003))
body.append(prism("takearm", [(0.0615, 0.0010), (0.0665, 0.0010), (0.0700, -0.0050), (0.0670, -0.0058)], 0.0005, M["Dark"], 0.0002, 1, x=-FH - 0.0008))
body += S.pin(FH, 0.064, 0.0028, 1, 0.0026, M["Dark"])
for y, z in ((0.0465, 0.0005), (0.0805, 0.0020)):
    for s in (-1, 1):
        body += S.pin(s * FH, y, z, s, 0.0015)
# The magazine release, left, behind the trigger guard: a rounded button standing 1.2 mm out of its recess, ribbed.
body.append(prism("release", REL, 0.0009, M["Dark"], 0.0004, 1, x=-GH - 0.0003))
for k in range(3):
    body.append(block("relrib", -GH - 0.0015, -GH - 0.0011, 0.0115 + k * 0.0027, 0.0125 + k * 0.0027, -0.0115, -0.0055, M["Dark"], 0.0001, 1))

# ---- The barrel and the recoil spring (they stay as the slide moves) ---------------------------
# The barrel: its hood fills the ejection port flush with the slide's top, the open chamber at its back; out front
# the crowned muzzle and the bore. The guide rod under it with its spring; their ends show in the slide's nose.
body.append(lathe("barrel", [(0.033, 0), (0.033, 0.0058), (0.1488, 0.0058), (0.1505, 0.0051), (0.1505, 0.0046), (0.1470, 0.0045), (0.1470, 0)],
                  [M["Steel"], M["Dark"]], 24, (0, 0, B), seg_mat=[0, 0, 0, 0, 1, 1]))
body.append(block("hood", -0.0080, 0.0080, 0.0318, 0.0658, 0.0178, 0.0391, M["Steel"], 0.0006, 2))
body.append(lathe("chamber", [(0.0312, 0), (0.0312, 0.0049), (0.0320, 0.0049), (0.0320, 0)], M["Dark"], 16, (0, 0, B)))
body.append(lathe("guiderod", [(0.06, 0), (0.06, 0.0021), (0.1455, 0.0021), (0.1458, 0.0033), (0.1492, 0.0033), (0.1495, 0.0026), (0.1495, 0)],
                  M["Steel"], 14, (0, 0, 0.0135)))
coil = []
turns, per = 9, 6
for i in range(turns * per + 1):
    a = 2 * math.pi * i / per
    coil.append((0.0029 * math.cos(a), 0.106 + (0.1450 - 0.106) * i / (turns * per), 0.0135 + 0.0029 * math.sin(a)))
body.append(sweep("spring", coil, [0.00055] * len(coil), M["Dark"], 4))

# ---- The slide (it moves) ----------------------------------------------------------------------
SLANT = 0.18  # the serrations lean forward this much per unit of height
slide_cuts = chamfers(SH, 0.0395, 0.0092, 0.0032, 0.0008, -0.05, 0.16)
slide_cuts += [zbox(s * SH, 0.150, 0.0042 * math.sqrt(2), 0.0042 * math.sqrt(2), 0.0, 0.05, math.radians(45)) for s in (-1, 1)]
for s in (-1, 1):
    for y in [-0.0318 + k * 0.0034 for k in range(8)] + [0.0960 + k * 0.0034 for k in range(6)]:
        slide_cuts.append(dark(prism("serration", [(y, 0.0126), (y + 0.0013, 0.0126), (y + 0.0013 + 0.022 * SLANT, 0.0346), (y + 0.022 * SLANT, 0.0346)],
                                     0.0007, M["Dark"], 0, x=s * SH)))
slide_cuts.append(dark(box(-0.0086, 0.02, 0.0312, 0.0662, 0.0228, 0.05)))   # the ejection port
slide_cuts.append(dark(lathe("borehole", [(0.06, 0), (0.06, 0.0061), (0.16, 0.0061), (0.16, 0)], M["Dark"], 20, (0, 0, B))))
slide_cuts.append(dark(lathe("rodhole", [(0.10, 0), (0.10, 0.0039), (0.16, 0.0039), (0.16, 0)], M["Dark"], 14, (0, 0, 0.0135))))
slide_cuts.append(dark(box(-0.0068, 0.0068, -0.040, -0.0345, 0.0128, 0.0272)))  # the striker plate's recess
# The slide's rear face, seen whole when you aim: above the plate and beside it, upright grooves that cut the glare
# (each catches a line of light), and a channel down the middle of its top from the rear sight to the front sight,
# a dark line that runs away from you to the front sight.
for k in range(11):
    x = -0.009 + k * 0.0018
    if abs(x) < 0.0078:
        slide_cuts.append(dark(box(x - 0.00035, x + 0.00035, -0.040, -0.0346, 0.0290, 0.0372)))
    else:
        slide_cuts.append(dark(box(x - 0.00035, x + 0.00035, -0.040, -0.0346, 0.0118, 0.0372)))
slide_cuts.append(dark(box(-0.0012, 0.0012, -0.0186, 0.1332, 0.0389, 0.0400)))
slide_cuts.append(dark(box(0.0114, 0.013, 0.0035, 0.0312, 0.0250, 0.0306)))     # the extractor's slot
slide = [prism("slide", [(-0.035, 0.0092), (0.1475, 0.0092), (0.1500, 0.0122), (0.1500, 0.0360), (0.1470, 0.0395), (-0.0310, 0.0395), (-0.0350, 0.0355)],
               SH, M["Slide"], 0.0009, 2, cuts=slide_cuts)]
slide.append(prism("extractor", [(0.0040, 0.0256), (0.0306, 0.0256), (0.0310, 0.0268), (0.0306, 0.0300), (0.0040, 0.0300)], 0.0005, M["Steel"], 0.0002, 1,
                   x=SH - 0.0001))
slide.append(block("plate", -0.0062, 0.0062, -0.0352, -0.0343, 0.0134, 0.0266, M["Polymer"], 0.0005, 1))
# The striker's indicator: a steel tab standing out of a slot at the plate's top when the gun is cocked.
slide.append(block("indicator", -0.0011, 0.0011, -0.0357, -0.0343, 0.0240, 0.0258, M["Steel"], 0.0003, 1))
# The rear sight: a dovetailed block, a ramp in front, a square notch, two white dots on its back face.
slide.append(block("dovetail", -0.0094, 0.0094, -0.0290, -0.0192, 0.0386, 0.0399, M["Dark"], 0.0003, 1))
slide.append(prism("rearsight", [(-0.0298, 0.0390), (-0.0188, 0.0390), (-0.0188, 0.0414), (-0.0222, 0.0470), (-0.0298, 0.0470)], 0.0088, M["Dark"], 0.0005, 2,
                   cuts=[box(-0.0021, 0.0021, -0.031, -0.017, 0.0425, 0.05)]))
for s in (-1, 1):
    slide.append(ring("reardot", -0.0301, -0.0297, 0.0011, M["Dot"], (s * 0.0055, 0, 0.0447), 10, chamfer=0.0001))
# The front sight: a blade in its own dovetail, its top on the line of sight, its white dot facing you.
slide.append(prism("frontsight", [(0.1338, 0.0390), (0.1438, 0.0390), (0.1426, 0.0472), (0.1352, 0.0472), (0.1338, 0.0458)], 0.0016, M["Dark"], 0.0004, 1))
slide.append(block("frontbase", -0.0036, 0.0036, 0.1330, 0.1445, 0.0388, 0.0399, M["Dark"], 0.0003, 1))
slide.append(ring("frontdot", 0.1334, 0.1339, 0.0011, M["Dot"], (0, 0, 0.0443), 10, chamfer=0.0001))

# ---- The magazine (it leaves to reload) --------------------------------------------------------
rear_y = lambda z: -0.0215 - 0.012 * ((-0.004 - z) / 0.0945)  # the body's back edge at height z
mag_cuts = [dark(lathe("witness", [(-0.02, 0), (-0.02, 0.0011), (0.02, 0.0011), (0.02, 0)], M["Dark"], 8, (0, rear_y(z) + 0.0048, z), "x"))
            for z in (-0.036, -0.050, -0.064, -0.078)]
mag = [prism("magbody", [(0.0115, -0.004), (-0.0005, -0.0985), (-0.0335, -0.0985), (-0.0215, -0.004)], 0.0104, M["Dark"], 0.0008, 1, cuts=mag_cuts)]
mag.append(lathe("round", [(-0.0195, 0), (-0.0195, 0.0046), (-0.0185, 0.0049), (-0.0010, 0.0049), (0.0010, 0.0046), (0.0060, 0.0038), (0.0090, 0.0020),
                           (0.0098, 0)], M["Brass"], 12, (0, 0, -0.0012)))
mag.append(prism("magbase", [(0.0108, -0.0975), (0.0104, -0.1040), (0.0084, -0.1065), (-0.0390, -0.1065), (-0.0418, -0.1040), (-0.0408, -0.0975)], 0.0138,
                 M["Polymer"], 0.0014, 2, cuts=[dark(box(s * 0.0138 - 0.0005, s * 0.0138 + 0.0005, -0.050, 0.02, -0.0993, -0.0987)) for s in (-1, 1)]))
ax = Vector((0, -0.017, -0.095))

# Paintball: a small air cartridge under the dust cover (as weapons.py's).
kit = [lathe("tank", [(0.06, 0), (0.062, 0.006), (0.066, 0.0095), (0.072, 0.0105), (0.135, 0.0105), (0.141, 0.009), (0.145, 0.0)],
             M["Tank"], 14, (0, 0, -0.022)),
       lathe("ring", [(0.07, 0), (0.07, 0.0115), (0.077, 0.0115), (0.077, 0)], M["KitTrim"], 14, (0, 0, -0.022))]

# ---- The hands: tools/weapons.py's pistol hands, posed on the same grip ------------------------
H = S.hands_kit()
Wrap, hand = H["Wrap"], H["hand"]
gw = Wrap((0, -0.0005, -0.006), (0, -0.017, -0.092), (0, 1, 0), 0.0245, 0.0148)
right = hand("pistol_handR", gw,
             [(0.034, 25, -1, 0.068, 0.0098, 0.0), (0.054, 27, -1, 0.063, 0.0094, 0.0), (0.073, 31, -1, 0.046, 0.0086, 0.0)],
             [gw.at(0.022, 95, 0.004), gw.at(0.085, 100, 0.004), gw.at(0.022, 150, 0.004), gw.at(0.085, 150, 0.006),
              gw.at(0.02, 200, 0.002), gw.at(0.07, 185, 0.004), gw.at(0.03, 95, 0.026), gw.at(0.07, 100, 0.026)],
             (0.012, -0.075, -0.042), (0.45, -0.55, -0.7),
             ([(-0.006, -0.026, -0.0), (-0.021, -0.008, 0.0015), (-0.0255, 0.016, 0.003), (-0.025, 0.040, 0.0035), (-0.023, 0.058, 0.004)], 0.0105),
             ([gw.at(0.012, 60, 0.01), (0.021, 0.028, -0.011), (0.017, 0.044, -0.015), (0.009, 0.0475, -0.019), (0.004, 0.045, -0.022)], 0.0095))
lw = Wrap((0, -0.0005, -0.006), (0, -0.017, -0.092), (0, 1, 0), 0.0245 + 0.016, 0.0148 + 0.017)
left = hand("pistol_handL", lw,
            [(0.028, -53, 1, 0.09, 0.0098, 0.0), (0.051, -54, 1, 0.085, 0.0096, 0.0), (0.071, -59, 1, 0.075, 0.009, 0.0), (0.091, -69, 1, 0.055, 0.0084, 0.0)],
            [lw.at(0.03, -100, 0.0), lw.at(0.09, -105, 0.0), lw.at(0.03, -150, 0.0), lw.at(0.09, -150, 0.0),
             lw.at(0.035, -110, 0.024), lw.at(0.085, -115, 0.024), (-0.05, -0.05, -0.02)],
            (-0.045, -0.072, -0.068), (-0.5, -0.5, -0.7),
            ([(-0.045, -0.02, -0.035), (-0.036, 0.0, -0.02), (-0.031, 0.022, -0.017), (-0.029, 0.045, -0.016), (-0.028, 0.062, -0.016)], 0.0108),
            side=-1)

ROOT = finish("pistol", GRIP, body, {"slide": (slide, (0, 0.06, B)), "mag": (mag, (0, -0.012, -0.004), {"out": ax})},
              MUZZLE, SIGHT, kit, [right, left])
__import__("farcopy").far(ROOT)  # the light copy the others' figures and the pickups use (tools/guns/farcopy.py)
H["drop_arms"]()
S.bake_shade(ROOT)
S.export(OUT)

if PREVIEW:
    C = Vector((0, 0.045, 0.0))  # about the middle of the gun, grip at the origin
    hx, hy, hz = 0.048, -0.04, -0.1
    hip_far = math.tan(math.radians(36)) / math.tan(math.radians(27))
    s = Vector(SIGHT) - Vector(GRIP)
    S.previews("pistol", ROOT, [right, left], PREVIEW, C,
               [("left", C + Vector((-0.34, 0, 0.012)), C, 50), ("right", C + Vector((0.34, 0, 0.012)), C, 50),
                ("front34", C + Vector((-0.24, 0.30, 0.12)), C, 50), ("rear34", C + Vector((-0.24, -0.30, 0.15)), C, 50),
                ("top", C + Vector((-0.10, -0.02, 0.33)), C, 50), ("port", C + Vector((0.14, 0.06, 0.12)), C + Vector((0, 0.02, 0.03)), 50)],
               ((-hx / 0.25, hz * hip_far / 0.25, -hy / 0.25), 54), ((s.x, -0.5, s.z), 50.4))
