"""Build a low-poly cow and a sheep for the meadows round the house in Blender, to be drawn many
times over (web/src/world/herds.ts).

Run (Blender 5, no window):
  blender -b -P tools/cattle.py -- <out.glb> [preview_dir]

Our own models, not any breed's or farm's. The cow is a generic Flemish meadow cow: 1.42 m at the
withers and about the same at the hips, 1.75 m from the chest to the pin bones, the belly at
0.6 m, a straight topline, a deep chest with a dewlap, a broad forehead without horns, a modest
udder. The sheep is 0.75 m at the withers and 1.1 m long, in a thick fleece (the body is lumpy),
with a short docked tail. About 1,400 and 900 triangles.

Every piece is lofted through sections (rounded rectangles that grow and shrink along a path)
and closed with a rounded cap. Each animal is a mesh per moving part, its origin at the joint
the game turns it about:
  <Animal>_Body                   origin on the ground under the middle
  <Animal>_Neck                   origin at the base of the neck, inside the shoulders
  <Animal>_Head (ears, eyes)      origin at the poll
  <Animal>_Leg_FL ... _Leg_BR     origin at the shoulder or the hip
  <Animal>_Tail                   origin at the tail root
L is the animal's left (+x); it faces +z in the GLB (Blender -Y) and stands on y = 0, in metres.

No textures and no materials of their own: every piece carries one colour per vertex. Pure white
marks the coat, which the game colours per herd (black and white, red and white, the roan of a
Belgian Blue, a fleece); magenta marks a sheep's face and legs (black or cream); other colours
(hooves, eyes, muzzle, udder) stay as they are. With preview_dir it also renders both from the
side and from three quarters (Eevee).
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

COAT = (1.0, 1.0, 1.0)
FACE = (1.0, 0.0, 1.0)
HOOF = (0.10, 0.085, 0.075)
EYE = (0.02, 0.02, 0.02)
MUZZLE = (0.42, 0.30, 0.28)
UDDER = (0.75, 0.48, 0.44)


def B(v):
    """Game coordinates (x left, y up, z forward) to Blender's (x, -z, y)."""
    return Vector((v[0], -v[2], v[1]))


def sgnpow(v, p):
    return math.copysign(abs(v) ** p, v)


