"""Shared parts of the Blender tools that build baked props (tools/market_stall.py, tools/zombie_items.py).

Imported by those scripts as they run in Blender (they put tools/ on sys.path). It holds:
- the CC0 textures from Poly Haven, downloaded once into source/textures/ (git-ignored);
- materials made from them (tex_material: a texture at its size in metres, its colour graded and tinted, more nodes
  for wear) and plain ones;
- geometry in the game's frame (y up, front -z; G turns it to Blender's): boxes, beams, tubes, tubes along a path, rings,
  cloth sheets, each given a 'tex' UV map for its texture and filed in a list (DEFAULT unless one is given);
- the bake: Cycles bakes each joined mesh's colour, ambient occlusion, normals, roughness and metal onto an atlas
  ('atlas' UVs), and final_material makes one material of them (colour with the occlusion in, normals, metal/roughness);
- the export to a GLB.
"""
import json
import math
import os
import urllib.request
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "source" / "textures"
MATS = {}
# Where the geometry helpers file a part when no list is given (a script sets it to its own: STALL = DEFAULT).
DEFAULT = []


def G(x, y, z):
    """The game's frame (y up, front -z) to Blender's (z up); the GLB export turns it back."""
    return Vector((x, -z, y))


def fetch(url, dest):
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "briel-walkthrough/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


def poly_haven(asset):
    """The asset's 1k colour, normal (OpenGL) and roughness maps: {kind: path}, 'arm' when roughness is packed."""
    req = urllib.request.Request(f"https://api.polyhaven.com/files/{asset}", headers={"User-Agent": "briel-walkthrough/0.1"})
    listing = CACHE / asset / "files.json"
    if listing.exists():
        files = json.loads(listing.read_text())
    else:
        with urllib.request.urlopen(req, timeout=60) as r:
            files = json.load(r)
        listing.parent.mkdir(parents=True, exist_ok=True)
        listing.write_text(json.dumps(files))
    out = {}
    for kind, keys in (("color", ["Diffuse"]), ("normal", ["nor_gl"]), ("rough", ["Rough", "arm"])):
        key = next(k for k in keys if k in files)
        url = files[key]["1k"]["jpg"]["url"]
        out[kind] = fetch(url, CACHE / asset / Path(url).name)
        if kind == "rough":
            out["arm"] = key == "arm"
    return out


def node(nt, kind, **inputs):
    n = nt.nodes.new(kind)
    for k, v in inputs.items():
        n.inputs[k].default_value = v
    return n


def srgb(hex_):
    """'#rrggbb' to linear RGBA."""
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(int(hex_[1:3], 16)), lin(int(hex_[3:5], 16)), lin(int(hex_[5:7], 16)), 1.0)


def mix(nt, a, b, fac, blend="MIX"):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    m.blend_type = blend
    for sock, v in (("Factor", fac), ("A", a), ("B", b)):
        if isinstance(v, (int, float, tuple)):
            m.inputs[sock].default_value = v
        else:
            nt.links.new(v, m.inputs[sock])
    return m.outputs["Result"]


def mixf(nt, a, b, fac):
    """a to b by fac, as floats (a roughness)."""
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "FLOAT"
    for sock, v in (("Factor", fac), ("A", a), ("B", b)):
        if isinstance(v, (int, float)):
            m.inputs[sock].default_value = v
        else:
            nt.links.new(v, m.inputs[sock])
    return m.outputs["Result"]


def math_(nt, op, a, b=0.0, clamp=False):
    m = nt.nodes.new("ShaderNodeMath")
    m.operation = op
    m.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if isinstance(v, (int, float)):
            m.inputs[i].default_value = v
        else:
            nt.links.new(v, m.inputs[i])
    return m.outputs[0]


