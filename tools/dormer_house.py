"""Build the exterior with Blender: blender -b -P tools/dormer_house.py -- output.glb [editable.blend]."""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


bpy.ops.wm.read_factory_settings(use_empty=True)
output, *editable = sys.argv[sys.argv.index("--") + 1:]
data = Path(__file__).resolve().parents[1] / "web/src/data/village.json"
front_left, front_right = Vector((187.36, -985.94)), Vector((176.61, -988.45))
footprint = next(p["p"][0] for p in json.loads(data.read_text())["prisms"]
                 if p["m"] == "nb_yellow" and [187.36, -985.94] in p["p"][0])
origin = (front_left + front_right) / 2
right = (front_right - front_left).normalized()
depth = Vector((right.y, -right.x))
w = (front_right - front_left).length / 2
root = bpy.data.objects.new("Dormer house", None)
bpy.context.collection.objects.link(root)
root["origin"] = list(origin)
root["landmark"] = "dormer_house"
root["replaces"] = [footprint]
root.rotation_euler.z = math.atan2(-right.y, right.x)

palette = {
    "brick": ("d8ad91", "nb_brick"), "tiles": ("50504f", "roof_tiles"),
    "frames": ("393633", None), "glass": ("6d7777", None),
    "wood": ("77513a", None), "stone": ("87837a", None),
    "solar": ("293441", None), "metal": ("565851", None),
}
faces = {name: [] for name in palette}


def box(mat, x, y, z, width, length, height):
    """Box centred in plan, with its base at z."""
    a, b = width / 2, length / 2
    corners = [(x+dx, y+dy, z+dz) for dz in (0, height)
               for dx, dy in ((-a, -b), (a, -b), (a, b), (-a, b))]
    for ids in ((3,2,1,0),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)):
        faces[mat].append([corners[i] for i in ids])


def roof(x, y, width, length, eaves, rise):
    a, b = width/2, length/2
    for side in (-1, 1):
        edge, peak = y + side*b, eaves + rise
        faces["tiles"].append([(x-a,edge,eaves),(x+a,edge,eaves),(x+a,y,peak),(x-a,y,peak)][::-side])
        faces["brick"].append([(x+side*a,y-b,eaves),(x+side*a,y+b,eaves),(x+side*a,y,peak)][::side])


def window(x, y, z, width, height, side=0):
    def layer(mat, offset, bottom, span, tall):
        if side:
            box(mat, x+side*offset, y, bottom, .05, span, tall)
        else:
            box(mat, x, y-offset, bottom, span, .05, tall)
    layer("frames", .035, z, width, height)
    layer("glass", .07, z+.08, width-.16, height-.16)
    layer("frames", .10, z+.07, .035, height-.14)
    layer("frames", .10, z+height*.6, width-.12, .035)
    layer("stone", .115, z-.08, width+.14, .09)


eaves, length, rise = 6.4, 8.9, 3.25
arch_radius, spring = .94, 1.69
# Split the front wall around the actual recessed doorway.
for sign in (-1, 1):
    box("brick", sign*(w+arch_radius)/2, .11, -.5, w-arch_radius, .22, eaves+.5)
    box("brick", sign*(w-.1), length/2, -.5, .2, length, eaves+.5)
box("brick", 0, length-.1, -.5, 2*w, .2, eaves+.5)
box("wood", 0, .48, -.12, 2.05, .12, 2.95)
box("stone", 0, .18, -.08, 2, .75, .12)
for i in range(16):
    a, b = [math.pi*k/16 for k in (i, i+1)]
    x1, h1 = arch_radius*math.cos(a), spring+arch_radius*math.sin(a)
    x2, h2 = arch_radius*math.cos(b), spring+arch_radius*math.sin(b)
    faces["brick"].append([(x2,0,h2),(x1,0,h1),(x1,0,eaves),(x2,0,eaves)])
    faces["brick"].append([(x1,0,h1),(x2,0,h2),(x2,.45,h2),(x1,.45,h1)])
