"""Build the Zombies game's things in Blender, their textures baked: the rewards' signs and what is set down.

Run (Blender 5, no window):
  blender -b -P tools/zombie_items.py -- <out.glb> [preview_dir] [--cpu]

world/rewards.ts draws them; until this model is in (or if it can't be fetched) its own shapes made in code. Each mesh
is made in the frame rewards.ts gives that part, so it drops in where the built one was (the game's frame: y up, front
-z; one unit a metre):
- sign_ammo, sign_scope, sign_medkit, sign_armor, sign_nades, sign_gun: the signs turning over a reward, centred on
  the origin at the sizes of the built ones (a little larger than life, to read from across a garden): an ammo can
  with a yellow band, a rifle scope, a red first-aid bag, a plate carrier, three frag grenades, a weapons crate.
- claymore: the mine set down, its foot at the origin, its convex face to the front, on scissor legs; the blinking
  light (drawn by the game) sits on its fuze at (0, 0.2, 0.01). Also the claymore's sign, scaled.
- turret_legs (the tripod and hub, its frame before TURRET_SIZE) and turret_head (in the head's pitch frame: the
  receiver, an ammo box at its side, the barrel in its shroud to the front with the muzzle at (0, 0.075, -0.43), a
  housing for the eye the game draws at (-0.045, 0.14, -0.08)).
- lull_body (a walnut music box, its foot at the origin, the comb and drum in it, a brass crank at its side) and
  lull_lid (in its hinge's frame: across x, up to 2.5 cm, back to z 0.14; felt under it).
- stake (a hewn pole with a fresh-cut point, its foot at the origin) and rail (a pole 1 m along x), for the rows.

Textures: CC0 from Poly Haven (tools/blender_kit.py). All bake onto one atlas (1024 px colour, 512 px normals and
metal/roughness), laid apart for the bake (each in the light it is seen in), then put back in their frames.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from blender_kit import *  # noqa: E402,F403 (the shared helpers: textures, materials, geometry, the bake)
from blender_kit import DEFAULT, ROOT  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
CPU = "--cpu" in argv
argv = [a for a in argv if not a.startswith("--")]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""
bpy.ops.wm.read_factory_settings(use_empty=True)

# ------------------------------------------------------------------------------------------------ materials
olive = tex_material("olive", "metal_plate_02", 0.35, srgb("#6f7744"), sat=0.0, bright=2.8, rough=1.2, metal=0.05, nstrength=0.5)
olive_steel = tex_material("olive_steel", "metal_plate_02", 0.35, srgb("#626a3c"), sat=0.0, bright=2.6, rough=0.9, metal=0.15, nstrength=0.5)
yellow = tex_material("yellow", "metal_plate_02", 0.35, srgb("#e0b53c"), sat=0.0, bright=2.6, rough=1.0, metal=0.05, nstrength=0.4)
steel = tex_material("steel", "metal_plate_02", 0.5, srgb("#c4c9cb"), sat=0.0, bright=1.8, rough=0.8, metal=0.6, nstrength=0.4)
gunmetal = tex_material("gunmetal", "metal_plate_02", 0.3, srgb("#3a3d40"), sat=0.0, bright=2.0, rough=0.7, metal=0.5, nstrength=0.3)
lens = plain_material("lens", "#2c6f86", 0.06, 0.2)
eyehouse = plain_material("eyehouse", "#1d2022", 0.5)
bag_red = tex_material("bag_red", "rough_linen", 0.12, srgb("#b02a2c"), sat=0.0, bright=1.15, nstrength=1.2)
patch_white = tex_material("patch_white", "rough_linen", 0.1, srgb("#ece8de"), sat=0.0, bright=1.2, nstrength=0.8)
webbing = tex_material("webbing", "rough_linen", 0.05, srgb("#2a2a2a"), sat=0.0, bright=1.0, nstrength=1.5)
navy = tex_material("navy", "rough_linen", 0.1, srgb("#28385a"), sat=0.0, bright=1.1, nstrength=1.4)
navy_dark = tex_material("navy_dark", "rough_linen", 0.05, srgb("#1b2740"), sat=0.0, bright=1.0, nstrength=1.6)
crate_olive = tex_material("crate_olive", "rough_wood", 0.4, srgb("#7a8452"), sat=0.25, bright=1.0, rough=1.3)
band_white = tex_material("band_white", "rough_wood", 0.4, srgb("#f0ece2"), sat=0.0, bright=1.8, rough=1.3)
rope = tex_material("rope", "rough_linen", 0.06, srgb("#b49a72"), sat=0.0, bright=1.0, nstrength=1.6)
bark = tex_material("bark", "rough_wood", 0.6, srgb("#7d5a3a"), sat=0.6, bright=0.85, rough=1.4, shade=wood_shade)
fresh = tex_material("fresh", "rough_wood", 0.3, srgb("#e8cfa4"), sat=0.4, bright=1.35, rough=1.4)
walnut = tex_material("walnut", "wood_table_worn", 0.3, srgb("#a8764c"), sat=0.7, bright=1.0, rough=0.7)
inlay = tex_material("inlay", "wood_table_worn", 0.2, srgb("#e2c595"), sat=0.6, bright=1.2, rough=0.7)
felt = tex_material("felt", "rough_linen", 0.06, srgb("#7a1f2a"), sat=0.0, bright=1.0, nstrength=0.6)
brass = plain_material("brass", "#c9a043", 0.3, 0.9)

# ------------------------------------------------------------------------------------------------ geometry
NAMES = ["sign_ammo", "sign_scope", "sign_medkit", "sign_armor", "sign_nades", "sign_gun", "claymore",
         "turret_legs", "turret_head", "lull_body", "lull_lid", "stake", "rail"]
PARTS = {n: [] for n in NAMES}


def box(n, name, x, y, z, w, h, d, mat, bev=0.003, segs=1):
    o = cuboid(name, x, y, z, w, h, d, mat, PARTS[n], bev=0 if segs > 1 else bev)
    if segs > 1:
        bevel(o, bev, segs)
    return o


def cyl(n, name, a, b, r, mat, seg=14):
    return tube(name, a, b, r, mat, PARTS[n], seg=seg)


def ring(n, name, at, axis, R, r, mat):
    return torus(name, at, axis, R, r, mat, PARTS[n])


def path(n, name, pts, r, mat, seg=8):
    return path_tube(name, pts, r, mat, PARTS[n], seg=seg)


def ball(n, name, at, r, mat, scale=(1, 1, 1), seg=18):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=max(6, seg // 2), radius=r, location=G(*at))
    o = bpy.context.active_object
    o.name = name
    o.scale = (scale[0], scale[2], scale[1])  # game (x, y, z) scale in Blender's axes
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, mat, PARTS[n])


# ---- sign_ammo: an olive ammo can, its lid latched at one end, a folding handle, a yellow band round it.
n = "sign_ammo"
box(n, "Can", 0, -0.008, 0, 0.26, 0.134, 0.15, olive_steel, bev=0.008, segs=2)
box(n, "Lid", 0, 0.066, 0, 0.266, 0.018, 0.156, olive_steel, bev=0.004, segs=2)
box(n, "Band", 0, -0.02, 0, 0.034, 0.112, 0.153, yellow, bev=0.002)
for s in (-1, 1):  # pressed ribs on the sides
    box(n, f"Rib{s}", s * 0.06, -0.01, -0.0755, 0.05, 0.08, 0.003, olive_steel, bev=0.0015)
    box(n, f"RibB{s}", s * 0.06, -0.01, 0.0755, 0.05, 0.08, 0.003, olive_steel, bev=0.0015)
box(n, "Latch", 0.136, 0.04, 0, 0.012, 0.05, 0.06, olive_steel, bev=0.003, segs=2)
box(n, "Hinge", -0.134, 0.058, 0, 0.008, 0.016, 0.13, steel, bev=0.002)
path(n, "Handle", [(-0.06, 0.077, 0.0), (-0.05, 0.081, -0.03), (0.05, 0.081, -0.03), (0.06, 0.077, 0.0)], 0.006, steel)
for s in (-1, 1):
    box(n, f"HandleFoot{s}", s * 0.06, 0.077, 0, 0.016, 0.006, 0.02, olive_steel, bev=0.002)

# ---- sign_scope: a rifle scope along z: the tube, the objective bell to the front, the eyepiece behind, two turrets,
#      the mount's rings on a base, blue-coated lenses at both ends.
n = "sign_scope"
cyl(n, "Tube", (0, 0, -0.1), (0, 0, 0.1), 0.021, gunmetal, seg=24)
bpy.ops.mesh.primitive_cone_add(vertices=28, radius1=0.021, radius2=0.036, depth=0.045, location=G(0, 0, -0.1225))
o = bpy.context.active_object
o.rotation_euler = G(0, 0, -1).to_track_quat("Z", "Y").to_euler()
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
finish(o, gunmetal, PARTS[n])
cyl(n, "Objective", (0, 0, -0.145), (0, 0, -0.16), 0.036, gunmetal, seg=28)
bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.021, radius2=0.03, depth=0.03, location=G(0, 0, 0.115))
o = bpy.context.active_object
o.rotation_euler = G(0, 0, 1).to_track_quat("Z", "Y").to_euler()
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
finish(o, gunmetal, PARTS[n])
cyl(n, "Eyepiece", (0, 0, 0.13), (0, 0, 0.16), 0.03, webbing, seg=24)
cyl(n, "TurretTop", (0, 0.02, -0.005), (0, 0.042, -0.005), 0.014, gunmetal, seg=16)
cyl(n, "TurretSide", (0.02, 0, -0.005), (0.042, 0, -0.005), 0.014, gunmetal, seg=16)
for z in (-0.06, 0.06):
    ring(n, f"MountRing{z}", (0, -0.002, z), (0, 0, 1), 0.026, 0.006, gunmetal)
    box(n, f"MountPost{z}", 0, -0.034, z, 0.02, 0.022, 0.016, gunmetal, bev=0.002)
box(n, "MountBase", 0, -0.048, 0, 0.026, 0.01, 0.17, gunmetal, bev=0.002)
for z in (-0.161, 0.161):
    cyl(n, f"Lens{z}", (0, 0, z - 0.0005 * (1 if z > 0 else -1)), (0, 0, z + 0.0015 * (1 if z > 0 else -1)), 0.031 if z < 0 else 0.024, lens, seg=24)

# ---- sign_medkit: a padded red first-aid bag, white crosses on its front, back and top, a zip and a handle.
n = "sign_medkit"
box(n, "Bag", 0, 0, 0, 0.26, 0.15, 0.17, bag_red, bev=0.035, segs=4)
for nm_, (w, h) in (("V", (0.026, 0.08)), ("H", (0.08, 0.026))):
    for s in (-1, 1):
        box(n, f"Cross{nm_}{s}", 0, 0, s * 0.0855, w, h, 0.003, patch_white, bev=0.001)
    box(n, f"TopCross{nm_}", 0, 0.0755, 0.01, w, 0.003, h, patch_white, bev=0.001)
zip_pts = []
for k in range(41):
    a = 2 * math.pi * k / 40
    zip_pts.append((0.131 * math.copysign(abs(math.cos(a)) ** 0.25, math.cos(a)), 0.04, 0.086 * math.copysign(abs(math.sin(a)) ** 0.25, math.sin(a))))
path(n, "Zip", zip_pts, 0.0035, webbing)
path(n, "Handle", [(-0.065, 0.07, 0.03), (-0.05, 0.1, 0.03), (0.0, 0.108, 0.03), (0.05, 0.1, 0.03), (0.065, 0.07, 0.03)], 0.006, webbing)

# ---- sign_armor: a plate carrier standing: the padded panel, webbing rows across its front, the loop panel, the
#      shoulder straps over its top and the cummerbund's wings at its sides.
n = "sign_armor"
box(n, "Panel", 0, 0, 0, 0.24, 0.3, 0.05, navy, bev=0.014, segs=3)
for k in range(4):
    y = -0.12 + k * 0.03
    box(n, f"Molle{k}", 0, y, -0.0265, 0.22, 0.019, 0.004, navy_dark, bev=0.0012)
    for x in (-0.055, 0.0, 0.055):
        box(n, f"Tack{k}{x}", x, y, -0.029, 0.004, 0.02, 0.002, webbing, bev=0.0)
box(n, "LoopPanel", 0, 0.03, -0.0265, 0.13, 0.06, 0.004, navy_dark, bev=0.0015)
for s in (-1, 1):
    path(n, f"Strap{s}", [(s * 0.07, 0.13, -0.02), (s * 0.07, 0.165, -0.012), (s * 0.07, 0.175, 0.012), (s * 0.07, 0.15, 0.03)], 0.012, navy)
    box(n, f"Buckle{s}", s * 0.07, 0.11, -0.03, 0.04, 0.022, 0.006, webbing, bev=0.002)
    box(n, f"Wing{s}", s * 0.13, -0.05, 0.02, 0.03, 0.18, 0.06, navy, bev=0.01, segs=2)

# ---- sign_nades: three frag grenades, two side by side and one on them: an egg of olive steel, the fuze, the lever
#      down its side, the ring and pin. A little larger than life (the sign's size).
n = "sign_nades"


def grenade(gx, gy, gz, yaw, k=1.6):
    """A grenade k times life size, its body's middle at (gx, gy, gz), the lever turned `yaw`."""
    r = 0.031 * k
    ball(n, "Body", (gx, gy, gz), r, olive_steel, scale=(1, 1.18, 1), seg=20)
    top = gy + r * 1.18
    cyl(n, "Neck", (gx, top - 0.004 * k, gz), (gx, top + 0.008 * k, gz), 0.011 * k, steel, seg=12)
    cyl(n, "Fuze", (gx, top + 0.008 * k, gz), (gx, top + 0.026 * k, gz), 0.0135 * k, steel, seg=12)
    c, s = math.cos(yaw), math.sin(yaw)
    lever = [(0.0, 0.026), (0.016, 0.025), (0.026, 0.012), (0.031, -0.012), (0.03, -0.037)]
    path(n, "Lever", [(gx + c * u * k, top + v * k, gz + s * u * k) for u, v in lever], 0.003 * k, steel, seg=4)
    ring(n, "Ring", (gx - s * 0.02 * k, top + 0.016 * k, gz + c * 0.02 * k), (c, 0, s), 0.011 * k, 0.0016 * k, steel)


