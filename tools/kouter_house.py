"""Build the southern house and its front garden from the public model outline and street-side references.

Run after neighbours.py and terrain.py, before build_house.py:
  blender -b -P tools/kouter_house.py -- web/public/models/kouter_house.glb data/kouter_house.json

The roof and footprint follow the GRB and laser scan. The visible facade and clipped front garden follow
the street-side reference; unseen rear windows and terrace are an interpretation. No reference imagery,
house numbers, names or addresses are exported. Everything is made here, with the game's shared textures.
The accompanying JSON supplies the same garden collision to the browser and the server through build_house.py.
"""
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
args = sys.argv[sys.argv.index("--") + 1:]
output = Path(args[0]).resolve()
data_output = Path(args[1]).resolve()
bpy.ops.wm.read_factory_settings(use_empty=True)

buildings = json.loads((ROOT / "data/neighbours.json").read_text())["buildings"]
# A position in the model, never an address. Keep the measured outline as the replacement key.
here = Vector((1874.13, -293.94))
building = min((b for b in buildings if b["kind"] == "hoofdgebouw"),
               key=lambda b: (Vector(tuple(map(lambda a: sum(a) / len(a), zip(*b["p"])))) - here).length)
outline = building["p"]
front_edge = building["front"]
left, right = Vector(outline[front_edge]), Vector(outline[(front_edge + 1) % len(outline)])
origin = (left + right) / 2
along = (right - left).normalized()
depth = Vector((along.y, -along.x))
middle = Vector(tuple(sum(axis) / len(axis) for axis in zip(*outline)))
if (middle - here).length > 5 or not 11 < (right - left).length < 13:
    raise ValueError("The measured house outline changed; review its frontage before rebuilding")
if (middle - origin).dot(depth) < 0:
    along, depth = -along, -depth
half = (right - left).length / 2
eaves, ridge, body_depth = building["eaves"], building["ridge"], 9.50


def point(u, d):
    return origin + along * u + depth * d


def vertex(u, d, y):
    p = point(u, d) - origin
    return Vector((p.x, -p.y, y))


# The same centimetre grid and triangle diagonal as shared/terrain.mjs. The garden follows its slope.
grid = json.loads((ROOT / "web/shared/terrain.json").read_text())
digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
heights, at = [], 0
for j in range(grid["nz"]):
    for i in range(grid["nx"]):
        if grid["d"][at] == "~":
            r = sum(digits.index(grid["d"][at + k]) << (6 * (3 - k)) for k in (1, 2, 3)) - (1 << 17)
            at += 4
        else:
            r = digits.index(grid["d"][at]) - 32
            at += 1
        n = len(heights)
        guess = heights[n - 1] + heights[n - grid["nx"]] - heights[n - grid["nx"] - 1] if i and j else heights[n - 1] if i else heights[n - grid["nx"]] if j else 0
        heights.append(guess + r)


def terrain(p):
    x = max(0, min((p.x - grid["x0"]) / grid["step"], grid["nx"] - 1.000001))
    z = max(0, min((p.y - grid["z0"]) / grid["step"], grid["nz"] - 1.000001))
    i, j = int(x), int(z)
    u, v = x - i, z - j
    n, nx = j * grid["nx"] + i, grid["nx"]
    a, b = heights[n], heights[n + nx + 1]
    return (a + u * (heights[n + 1] - a) + v * (b - heights[n + 1]) if u >= v
            else a + v * (heights[n + nx] - a) + u * (b - heights[n + nx])) / 100


base = terrain(origin)
ground = lambda u, d: terrain(point(u, d)) - base
palette = {
    "brick": ("d8c59d", "nb_brick"), "roof": ("414449", "roof_tiles"),
    "frame": ("243c33", None), "glass": ("536660", None), "metal": ("3c4143", None),
    "stone": ("8c8c83", None), "gravel": ("c6c1b1", "gravel"), "paving": ("bcb8ac", "pavers"),
    "solar": ("24313b", None), "cells": ("59616c", None), "leaves": ("668148", None),
    "bark": ("65513b", None), "wood": ("927c60", None),
}
faces = defaultdict(list)
solids = []
rng = random.Random(3417)


def face(mat, corners):
    faces[mat].append([vertex(*p) for p in corners])