for side in (-1, 1):
    for i in range(8):
        t = (i+.5)/8
        box("wood", side*(1.06+t*.85), -.09, .12, .099, .10,
            spring+arch_radius*math.sqrt(1-t*t)-.12)
    for z in (.56, 1.5):
        box("metal", side*1.48, -.15, z, .79, .04, .055)
    window(side*3.0, 0, .33, 1.18, 2.24)
    for y, z in ((2.3,3.85),(6.4,3.85),(4.45,6.62)):
        window(side*w, y, z, .93, 1.22, side)
for i in range(-2, 3):
    window(i*2.07, 0, 3.75, 1.23, 1.63)
roof(0,length/2,2*w+.22,length+.18,eaves,rise)
box("metal", 0, -.11, eaves-.09, 2*w+.2, .15, .12)
for side in (-1, 1):
    box("metal", side*(w-.09), -.09, .03, .08, .09, eaves-.08)
box("brick", -w+.55, 4.7, 8.55, .82, .86, 1.37)
box("stone", -w+.55, 4.7, 9.92, .94, .97, .12)
# Dormer cheeks run back into the main slope. A shallow hipped cap covers them.
box("brick", 0, 2.49, 7.05, 1.92, 2.4, 1.66)
window(0, 1.29, 7.31, 1.03, 1.19)
for a, b in [((-1.1,1.14),(1.1,1.14)),((1.1,1.14),(1.1,3.7)),
             ((1.1,3.7),(-1.1,3.7)),((-1.1,3.7),(-1.1,1.14))]:
    faces["tiles"].append([(*a,8.72),(*b,8.72),(0,2.72,9.36)])
for sign in (-1, 1):
    for column in range(3):
        for row in range(2):
            x, y = sign*(2.07+column*.98), .65+row*1.6
            faces["solar"].append([(x+dx,y+dy,eaves+.075+rise*(y+dy+.09)/(length/2+.09))
                                   for dx,dy in ((-.47,0),(.47,0),(.47,1.55),(-.47,1.55))])
# The lower wing follows the surveyed rear corners.
rear = [((Vector(p)-origin).dot(right),(Vector(p)-origin).dot(depth)) for p in footprint]
back = [(x,y) for x,y in rear if y > length+1]
back = [(w,length),*sorted(back,key=lambda p:-p[0]),(-w,length)]
for a,b in zip(back,back[1:]+back[:1]):
    faces["brick"].append([(*a,-.55),(*b,-.55),(*b,2.75),(*a,2.75)])
    faces["tiles"].append([(*a,2.75),(*b,2.75),(0,15,4.15)])

for name, polygons in faces.items():
    color, texture = palette[name]
    mat = bpy.data.materials.new(name)
    rgb = [((int(color[i:i+2],16)/255+.055)/1.055)**2.4 for i in (0,2,4)]
    mat.diffuse_color = (*rgb,1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*rgb,1)
    shader.inputs["Roughness"].default_value = .34 if name in ("glass","solar") else .85
    if texture:
        mat["texture"], mat["tint"] = texture, "#"+color
    mesh = bpy.data.meshes.new(name)
    verts, indices = [], []
    for polygon in polygons:
        indices.append(list(range(len(verts),len(verts)+len(polygon))))
        verts.extend(polygon)
    mesh.from_pydata(verts, [], indices)
    mesh.update()
    uv = mesh.uv_layers.new()
    for poly in mesh.polygons:
        n = poly.normal
        u = Vector((1,0,0)) if abs(n.z)>.99 else Vector((0,0,1)).cross(n).normalized()
        v = n.cross(u)
        for k in poly.loop_indices:
            p = mesh.vertices[mesh.loops[k].vertex_index].co
            uv.data[k].uv = (p.dot(u)/2, p.dot(v)/2)
    obj = bpy.data.objects.new(name,mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    mesh.materials.append(mat)
if editable:
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(editable[0]).resolve()))
bpy.ops.export_scene.gltf(filepath=str(Path(output).resolve()), export_extras=True, export_format="GLB")