grenade(-0.055, -0.045, 0.0, 0.4)
grenade(0.055, -0.045, 0.0, 2.6)
grenade(0.0, 0.07, 0.0, -1.3)

# ---- sign_gun: a weapons crate, olive-painted planks, two white bands, steel corners, latches, rope handles.
n = "sign_gun"
CW, CH, CD = 0.36, 0.21, 0.24
box(n, "Body", 0, -0.02, 0, CW, CH - 0.04, CD, crate_olive, bev=0.005)
box(n, "Lid", 0, CH / 2 - 0.02, 0, CW + 0.005, 0.04, CD + 0.005, crate_olive, bev=0.005)
for k in (1, 2):
    for s in (-1, 1):
        box(n, f"Seam{k}{s}", 0, -CH / 2 + k * 0.055, s * (CD / 2 + 0.0005), CW - 0.012, 0.0025, 0.0025, webbing, bev=0.0)
for x in (-0.09, 0.09):
    box(n, f"Band{x}", x, 0, 0, 0.044, CH + 0.004, CD + 0.01, band_white, bev=0.002)
for sx in (-1, 1):
    for sy in (-1, 1):
        for sz in (-1, 1):
            box(n, f"Corner{sx}{sy}{sz}", sx * (CW / 2 - 0.007), sy * (CH / 2 - 0.012), sz * (CD / 2 - 0.007), 0.024, 0.03, 0.024, steel, bev=0.002)
    for sz in (-1, 1):
        box(n, f"Latch{sx}{sz}", sx * 0.135, CH / 2 - 0.045, sz * (CD / 2 + 0.005), 0.028, 0.036, 0.01, steel, bev=0.0015)
    path(n, f"Rope{sx}", [(sx * (CW / 2 + 0.002), 0.02, -0.055), (sx * (CW / 2 + 0.018), 0.0, -0.04), (sx * (CW / 2 + 0.024), -0.01, 0.0),
                          (sx * (CW / 2 + 0.018), 0.0, 0.04), (sx * (CW / 2 + 0.002), 0.02, 0.055)], 0.006, rope)