def tex_material(name, asset, size, tint, sat=1.0, bright=1.0, rough=1.0, metal=0.0, nstrength=1.0, shade=None):
    """A material from a Poly Haven texture at `size` metres a tile on the 'tex' UVs, its colour desaturated by
    `sat`, times `bright` and `tint`. `shade(nt, colour, rough)`: more nodes on the colour and roughness (the
    stripes, rust, wear); returns (colour, rough)."""
    t = poly_haven(asset)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "tex"
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1 / size, 1 / size, 1)
    nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])

    def image(path, colour):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(str(path), check_existing=True)
        n.image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
        return n

    hsv = node(nt, "ShaderNodeHueSaturation", Saturation=sat, Value=bright)
    nt.links.new(image(t["color"], True).outputs["Color"], hsv.inputs["Color"])
    colour = mix(nt, hsv.outputs["Color"], tint, 1.0, "MULTIPLY")
    rimg = image(t["rough"], False)
    if t["arm"]:
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(rimg.outputs["Color"], sep.inputs["Color"])
        r = sep.outputs["Green"]
    else:
        r = rimg.outputs["Color"]
    r = math_(nt, "MULTIPLY", r, rough, clamp=True)
    if shade:
        colour, r = shade(nt, colour, r)
    nt.links.new(colour, p.inputs["Base Color"])
    nt.links.new(r, p.inputs["Roughness"])
    p.inputs["Metallic"].default_value = metal
    nm = node(nt, "ShaderNodeNormalMap", Strength=nstrength)
    nm.uv_map = "tex"
    nt.links.new(image(t["normal"], False).outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
    m["metal"] = metal
    MATS[name] = m
    return m


def plain_material(name, hex_, rough, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = srgb(hex_)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m["metal"] = metal
    MATS[name] = m
    return m


def position(nt):
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(nt.nodes.new("ShaderNodeNewGeometry").outputs["Position"], sep.inputs[0])
    return sep


def noise(nt, scale, detail=4.0, stretch=(1, 1, 1)):
    n = node(nt, "ShaderNodeTexNoise", Scale=scale, Detail=detail)
    if stretch != (1, 1, 1):
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = stretch
        nt.links.new(nt.nodes.new("ShaderNodeNewGeometry").outputs["Position"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
    else:
        nt.links.new(nt.nodes.new("ShaderNodeNewGeometry").outputs["Position"], n.inputs["Vector"])
    return n.outputs["Fac"]


def smooth(nt, v, lo, hi):
    """smoothstep(lo, hi, v) via a Map Range node."""
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHSTEP"
    mr.inputs["From Min"].default_value = lo
    mr.inputs["From Max"].default_value = hi
    nt.links.new(v, mr.inputs["Value"])
    return mr.outputs["Result"]


def steel_shade(nt, colour, rough):
    """Galvanised tube: dull, mottled; rust and dirt low down, where it stands in the wet."""
    pos = position(nt)
    low = math_(nt, "SUBTRACT", 1.0, smooth(nt, pos.outputs["Z"], 0.0, 0.45))
    rust = math_(nt, "MULTIPLY", low, smooth(nt, noise(nt, 18.0, 6.0), 0.42, 0.62))
    c = mix(nt, colour, srgb("#6b4a33"), math_(nt, "MULTIPLY", rust, 0.85))
    r = mixf(nt, rough, 0.9, rust)
    mottle = smooth(nt, noise(nt, 30.0, 3.0), 0.3, 0.7)
    c = mix(nt, c, srgb("#8d9294"), math_(nt, "MULTIPLY", mottle, 0.25))
    return c, r


def wood_shade(nt, colour, rough):
    """Greyed by the weather in patches, darker in the grain's dirt."""
    grey = smooth(nt, noise(nt, 3.0, 4.0), 0.4, 0.7)
    c = mix(nt, colour, srgb("#8a8378"), math_(nt, "MULTIPLY", grey, 0.3))
    return c, rough


def finish(obj, mat, group, tex_scale=1.0):
    """Give `obj` its material and a 'tex' UV map (cube projection in metres, unless it has one) and file it."""
    obj.data.materials.clear()
    if isinstance(mat, (list, tuple)):
        for m in mat:
            obj.data.materials.append(m)
    else:
        obj.data.materials.append(mat)
    if not obj.data.uv_layers:
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.cube_project(cube_size=tex_scale, correct_aspect=False, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.uv_layers[0].name = "tex"
    group.append(obj)
    return obj


def apply_mods(obj):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def bevel(obj, width, segs=1):
    m = obj.modifiers.new("bevel", "BEVEL")
    m.width, m.segments, m.limit_method = width, segs, "ANGLE"
    apply_mods(obj)


def cuboid(name, cx, cy, cz, w, h, d, mat, group=None, bev=0.003, rot=(0, 0, 0)):
    """A box w (x) by h (y) by d (z) centred on (cx, cy, cz), game frame; `rot` in the game's axes (radians)."""
    group = DEFAULT if group is None else group
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((w, d, h)), verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    rx, ry, rz = rot
    obj.matrix_world = Matrix.Translation(G(cx, cy, cz)) @ Matrix.Rotation(ry, 4, "Z") @ Matrix.Rotation(-rz, 4, "Y") @ Matrix.Rotation(-rx, 4, "X")
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if bev:
        bevel(obj, bev)
    return finish(obj, mat, group)


def beam(name, a, b, w, mat, group=None, bev=0.003):
    """A square beam w by w from a to b (game frame)."""
    group = DEFAULT if group is None else group
    pa, pb = G(*a), G(*b)
    d = pb - pa
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((w, w, d.length)), verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = Matrix.Translation((pa + pb) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4()
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if bev:
        bevel(obj, bev)
    return finish(obj, mat, group)


def tube(name, a, b, r, mat, group=None, seg=12, caps=True):
    """A round tube from a to b (game frame)."""
    group = DEFAULT if group is None else group
    pa, pb = G(*a), G(*b)
    d = pb - pa
    bpy.ops.mesh.primitive_cylinder_add(vertices=seg, radius=r, depth=d.length, location=(pa + pb) / 2,
                                        end_fill_type="NGON" if caps else "NOTHING")
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return finish(obj, mat, group)


def path_tube(name, pts, r, mat, group=None, seg=8):
    """A tube along a polyline of game points (a cable, a rope), as a curve with a round bevel."""
    group = DEFAULT if group is None else group
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = max(1, seg // 4)
    cu.use_fill_caps = True
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for p, q in zip(sp.points, pts):
        p.co = (*G(*q), 1)
    ob = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(ob)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.active_object
    return finish(obj, mat, group, tex_scale=0.3)


def torus(name, at, axis, R, r, mat, group=None):
    group = DEFAULT if group is None else group
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=16, minor_segments=6, location=G(*at))
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = G(*axis).to_track_quat("Z", "Y").to_euler()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return finish(obj, mat, group, tex_scale=0.2)


def sheet(name, nu, nv, at, mat, group, thick, uv_size):
    """A cloth: a grid of nu by nv cells at `at(u, v)` (game points, u and v from 0 to 1), its 'tex' UVs
    uv_size(u, v) in metres, made `thick` with a solidify."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("tex")
    vs = [[bm.verts.new(G(*at(i / nu, j / nv))) for i in range(nu + 1)] for j in range(nv + 1)]
    for j in range(nv):
        for i in range(nu):
            f = bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]))
            for lp, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                lp[uvl].uv = uv_size(a / nu, b / nv)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if thick:
        s = obj.modifiers.new("solid", "SOLIDIFY")
        s.thickness, s.offset = thick, 0.0
        apply_mods(obj)
    return finish(obj, mat, group)


def frac(v):
    return v - math.floor(v)


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = o.data.name = name
    o.data.set_sharp_from_angle(angle=math.radians(40))
    return o


def atlas_uvs(obj, margin):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    a = obj.data.uv_layers.new(name="atlas")
    obj.data.uv_layers.active = a
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake_images(prefix, size):
    imgs = {}
    for kind in ("albedo", "ao", "normal", "rough", "metal"):
        im = bpy.data.images.new(f"{prefix}_{kind}", size, size, alpha=False, float_buffer=kind == "normal")
        im.colorspace_settings.name = "sRGB" if kind == "albedo" else "Non-Color"
        imgs[kind] = im
    return imgs


def target(obj, img):
    for m in obj.data.materials:
        nt = m.node_tree
        n = nt.nodes.get("bake_target") or nt.nodes.new("ShaderNodeTexImage")
        n.name = "bake_target"
        n.image = img
        nt.nodes.active = n


def emit_metal(obj, on):
    for m in obj.data.materials:
        p = m.node_tree.nodes["Principled BSDF"]
        v = float(m.get("metal", 0.0)) if on else 0.0
        p.inputs["Emission Color"].default_value = (v, v, v, 1)
        p.inputs["Emission Strength"].default_value = 1.0 if on else 0.0


def bake(obj, hidden, size):
    imgs = bake_images(obj.name.lower(), size)
    for o in hidden:
        o.hide_render = True
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for kind, typ, samples, extra in (("albedo", "DIFFUSE", 16, {"pass_filter": {"COLOR"}}),
                                       ("ao", "AO", 256, {}),
                                       ("normal", "NORMAL", 16, {"normal_space": "TANGENT"}),
                                       ("rough", "ROUGHNESS", 16, {}),
                                       ("metal", "EMIT", 4, {})):
        bpy.context.scene.cycles.samples = samples
        target(obj, imgs[kind])
        if kind == "metal":
            emit_metal(obj, True)
        bpy.ops.object.bake(type=typ, margin=6, use_clear=True, **extra)
        if kind == "metal":
            emit_metal(obj, False)
        print(f"baked {obj.name} {kind}")
    for o in hidden:
        o.hide_render = False
    return imgs


def px(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def final_material(obj, imgs, tmp, half=True):
    """The baked maps into one material: colour with the occlusion in, the normals, metal/roughness."""
    alb, ao = px(imgs["albedo"]), px(imgs["ao"])
    occ = 0.12 + 0.88 * ao[..., :1] ** 1.15
    base = alb.copy()
    base[..., :3] = alb[..., :3] * occ
    w, h = imgs["albedo"].size
    out = {}
    for kind, data, cs in (("color", base, "sRGB"), ("normal", px(imgs["normal"]), "Non-Color")):
        im = bpy.data.images.new(f"{obj.name.lower()}_{kind}", w, h, alpha=False)
        im.colorspace_settings.name = cs
        im.pixels.foreach_set(np.ascontiguousarray(data).ravel())
        if kind == "normal" and half:
            im.scale(w // 2, h // 2)  # half the colour's size: a phone's memory (the weave is finer than it shows)
        im.filepath_raw = os.path.join(tmp, f"{obj.name.lower()}_{kind}.png")
        im.file_format = "PNG"
        im.save()
        out[kind] = im
    mr = np.ones((h, w, 4), dtype=np.float32)
    mr[..., 1] = px(imgs["rough"])[..., 0]
    mr[..., 2] = px(imgs["metal"])[..., 0]
    im = bpy.data.images.new(f"{obj.name.lower()}_mr", w, h, alpha=False)
    im.colorspace_settings.name = "Non-Color"
    im.pixels.foreach_set(mr.ravel())
    if half:
        im.scale(w // 2, h // 2)
    im.filepath_raw = os.path.join(tmp, f"{obj.name.lower()}_mr.png")
    im.file_format = "PNG"
    im.save()
    out["mr"] = im

    m = bpy.data.materials.new(obj.name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "atlas"

    def image(im):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = im
        nt.links.new(uv.outputs["UV"], n.inputs["Vector"])
        return n

    nt.links.new(image(out["color"]).outputs["Color"], p.inputs["Base Color"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(image(out["mr"]).outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], p.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], p.inputs["Metallic"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = "atlas"
    nt.links.new(image(out["normal"]).outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
    m.use_backface_culling = True
    obj.data.materials.clear()
    obj.data.materials.append(m)
    obj.data.uv_layers.remove(obj.data.uv_layers["tex"])
    return m


def bake_setup(cpu=False):
    """Cycles on the graphics card (OptiX or CUDA) unless `cpu`, a white sky for the occlusion (it looks 0.7 m), and a
    grey ground under the props, so their feet are shaded. Returns the ground (remove it before the export)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    if not cpu:
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for kind in ("OPTIX", "CUDA"):
                try:
                    prefs.compute_device_type = kind
                    prefs.get_devices()
                    if any(d.type == kind for d in prefs.devices):
                        for d in prefs.devices:
                            d.use = d.type == kind
                        scene.cycles.device = "GPU"
                        print("bake on", kind)
                        break
                except TypeError:
                    continue
        except Exception as e:  # no graphics card: the processor
            print("bake on the processor", e)
    scene.render.bake.margin = 6
    scene.render.bake.use_clear = True
    world = bpy.data.worlds.new("Bake")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    world.light_settings.distance = 0.7  # how far the ambient occlusion looks
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.name = "BakeGround"
    ground.data.materials.append(plain_material("ground", "#808080", 0.8))
    return ground


def export_glb(objs, out):
    """The objects into a GLB at `out`, their images as JPEG."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    opts = dict(filepath=out, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                export_texcoords=True, export_normals=True, export_tangents=False, export_cameras=False, export_lights=False,
                export_image_format="JPEG")
    try:
        bpy.ops.export_scene.gltf(**opts, export_image_quality=86)
    except TypeError:
        bpy.ops.export_scene.gltf(**opts, export_jpeg_quality=86)
    print("written", out, os.path.getsize(out), "bytes")