def box(mat, u, d, y, w, length, h, solid=None):
    corners = [(u + a * w / 2, d + b * length / 2, y + c * h)
               for c in (0, 1) for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for ids in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        face(mat, [corners[i] for i in ids])
    if solid:
        solids.append({"m": solid, "p": [[[round(c, 3) for c in point(*p[:2])] for p in corners[:4]]],
                       "y0": round(y + base - .1, 3), "y1": round(y + h + base - .1, 3), "lm": "kouter_house"})


def beam(mat, a, b, radius, sides=8):
    a, b = vertex(*a), vertex(*b)
    axis = (b - a).normalized()
    u = axis.cross(Vector((0, 0, 1)))
    if u.length < .01:
        u = axis.cross(Vector((1, 0, 0)))
    u.normalize()
    v = axis.cross(u)
    ring = lambda c: [c + radius * (math.cos(i * math.tau / sides) * u + math.sin(i * math.tau / sides) * v) for i in range(sides)]
    ra, rb = ring(a), ring(b)
    faces[mat].extend([[ra[i], ra[(i + 1) % sides], rb[(i + 1) % sides], rb[i]] for i in range(sides)])
    faces[mat].extend([ra[::-1], rb])


def ellipsoid(mat, u, d, y, radii, rings=5, steps=9):
    for j in range(rings):
        for i in range(steps):
            corners = []
            for x, z in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
                a, b = x * math.tau / steps, z * math.pi / rings
                corners.append((u + radii[0] * math.cos(a) * math.sin(b),
                                d + radii[1] * math.sin(a) * math.sin(b), y + radii[2] * math.cos(b)))
            face(mat, corners[::-1])


def paving(mat, u0, d0, u1, d1):
    nx, nz = math.ceil(u1 - u0), math.ceil(d1 - d0)
    for j in range(nz):
        for i in range(nx):
            corners = [(u0 + x / nx * (u1 - u0), d0 + z / nz * (d1 - d0))
                       for x, z in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))]
            # Two triangles on the same diagonal as the terrain, with every corner on it.
            for ids in ((0, 1, 2), (0, 2, 3)):
                face(mat, [(corners[k][0], corners[k][1], ground(*corners[k]) + .045) for k in ids])


def facade(d, holes, front=True):
    # Split actual openings out of the wall; dark glazing sits in the resulting reveals.
    xs = sorted({-half, half, *(x for u, y, w, h in holes for x in (u - w / 2, u + w / 2))})
    ys = sorted({-.35, eaves, *(v for u, y, w, h in holes for v in (y, y + h))})
    for x0, x1 in zip(xs, xs[1:]):
        for y0, y1 in zip(ys, ys[1:]):
            x, y = (x0 + x1) / 2, (y0 + y1) / 2
            if not any(abs(x - u) < w / 2 and low < y < low + h for u, low, w, h in holes):
                box("brick", x, d, y0, x1 - x0, .25, y1 - y0)
    outside = -1 if front else 1
    for u, y, w, h in holes:
        box("frame", u, d + outside * .04, y, w, .075, h)
        box("glass", u, d + outside * .085, y + .065, w - .13, .025, h - .13)
        box("stone", u, d + outside * .12, y - .06, w + .12, .38, .065)
        box("frame", u, d + outside * .105, y + .04, .035, .025, h - .08)
        if h > 3:
            for row in range(1, 7):
                box("frame", u, d + outside * .11, y + h * row / 7, w - .10, .03, .045)
        else:
            box("frame", u, d + outside * .11, y + h * .6, w - .10, .025, .035)


facade(0, [(0, .10, 2.10, 5.53), (-3.95, .30, 1.12, 2.18), (3.95, .30, 1.12, 2.18),
           (-3.95, 3.65, 1.12, 1.48), (3.95, 3.65, 1.12, 1.48)])
facade(body_depth, [(-3.7, .3, 1.8, 2.15), (3.7, .3, 1.8, 2.15), (0, 3.65, 1.8, 1.48)], False)
for side in (-1, 1):
    box("brick", side * (half - .12), body_depth / 2, -.35, .25, body_depth, eaves + .35)
    box("stone", side * (half - .12), body_depth / 2, -.15, .28, body_depth, .31)
    # Side windows are an interpretation where the street-side trees hide the wall.
    for d in (2.1, 6.6):
        for y in (.7, 3.7):
            box("frame", side * (half + .025), d, y, .06, 1.15, 1.40)
            box("glass", side * (half + .065), d, y + .065, .025, 1.02, 1.27)
            box("stone", side * (half + .10), d, y - .06, .36, 1.28, .065)