# ---- claymore: the curved case, convex to the front (-z), on two pairs of scissor legs; the fuze on top.
n = "claymore"
CY0, CHh, CWw = 0.06, 0.12, 0.25


def face(u, v):
    x = -CWw / 2 + CWw * u
    return (x, CY0 + CHh * v, -0.012 - 0.022 * (1 - (2 * x / CWw) ** 2))


case = sheet("Case", 24, 2, face, olive, PARTS[n], 0.0, lambda u, v: (u * CWw, v * CHh))
sol = case.modifiers.new("solid", "SOLIDIFY")
sol.thickness, sol.offset, sol.use_even_offset = 0.04, -1.0, True
apply_mods(case)
bevel(case, 0.003)
for x in (-0.085, 0.085):
    for s in (-1, 1):
        cyl(n, "Leg", (x, CY0 + 0.006, 0.01 + s * 0.012), (x + 0.004, 0.0, 0.01 - s * 0.04), 0.0032, steel, seg=6)
    cyl(n, "Pivot", (x - 0.007, CY0 + 0.004, 0.01), (x + 0.007, CY0 + 0.004, 0.01), 0.005, olive, seg=8)
for x in (-0.055, 0.055):
    cyl(n, "Well", (x, CY0 + CHh - 0.004, 0.012), (x, CY0 + CHh + 0.012, 0.012), 0.009, olive, seg=10)
    cyl(n, "WellCap", (x, CY0 + CHh + 0.012, 0.012), (x, CY0 + CHh + 0.016, 0.012), 0.0105, webbing, seg=10)