class Piece:
    """One part's mesh: lofts added to one bmesh, a colour per face corner."""

    def __init__(self, name, pivot):
        self.name = name
        self.pivot = Vector(pivot)
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new("Col")

    def face(self, verts, color):
        f = self.bm.faces.new(verts)
        for loop in f.loops:
            loop[self.col] = (*color, 1.0)
        return f

    def loft(self, sections, color, sides=10, p=2.4, caps=(0.6, 0.6), bump=None):
        """Sections: (centre, forward, up, half width, half height). caps: how far each rounded end
        sticks out, as a share of its section's size (0: flat)."""
        rings = []
        for c, f, u, hw, hh in sections:
            c, f, u = Vector(c), Vector(f).normalized(), Vector(u).normalized()
            left = u.cross(f).normalized()
            ring = []
            for k in range(sides):
                a = math.tau * k / sides
                x = hw * sgnpow(math.cos(a), 2 / p)
                y = hh * sgnpow(math.sin(a), 2 / p)
                v = c + left * x + u * y
                if bump:
                    v = bump(v, c)
                ring.append(self.bm.verts.new(B(v - self.pivot)))
            rings.append((ring, c, f, hw, hh))
        for (r0, *_), (r1, *_) in zip(rings, rings[1:]):
            for k in range(sides):
                self.face([r0[k], r1[k], r1[(k + 1) % sides], r0[(k + 1) % sides]], color)
        for end, (ring, c, f, hw, hh) in ((0, rings[0]), (1, rings[-1])):
            out = caps[end] * min(hw, hh) * (-1 if end == 0 else 1)
            tip = self.bm.verts.new(B(c + f * out - self.pivot))
            for k in range(sides):
                a, b = ring[k], ring[(k + 1) % sides]
                self.face([b, a, tip] if end == 0 else [a, b, tip], color)

    def blob(self, centre, radii, color, seg=8):
        """A small ellipsoid (eyes, teats, the udder)."""
        c = Vector(centre)
        rings = []
        for i in range(1, seg // 2):
            t = math.pi * i / (seg // 2)
            rings.append([self.bm.verts.new(B(c + Vector((radii[0] * math.sin(t) * math.cos(math.tau * k / seg), radii[1] * math.cos(t),
                                                            radii[2] * math.sin(t) * math.sin(math.tau * k / seg))) - self.pivot)) for k in range(seg)])
        top = self.bm.verts.new(B(c + Vector((0, radii[1], 0)) - self.pivot))
        bottom = self.bm.verts.new(B(c - Vector((0, radii[1], 0)) - self.pivot))
        for r0, r1 in zip(rings, rings[1:]):
            for k in range(seg):
                self.face([r0[k], r0[(k + 1) % seg], r1[(k + 1) % seg], r1[k]], color)
        for k in range(seg):
            self.face([rings[0][(k + 1) % seg], rings[0][k], top], color)
            self.face([rings[-1][k], rings[-1][(k + 1) % seg], bottom], color)

    def build(self, collection):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        bmesh.ops.triangulate(self.bm, faces=self.bm.faces)
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for poly in mesh.polygons:
            poly.use_smooth = True
        mesh.set_sharp_from_angle(angle=math.radians(62))
        attr = mesh.color_attributes["Col"]
        mesh.color_attributes.active_color = attr
        mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
        obj = bpy.data.objects.new(self.name, mesh)
        obj.location = B(self.pivot)
        collection.objects.link(obj)
        return obj


DOWN = (0, -1, 0)
FWD = (0, 0, 1)
UP = (0, 1, 0)


def leg(piece, x, path, widths, hoof_from):
    """A leg down a path of (y, z) points with (half width, half depth) at each; hooves from index
    `hoof_from` on."""
    secs = [((x, y, z), DOWN, FWD, w, d) for (y, z), (w, d) in zip(path, widths)]
    piece.loft(secs[:hoof_from + 1], COAT, sides=8, caps=(0.4, 0.0))
    piece.loft(secs[hoof_from:], HOOF, sides=8, caps=(0.0, 0.05))


def head_frame(angle):
    """Forward and up of a head pointing `angle` degrees below horizontal."""
    a = math.radians(angle)
    return (0, -math.sin(a), math.cos(a)), (0, math.cos(a), math.sin(a))


def cow(collection):
    parts = []
    body = Piece("Cow_Body", (0, 0, 0))
    up = UP
    # The barrel from the pin bones to the brisket: (z, middle y, half width, half height).
    secs = [(-0.93, 1.21, 0.15, 0.16), (-0.84, 1.13, 0.24, 0.29), (-0.64, 1.08, 0.30, 0.36), (-0.30, 1.02, 0.33, 0.41),
            (0.05, 1.00, 0.34, 0.42), (0.38, 1.03, 0.30, 0.39), (0.60, 1.00, 0.24, 0.36), (0.74, 1.06, 0.16, 0.26)]
    body.loft([((0, y, z), FWD, up, w, h) for z, y, w, h in secs], COAT, sides=16, p=2.7, caps=(0.5, 0.5))
    # The udder and its four teats.
    body.blob((0, 0.66, -0.46), (0.15, 0.11, 0.19), UDDER, seg=10)
    for tx in (-0.06, 0.06):
        for tz in (-0.53, -0.39):
            body.blob((tx, 0.53, tz), (0.02, 0.045, 0.02), UDDER, seg=6)
    parts.append(body)

    neck = Piece("Cow_Neck", (0, 1.06, 0.52))
    neck.loft([((0, 1.04, 0.52), (0, 0.15, 1), up, 0.2, 0.34), ((0, 1.06, 0.78), (0, 0.3, 1), up, 0.16, 0.28),
               ((0, 1.17, 0.97), (0, 0.4, 1), up, 0.12, 0.17)], COAT, sides=12, caps=(0.3, 0.3))
    parts.append(neck)

    poll = Vector((0, 1.27, 0.99))
    head = Piece("Cow_Head", poll)
    f, u = head_frame(58)
    f, u = Vector(f), Vector(u)
    at = lambda t, lift=0.0: poll + f * t + u * lift
    head.loft([(at(-0.03, -0.02), f, u, 0.10, 0.10), (at(0.08), f, u, 0.12, 0.115), (at(0.22, -0.01), f, u, 0.105, 0.10),
               (at(0.36, -0.01), f, u, 0.08, 0.075)], COAT, sides=12, caps=(0.5, 0.0))
    head.loft([(at(0.36, -0.01), f, u, 0.08, 0.075), (at(0.44, -0.005), f, u, 0.085, 0.08), (at(0.50), f, u, 0.075, 0.065)], MUZZLE, sides=12, caps=(0.0, 0.45))
    for side in (-1, 1):
        # Ears: flat ovals out to the side, a little down; eyes on the sides of the forehead.
        ear0 = poll + Vector((side * 0.11, -0.03, 0.02))
        ear1 = poll + Vector((side * 0.27, -0.07, 0.03))
        d = (ear1 - ear0).normalized()
        head.loft([(ear0, d, (0, 0.3, 1), 0.03, 0.025), ((ear0 + ear1) / 2, d, (0, 0.3, 1), 0.075, 0.025), (ear1, d, (0, 0.3, 1), 0.04, 0.02)], COAT, sides=8, caps=(0.2, 0.6))
        head.blob(at(0.14, 0.03) + Vector((side * 0.112, 0, 0)), (0.024, 0.024, 0.024), EYE, seg=6)
    parts.append(head)

    # Legs: front from the shoulder (pivot) down; hind from the hip, with the hock behind.
    for side, name in ((1, "L"), (-1, "R")):
        fl = Piece(f"Cow_Leg_F{name}", (side * 0.15, 0.96, 0.50))
        # Tops inside the barrel, so no edge shows where a leg meets the body.
        leg(fl, side * 0.15, [(0.90, 0.50), (0.66, 0.52), (0.52, 0.53), (0.38, 0.53), (0.17, 0.54), (0.10, 0.55), (0.0, 0.56)],
            [(0.105, 0.15), (0.08, 0.10), (0.06, 0.068), (0.048, 0.056), (0.052, 0.058), (0.058, 0.065), (0.064, 0.075)], 4)
        parts.append(fl)
        bl = Piece(f"Cow_Leg_B{name}", (side * 0.19, 1.02, -0.60))
        leg(bl, side * 0.165, [(0.96, -0.60), (0.72, -0.67), (0.50, -0.76), (0.36, -0.72), (0.17, -0.67), (0.10, -0.66), (0.0, -0.65)],
            [(0.13, 0.24), (0.10, 0.14), (0.058, 0.08), (0.048, 0.056), (0.052, 0.058), (0.058, 0.065), (0.064, 0.075)], 4)
        parts.append(bl)

    tail = Piece("Cow_Tail", (0, 1.30, -0.95))
    tail.loft([((0, 1.32, -0.93), DOWN, (0, 0, -1), 0.035, 0.035), ((0, 1.10, -1.02), DOWN, (0, 0, -1), 0.025, 0.025),
               ((0, 0.72, -1.03), DOWN, (0, 0, -1), 0.02, 0.02)], COAT, sides=6, caps=(0.2, 0.0))
    tail.loft([((0, 0.72, -1.03), DOWN, (0, 0, -1), 0.03, 0.03), ((0, 0.62, -1.03), DOWN, (0, 0, -1), 0.055, 0.05),
               ((0, 0.50, -1.03), DOWN, (0, 0, -1), 0.03, 0.03)], COAT, sides=6, caps=(0.0, 0.5))
    parts.append(tail)
    return [p.build(collection) for p in parts]


def fleece(v, c):
    """The fleece: lumps over the body, pushed out from its middle line."""
    d = v - c
    k = 1 + 0.07 * math.sin(v.x * 23 + v.z * 7) * math.sin(v.y * 19 + v.z * 13) + 0.04 * math.sin(v.z * 31 + v.x * 11)
    return c + d * k


def sheep(collection):
    parts = []
    body = Piece("Sheep_Body", (0, 0, 0))
    secs = [(-0.56, 0.62, 0.12, 0.12), (-0.50, 0.60, 0.20, 0.21), (-0.34, 0.59, 0.25, 0.25), (-0.10, 0.58, 0.27, 0.27),
            (0.14, 0.59, 0.26, 0.26), (0.32, 0.61, 0.22, 0.23), (0.44, 0.64, 0.14, 0.16)]
    body.loft([((0, y, z), FWD, UP, w, h) for z, y, w, h in secs], COAT, sides=16, p=2.2, caps=(0.6, 0.4), bump=fleece)
    parts.append(body)

    neck = Piece("Sheep_Neck", (0, 0.64, 0.36))
    neck.loft([((0, 0.64, 0.36), (0, 0.5, 1), UP, 0.12, 0.14), ((0, 0.72, 0.47), (0, 0.8, 1), UP, 0.09, 0.10)], COAT, sides=10, caps=(0.3, 0.3), bump=fleece)
    parts.append(neck)

    poll = Vector((0, 0.80, 0.50))
    head = Piece("Sheep_Head", poll)
    f, u = head_frame(50)
    f, u = Vector(f), Vector(u)
    at = lambda t, lift=0.0: poll + f * t + u * lift
    head.loft([(at(-0.02), f, u, 0.055, 0.06), (at(0.07), f, u, 0.06, 0.06), (at(0.17, -0.01), f, u, 0.045, 0.045), (at(0.23, -0.01), f, u, 0.035, 0.035)],
              FACE, sides=10, caps=(0.4, 0.5))
    for side in (-1, 1):
        ear0 = poll + Vector((side * 0.05, 0.0, 0.0))
        ear1 = poll + Vector((side * 0.15, -0.02, -0.01))
        d = (ear1 - ear0).normalized()
        head.loft([(ear0, d, (0, 1, 0.2), 0.015, 0.012), ((ear0 + ear1) / 2, d, (0, 1, 0.2), 0.035, 0.012), (ear1, d, (0, 1, 0.2), 0.02, 0.01)], FACE, sides=6, caps=(0.2, 0.6))
        head.blob(at(0.06, 0.02) + Vector((side * 0.055, 0, 0)), (0.013, 0.013, 0.013), EYE, seg=6)
    parts.append(head)

    for side, name in ((1, "L"), (-1, "R")):
        fl = Piece(f"Sheep_Leg_F{name}", (side * 0.11, 0.50, 0.30))
        leg(fl, side * 0.11, [(0.48, 0.30), (0.30, 0.31), (0.12, 0.31), (0.06, 0.32), (0.0, 0.32)],
            [(0.04, 0.05), (0.028, 0.03), (0.024, 0.026), (0.026, 0.03), (0.03, 0.034)], 3)
        parts.append(fl)
        bl = Piece(f"Sheep_Leg_B{name}", (side * 0.12, 0.52, -0.38))
        leg(bl, side * 0.12, [(0.50, -0.38), (0.32, -0.43), (0.22, -0.45), (0.06, -0.41), (0.0, -0.40)],
            [(0.05, 0.07), (0.03, 0.035), (0.024, 0.026), (0.026, 0.03), (0.03, 0.034)], 3)
        parts.append(bl)
    # The legs show below the fleece in the face colour.
    for p in parts[-4:]:
        for face in p.bm.faces:
            for loop in face.loops:
                if tuple(round(c, 3) for c in loop[p.col][:3]) == COAT:
                    loop[p.col] = (*FACE, 1.0)

    tail = Piece("Sheep_Tail", (0, 0.66, -0.56))
    tail.loft([((0, 0.66, -0.56), (0, -0.6, -1), UP, 0.045, 0.04), ((0, 0.58, -0.63), (0, -0.9, -0.4), UP, 0.04, 0.035)], COAT, sides=8, caps=(0.2, 0.6), bump=fleece)
    parts.append(tail)
    return [p.build(collection) for p in parts]


bpy.ops.wm.read_factory_settings(use_empty=True)
coll = bpy.context.scene.collection
objs = cow(coll) + sheep(coll)
for o in objs:
    print(f"  {o.name}: {sum(len(p.vertices) - 2 for p in o.data.polygons)} triangles")
bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = objs[0]
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_normals=True, export_vertex_color="ACTIVE", export_materials="NONE",
                          export_cameras=False, export_lights=False)
print("wrote", OUT, os.path.getsize(OUT), "bytes")

if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    # Preview colours: a black-and-white coat and a cream fleece with a black face.
    mat = bpy.data.materials.new("Preview")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes["Principled BSDF"]
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    for o in objs:
        o.data.materials.append(mat)
        if o.name.startswith("Sheep"):
            o.location.y += 2.2  # behind the cow's tail, side by side seen from the side
    ground = bpy.data.meshes.new("Ground")
    gbm = bmesh.new()
    bmesh.ops.create_grid(gbm, x_segments=1, y_segments=1, size=6)
    gbm.to_mesh(ground)
    g = bpy.data.objects.new("Ground", ground)
    coll.objects.link(g)
    gm = bpy.data.materials.new("Grass")
    gm.diffuse_color = (0.25, 0.35, 0.15, 1)
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.2, 0.3, 0.12, 1)
    ground.materials.append(gm)
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    coll.objects.link(sun)
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.7, 0.85, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    bpy.context.scene.world = world
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    coll.objects.link(cam)
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 900, 600
    for name, loc, look in (("side", (5.5, 0.6, 0.9), (0, 0.6, 0.7)), ("three_quarter", (3.6, -3.4, 1.7), (0, 0.6, 0.6)), ("front", (0.4, -4.5, 1.0), (0, 0.6, 0.7))):
        cam.location = loc
        d = Vector(look) - Vector(loc)
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"cattle_{name}.png")
        bpy.ops.render.render(write_still=True)