box("stone", 0, -.27, .02, 2.35, .95, .105, "bluestone")
beam("metal", (.30, -.16, .75), (.30, -.16, 1.40), .018)

# Hipped roof, with a short ridge along the wider axis and a row of photovoltaic panels on its front slope.
overhang = .28
x, front, back = half + overhang, -overhang, body_depth + overhang
mid = body_depth / 2
short_ridge = max(.2, x - (back - front) / 2)
for corners in [
    [(-x, front, eaves), (x, front, eaves), (short_ridge, mid, ridge), (-short_ridge, mid, ridge)],
    [(x, back, eaves), (-x, back, eaves), (-short_ridge, mid, ridge), (short_ridge, mid, ridge)],
    [(-x, back, eaves), (-x, front, eaves), (-short_ridge, mid, ridge)],
    [(x, front, eaves), (x, back, eaves), (short_ridge, mid, ridge)],
]:
    face("roof", corners)
beam("roof", (-short_ridge, mid, ridge + .025), (short_ridge, mid, ridge + .025), .07)
roof_y = lambda d: eaves + (ridge - eaves) * (d - front) / (mid - front)
for column in range(8):
    u = (column - 3.5) * 1.02
    panel = [(u + a, d, roof_y(d) + .065) for a, d in ((-.49, .48), (.49, .48), (.49, 2.25), (-.49, 2.25))]
    face("metal", panel)
    face("solar", [(a, d, y + .008) for a, d, y in panel])
    for row in range(1, 7):
        d = .48 + (2.25 - .48) * row / 7
        face("cells", [(u + a, dd, roof_y(dd) + .078) for a, dd in ((-.46, d), (.46, d), (.46, d + .008), (-.46, d + .008))])
    beam("cells", (u, .50, roof_y(.50) + .08), (u, 2.23, roof_y(2.23) + .08), .006, 4)
for d in (front, back):
    beam("metal", (-x, d, eaves - .075), (x, d, eaves - .075), .072)
for side in (-1, 1):
    beam("metal", (side * x, front, eaves - .10), (side * x, back, eaves - .10), .06)
    beam("metal", (side * (half - .18), -.15, .20), (side * (half - .18), -.15, eaves - .10), .042)
    for y in (1.1, 2.7, 4.5):
        box("metal", side * (half - .18), -.13, y, .11, .08, .025)

# The lower rear extension follows the second measured roof part.
annex = building["parts"][1]
annex_local = [((Vector(p) - origin).dot(along), (Vector(p) - origin).dot(depth)) for p in annex["p"]]
if sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(annex_local, annex_local[1:] + annex_local[:1])) < 0:
    annex_local.reverse()
rear_depth = max(p[1] for p in annex_local)
for a, b in zip(annex_local, annex_local[1:] + annex_local[:1]):
    ya = annex["ridge"] if a[1] < body_depth + .2 else annex["eaves"]
    yb = annex["ridge"] if b[1] < body_depth + .2 else annex["eaves"]
    face("brick", [(*a, -.35), (*b, -.35), (*b, yb), (*a, ya)])
face("roof", [(u, d, annex["ridge"] if d < body_depth + .2 else annex["eaves"]) for u, d in annex_local])


def hedge(u, d, w, length, height):
    y = ground(u, d)
    box("leaves", u, d, y - .2, w, length, height + .2, "hedge")
    n = max(1, math.ceil(max(w, length) / .65))
    for i in range(n):
        t = (i + .5) / n - .5
        cu = u + (t * w if w > length else 0)
        cd = d + (t * length if length >= w else 0)
        ellipsoid("leaves", cu, cd, y + height - .04,
                  (min(.50, w * .6), min(.50, length * .6), .18), 3, 7)