box(n, "Fuze", 0, 0.188, 0.01, 0.026, 0.018, 0.022, webbing, bev=0.003)  # the game's light on it at y 0.2
cyl(n, "Sight", (0, CY0 + CHh - 0.002, -0.01), (0, CY0 + CHh + 0.01, -0.01), 0.004, olive, seg=6)

# ---- turret_legs: the tripod in the body's frame (rewards.ts TURRET_Y): three telescopic legs from the hub, feet.
n = "turret_legs"
TY = 0.5
for i in range(3):
    a = i * 2 * math.pi / 3 + math.pi / 3
    d = Vector((-math.sin(0.42) * math.sin(a), -math.cos(0.42), -math.sin(0.42) * math.cos(a)))
    top = Vector((0, TY, 0)) + d * 0.04
    mid = Vector((0, TY, 0)) + d * 0.3
    foot = Vector((0, TY, 0)) + d * 0.56
    cyl(n, f"Upper{i}", tuple(top), tuple(mid), 0.017, olive_steel, seg=10)
    cyl(n, f"Lower{i}", tuple(mid - d * 0.02), tuple(foot), 0.012, steel, seg=10)
    cyl(n, f"Collar{i}", tuple(mid - d * 0.02), tuple(mid + d * 0.015), 0.021, olive_steel, seg=10)
    cyl(n, f"Foot{i}", tuple(foot + Vector((0, -0.006, 0))), tuple(foot + Vector((0, 0.014, 0))), 0.024, webbing, seg=12)