paving("gravel", -2.18, -16.1, 2.18, -.75)
paving("gravel", -7.1, -5.0, 7.1, -1.1)
paving("paving", -5.6, rear_depth + .12, 5.6, rear_depth + 5)
for side in (-1, 1):
    hedge(side * 5.75, -13.50, 7.0, .85, 2.05)
    hedge(side * 9.0, -6.80, .65, 12.7, 2.10)
    hedge(side * 2.60, -8.2, .60, 8.5, .58)
    hedge(side * 2.48, -1.5, .80, 2.10, 3.15)
    for d in (-10.8, -7.2, -3.8):
        hedge(side * 4.25, d, 2.15, 2.10, .70)
    # The two clipped trees have visible trunks and separate leaf clumps, rather than a smooth ball.
    u, d = side * 5.1, -6.4
    y = ground(u, d)
    beam("bark", (u, d, y), (u, d, y + 3.20), .085)
    for branch in (-1, 1):
        beam("bark", (u, d, y + 2.25), (u + branch * .70, d + .18, y + 3.0), .035)
    for i in range(19):
        a = i * 2.39996
        r = math.sqrt((i + .5) / 19) * 1.30
        cu, cd = u + math.cos(a) * r, d + math.sin(a) * r
        ellipsoid("leaves", cu, cd, y + 3.3 + rng.uniform(-.18, .26), (.60, .60, .70), 4, 8)
    solids.append({"m": "old_wood", "p": [[[round(c, 3) for c in point(u + a, d + b)]
                   for a, b in ((-.12, -.12), (.12, -.12), (.12, .12), (-.12, .12))]],
                   "y0": round(y + base - .1, 3), "y1": round(y + base + 2.8, 3), "lm": "kouter_house"})

# A plain letterbox, without its real number or any lettering.
y = ground(-3.0, -14.3)
box("metal", -3.0, -14.3, y, .36, .28, 1.18, "steel")
box("stone", -3.0, -14.46, y + 1.00, .21, .015, .025)

root = bpy.data.objects.new("Kouter house", None)
bpy.context.collection.objects.link(root)
root["origin"] = list(origin)
root["landmark"] = "kouter_house"
root["replaces"] = [outline]
clearing = [[round(c, 3) for c in point(u, d)] for u, d in ((-9.4, -16.2), (9.4, -16.2), (9.4, rear_depth + 5.2), (-9.4, rear_depth + 5.2))]
root["clear"] = [clearing]
sizes = json.loads((ROOT / "web/public/textures/sizes.json").read_text())


def linear(v):
    return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4


triangles = 0
for name, polygons in faces.items():
    color, texture = palette[name]
    rgb = tuple(linear(int(color[k:k + 2], 16) / 255) for k in (0, 2, 4))
    mat = bpy.data.materials.new("kouter_" + name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*rgb, 1)
    shader.inputs["Roughness"].default_value = .22 if name in ("glass", "solar") else .90
    shader.inputs["Metallic"].default_value = .22 if name in ("glass", "solar", "metal") else 0
    if texture:
        mat["texture"], mat["tint"] = texture, "#" + color
        mat["normalScale"] = .20 if name == "roof" else .45
    mesh = bpy.data.meshes.new(name)
    vertices, indices = [], []
    for polygon in polygons:
        indices.append(list(range(len(vertices), len(vertices) + len(polygon))))
        vertices.extend(polygon)
    mesh.from_pydata(vertices, [], indices)
    mesh.update()
    mesh.materials.append(mat)
    if texture:
        uv = mesh.uv_layers.new(name="UVMap")
        for poly in mesh.polygons:
            normal = poly.normal
            u = Vector((1, 0, 0)) if abs(normal.z) > .99 else Vector((0, 0, 1)).cross(normal).normalized()
            v = normal.cross(u)
            for k in poly.loop_indices:
                p = mesh.vertices[mesh.loops[k].vertex_index].co
                uv.data[k].uv = (p.dot(u) / sizes[texture], p.dot(v) / sizes[texture])
    if name == "leaves":
        colors = mesh.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
        node = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        node.layer_name = "Color"
        mat.node_tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])
        for poly in mesh.polygons:
            shade = (.72 + .23 * max(0, poly.normal.z)) * rng.uniform(.86, 1.13)
            for k in poly.loop_indices:
                colors.data[k].color = (*(c * shade for c in rgb), 1)
    obj = bpy.data.objects.new("kouter_" + name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)

output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_extras=True)
approach = [[round(c, 3) for c in point(0, d)] for d in (-15.8, -.8)]
data_output.write_text(json.dumps({"origin": list(origin), "clear": [clearing], "approach": approach, "solids": solids}, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"Kouter house: {triangles} triangles, {len(faces)} materials, {len(solids)} collision blocks, {output.stat().st_size} bytes")