cyl(n, "Hub", (0, TY - 0.05, 0), (0, TY + 0.06, 0), 0.042, olive_steel, seg=18)
cyl(n, "HubRing", (0, TY + 0.045, 0), (0, TY + 0.06, 0), 0.05, steel, seg=18)
cyl(n, "Knob", (0.042, TY - 0.01, 0), (0.07, TY - 0.01, 0), 0.008, steel, seg=8)
cyl(n, "KnobHead", (0.07, TY - 0.01, 0), (0.078, TY - 0.01, 0), 0.016, webbing, seg=10)

# ---- turret_head: in the head's pitch frame (rewards.ts tilt): the receiver, the yoke under it, the ammo box at its
#      right with the belt's chute, the barrel in a slotted shroud to the front (-z), the muzzle brake at z -0.43, the
#      eye's housing (the game draws the eye at (-0.045, 0.14, -0.08)), a carry handle.
n = "turret_head"
box(n, "Receiver", 0, 0.07, 0.02, 0.15, 0.115, 0.26, olive, bev=0.01, segs=2)
box(n, "Cover", 0, 0.132, 0.03, 0.12, 0.014, 0.19, olive_steel, bev=0.004, segs=2)
for k in range(5):  # cooling slots along its left side
    box(n, f"Slot{k}", -0.0755, 0.075, -0.05 + k * 0.03, 0.003, 0.05, 0.012, webbing, bev=0.0)
box(n, "Yoke", 0, 0.004, 0.02, 0.07, 0.018, 0.1, olive_steel, bev=0.004)
box(n, "AmmoBox", 0.115, 0.055, 0.05, 0.07, 0.095, 0.135, olive_steel, bev=0.006, segs=2)
box(n, "AmmoLid", 0.115, 0.105, 0.05, 0.074, 0.008, 0.139, olive_steel, bev=0.003)
path(n, "Chute", [(0.08, 0.1, 0.0), (0.07, 0.11, -0.005), (0.055, 0.112, -0.01)], 0.012, webbing)
cyl(n, "Shroud", (0, 0.075, -0.105), (0, 0.075, -0.3), 0.024, olive_steel, seg=16)
for k in range(5):
    z = -0.13 - k * 0.035
    for s in (-1, 1):
        box(n, f"Vent{k}{s}", s * 0.0235, 0.075, z, 0.004, 0.012, 0.018, webbing, bev=0.0)
cyl(n, "Barrel", (0, 0.075, -0.3), (0, 0.075, -0.37), 0.0135, gunmetal, seg=14)
cyl(n, "Brake", (0, 0.075, -0.36), (0, 0.075, -0.43), 0.024, gunmetal, seg=16)
for k in range(3):
    box(n, f"Port{k}", 0, 0.075, -0.372 - k * 0.019, 0.05, 0.03, 0.007, webbing, bev=0.0)
box(n, "EyeHousing", -0.045, 0.128, -0.08, 0.06, 0.03, 0.05, eyehouse, bev=0.006, segs=2)
path(n, "Handle", [(0, 0.139, -0.03), (0, 0.175, -0.015), (0, 0.175, 0.07), (0, 0.139, 0.085)], 0.007, webbing)

# ---- lull_body: a walnut music box: walls round a sunken top with the comb and drum in it, brass corners, a
#      keyhole, the crank at its right side (+x).
n = "lull_body"
W, H, D = 0.2, 0.11, 0.14
box(n, "Base", 0, 0.04, 0, W, 0.08, D, walnut, bev=0.004)
for s in (-1, 1):
    box(n, f"WallZ{s}", 0, 0.095, s * (D / 2 - 0.005), W, 0.03, 0.01, walnut, bev=0.002)
    box(n, f"WallX{s}", s * (W / 2 - 0.005), 0.095, 0, 0.01, 0.03, D - 0.02, walnut, bev=0.002)
cyl(n, "Drum", (-0.05, 0.096, 0.01), (0.04, 0.096, 0.01), 0.014, brass, seg=18)
box(n, "Comb", -0.005, 0.088, -0.022, 0.09, 0.006, 0.03, brass, bev=0.001)
box(n, "Bed", 0, 0.082, 0, 0.17, 0.004, 0.11, felt, bev=0.0)
for sx in (-1, 1):
    for sz in (-1, 1):
        box(n, f"Corner{sx}{sz}", sx * (W / 2 - 0.006), 0.012, sz * (D / 2 - 0.006), 0.016, 0.018, 0.016, brass, bev=0.002)
box(n, "Keyhole", 0, 0.065, D / 2 + 0.001, 0.022, 0.03, 0.002, brass, bev=0.001)
cyl(n, "CrankShaft", (W / 2, 0.06, 0), (W / 2 + 0.03, 0.06, 0), 0.006, brass, seg=10)
box(n, "CrankArm", W / 2 + 0.034, 0.04, 0, 0.008, 0.055, 0.012, brass, bev=0.002)
cyl(n, "CrankKnob", (W / 2 + 0.036, 0.018, 0), (W / 2 + 0.065, 0.018, 0), 0.008, walnut, seg=10)

# ---- lull_lid: in the hinge's frame: x across, y from 0 up to 0.025, z from 0 back to 0.14; an inlay on top, felt
#      under it, a brass hinge along its edge.
n = "lull_lid"
box(n, "Lid", 0, 0.0125, 0.07, W, 0.025, D, walnut, bev=0.004, segs=2)
box(n, "Inlay", 0, 0.0255, 0.07, 0.13, 0.002, 0.08, inlay, bev=0.0)
box(n, "Lining", 0, -0.001, 0.07, 0.18, 0.002, 0.12, felt, bev=0.0)
cyl(n, "Hinge", (-0.07, 0.004, 0.0), (0.07, 0.004, 0.0), 0.004, brass, seg=8)

# ---- stake: a hewn pole, foot at the origin, up 0.95 m, a fresh-cut point to 1.15 m, a lashing at the rail.
n = "stake"
bpy.ops.mesh.primitive_cone_add(vertices=9, radius1=0.05, radius2=0.044, depth=0.95, location=G(0, 0.475, 0))
o = bpy.context.active_object
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
finish(o, bark, PARTS[n], tex_scale=0.5)
bpy.ops.mesh.primitive_cone_add(vertices=9, radius1=0.044, radius2=0.004, depth=0.2, location=G(0, 1.05, 0), end_fill_type="NOTHING")
o = bpy.context.active_object
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
finish(o, fresh, PARTS[n], tex_scale=0.3)
cyl(n, "CutEnd", (0, -0.002, 0), (0, 0.003, 0), 0.049, fresh, seg=9)

# ---- rail: a pole 1 m along x, centred.
n = "rail"
cyl(n, "Rail", (-0.5, 0, 0), (0.5, 0, 0), 0.045, bark, seg=9)
cyl(n, "EndA", (-0.503, 0, 0), (-0.497, 0, 0), 0.044, fresh, seg=9)
cyl(n, "EndB", (0.497, 0, 0), (0.503, 0, 0), 0.044, fresh, seg=9)

# ------------------------------------------------------------------------------------------------ lay out, bake
# Each laid apart for the bake, as it is seen: the signs in the air, the rest on the ground, the turret's head on its
# legs, the music box's lid open on it. PLACE: its frame -> where it is baked (Blender's frame).
LID = Matrix.Translation(G(0, 0.11, -0.07)) @ Matrix.Rotation(1.9, 4, "X")  # rewards.ts: lid at (0, 0.11, -0.07), open -1.9
PLACE = {}
for i, name in enumerate(NAMES):
    at = G(-6 + 1.0 * (i % 7) * 1.4, 0.6 if name.startswith("sign_") else 0.0, -1.6 * (i // 7))
    PLACE[name] = Matrix.Translation(at)
PLACE["turret_head"] = PLACE["turret_legs"] @ Matrix.Translation(G(0, 0.56, 0))
PLACE["lull_lid"] = PLACE["lull_body"] @ LID
PLACE["stake"] = Matrix.Translation(G(3.0, 0, 1.0))
PLACE["rail"] = Matrix.Translation(G(3.0, 0.42, 1.6))
for i, name in enumerate(NAMES):
    for o in PARTS[name]:
        o.data.transform(PLACE[name])
        a = o.data.attributes.new("item", "INT", "FACE")
        a.data.foreach_set("value", [i] * len(o.data.polygons))
items = join([o for name in NAMES for o in PARTS[name]], "Items")
items.data.calc_loop_triangles()
print(f"zombie_items: {len(items.data.loop_triangles)} triangles")
atlas_uvs(items, 0.004)
ground = bake_setup(CPU)
tmp = os.path.join(PREVIEW or os.path.dirname(os.path.abspath(OUT)), "bake")
os.makedirs(tmp, exist_ok=True)
imgs = bake(items, [], 1024)
final_material(items, imgs, tmp)
bpy.data.objects.remove(ground)

# Apart again, each back in its own frame.
out_objs = []
for i, name in enumerate(NAMES):
    o = items.copy()
    o.data = items.data.copy()
    bpy.context.scene.collection.objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    layer = bm.faces.layers.int.get("item")
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[layer] != i], context="FACES")
    bm.to_mesh(o.data)
    bm.free()
    o.data.attributes.remove(o.data.attributes["item"])
    o.data.transform(PLACE[name].inverted())
    o.name = o.data.name = name
    print(f"zombie_items: {name} {len(o.data.polygons)} faces")
    out_objs.append(o)
bpy.data.objects.remove(items)
export_glb(out_objs, OUT)

# ------------------------------------------------------------------------------------------------ previews
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 48
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900
    sky = bpy.data.worlds.new("Sky")
    sky.use_nodes = True
    env = sky.node_tree.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(str(ROOT / "web" / "public" / "env" / "sky_2k.hdr"))
    sky.node_tree.links.new(env.outputs["Color"], sky.node_tree.nodes["Background"].inputs["Color"])
    sky.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = sky
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(-140)))
    bpy.context.active_object.data.energy = 3.0
    bpy.ops.mesh.primitive_plane_add(size=30)
    floor = bpy.context.active_object
    floor.data.materials.append(plain_material("floor", "#7a7a72", 0.9))
    # A line-up: the signs in a row in the air, the claymore, the turret, the music box (open), a stake and a rail.
    line = {"sign_ammo": (-1.3, 0.6, 0), "sign_scope": (-0.95, 0.6, 0), "sign_medkit": (-0.6, 0.6, 0), "sign_armor": (-0.25, 0.6, 0),
            "sign_nades": (0.1, 0.6, 0), "sign_gun": (0.5, 0.6, 0), "claymore": (-0.9, 0, -0.5), "turret_legs": (0.0, 0, 0.6),
            "lull_body": (0.8, 0, -0.5), "stake": (1.3, 0, 0.3), "rail": (1.0, 0.42, 0.9)}
    objs = {o.name: o for o in out_objs}
    for name, at in line.items():
        objs[name].matrix_world = Matrix.Translation(G(*at))  # fronts (-z) to the camera
    objs["turret_head"].matrix_world = objs["turret_legs"].matrix_world @ Matrix.Translation(G(0, 0.56, 0))
    objs["lull_lid"].matrix_world = objs["lull_body"].matrix_world @ LID
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    for label, at, look, lens_mm in (("items_all", (0, 3.2, 1.2), (0, 0, 0.45), 30),
                                     ("items_signs", (-0.4, 1.4, 0.75), (-0.4, 0, 0.6), 35),
                                     ("items_set", (-0.1, 2.0, 0.7), (0, -0.1, 0.25), 32)):
        cam.location = at
        cam.data.lens = lens_mm
        cam.rotation_euler = (Vector(look) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
