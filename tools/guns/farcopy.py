"""The far copy of a gun: what the other players' figures hold and what lies in the world, cheap to draw.

Not run by itself: each gun's script (tools/guns/*.py, tools/lasergun.py) calls `far(ROOT)` once its gun is built and
before it is written. It adds a second node next to the gun, `<gun>_far`, with `<gun>_far_body` (one mesh) and, where
the gun has Paintball's kit, `<gun>_far_kit`. The gun itself, its hands and every node under them stay as they are.

What big multiplayer shooters do, and what is taken from it: the gun in your own hands (the "view model") is the only
one drawn in full; everyone else's (the "world model") is a separate, lighter model with its own levels of detail,
and the farthest level is one mesh with very few materials, so it is a draw or two. The light model drops the parts
too small to see from a few metres (a size limit per part, as a part remover does), keeps the silhouette, and
reduces the rest to a triangle budget; the page switches to it by its size on screen (web/src/weapon.ts liteGun).

Here, in the gun's own frame (the grip at the origin, as the gun), in this order:
  1. every part of the gun, its moving parts where they rest, joined into one mesh (not the hands, not the kit);
  2. left out: parts smaller than `small` across or thinner than `thin` both ways (screws, pins, the grip's raised
     points, sight dots, a rail's teeth, a trigger), and parts no ray from outside can reach (a round in the chamber);
     at the distance the page uses this copy from, they are a pixel or less;
  3. flat faces that cuts split into many made one again (the shape stays the same);
  4. the materials folded to a few: the accents into the part they sit on (as weapon.ts FOLD), then one material
     per role of the paint look (weapon.ts ROLE: body, trim, deep), so the toy colours still show, unless two of a
     role look different in the real colours (a wooden stock and a black receiver stay apart); a material that
     covers little goes into the nearest in colour, one of its role first. Glowing parts and a coloured accent
     that covers something keep their own;
  5. each part collapsed on its own (Blender's Decimate, Collapse) to its share of about `budget` triangles, by its
     surface, so a thin part (a buffer tube, a sling loop) keeps its shape; then shaded smooth with hard edges past
     35 degrees.
The kit (a hopper, an air tank) is collapsed to half on its own, so it shows and hides with Paintball as before.
The result: 1 200 to 1 700 triangles and 2 to 4 materials per gun, against 13 000 to 17 500 and up to 17.
"""
import math

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# The accents fold into the part they sit on, where the gun has it (weapon.ts FOLD for the others' hands).
FOLD = {
    "Dot": "Steel", "Brass": "Steel", "Glass": "Dark", "Lens": "Dark", "RedDot": "Dark", "Grip": "Dark", "Warhead": "Olive",
    "LaserFin": "Steel", "LaserLens": "Dark", "LaserReticle": "Dark", "LaserGlass": "Dark",
    "LaserBar0": "LaserGlow", "LaserBar1": "LaserGlow", "LaserBar2": "LaserGlow", "LaserBar3": "LaserGlow", "LaserBar4": "LaserGlow",
}
# The paint look's roles (weapon.ts ROLE): one material per role at most, so each copy still takes its toy colours.
ROLE = {
    "Polymer": "body", "Wood": "body", "Olive": "body", "Warhead": "body", "LaserPolymer": "body", "RifleAnodised": "body",
    "SniperStock": "body",
    "Steel": "trim", "Brass": "trim", "LaserAnodised": "trim", "LaserFin": "trim", "PistolSlide": "trim", "ShotgunBlued": "trim",
    "RiflePhosphate": "trim",
    "Dark": "deep", "Grip": "deep", "LaserAccent": "deep",
    "Glass": "lens", "LaserGlass": "lens",
}
ALIKE = 0.06  # two materials of one role look alike under this difference in any colour channel (as seen, sRGB)
NEAR = 0.2  # two greys of one role that differ less than this go together when the smaller covers less than BIG
BIG = 0.15
SCARCE = 0.08  # a material with less of the surface than this goes into another of its role, or the nearest in colour


def _colour(m):
    p = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes and m.node_tree else None
    return Vector(p.inputs["Base Color"].default_value[:3]) if p else Vector(m.diffuse_color[:3])


def _apart(a, b):
    """How different two materials look: the largest difference of their colour channels, as seen (sRGB)."""
    return max(abs(x ** (1 / 2.2) - y ** (1 / 2.2)) for x, y in zip(_colour(a), _colour(b)))


def _grey(m):
    """A black, grey or near it (the olive of a sleeve is not): its channels within 0.06 of each other, as seen."""
    c = [x ** (1 / 2.2) for x in _colour(m)]
    return max(c) - min(c) < 0.06


def _vivid(m):
    """A coloured accent (the laser's orange), not one of the blacks and greys: it is what you know the gun by."""
    c = _colour(m)
    return max(c) - min(c) > 0.1


def _glows(m):
    p = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes and m.node_tree else None
    return bool(p) and p.inputs["Emission Strength"].default_value > 0 and max(p.inputs["Emission Color"].default_value[:3]) > 0


def _parts(o):
    """The gun's meshes under `o`: not the hands; the kit apart."""
    for c in o.children:
        if c.name.endswith("_hands"):
            continue
        if c.type == "MESH":
            yield c
        yield from _parts(c)


def _gather(root, objs, fold):
    """`objs` as one bmesh in the root's frame, with their modifiers; `fold`(name) gives each face's material name."""
    dg = bpy.context.evaluated_depsgraph_get()
    inv = root.matrix_world.inverted()
    bm = bmesh.new()
    mats, index = [], {}
    for o in objs:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        me.transform(inv @ o.matrix_world)
        if (inv @ o.matrix_world).determinant() < 0:
            me.flip_normals()
        remap = []
        for slot in o.material_slots:
            name = fold(slot.material.name) if slot.material else None
            if name not in index:
                index[name] = len(mats)
                mats.append(bpy.data.materials.get(name) if name else None)
            remap.append(index[name])
        for p in me.polygons:
            p.material_index = remap[p.material_index] if remap else 0
        bm.from_mesh(me)  # adds to what is there
        bpy.data.meshes.remove(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    return bm, mats


def _islands(bm):
    bm.faces.ensure_lookup_table()
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, isl = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            isl.append(g)
            for v in g.verts:
                for h in v.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        out.append(isl)
    return out


def _directions():
    out = []
    for x in (-1, 0, 1):
        for y in (-1, 0, 1):
            for z in (-1, 0, 1):
                if x or y or z:
                    out.append(Vector((x, y, z)).normalized())
    return out


def _seen(isl, tree, dirs):
    """Can a ray from outside reach any of the part's faces? From up to 300 of its faces spread over it, on both sides
    of each (a part's faces may face either way), along each of 26 directions: one that leaves without touching
    anything is enough."""
    step = max(1, len(isl) // 300)
    for f in isl[::step]:
        mid = f.calc_center_median()
        for n in (f.normal, -f.normal):
            start = mid + n * 1e-4
            for d in dirs:
                if d.dot(n) > 0.05 and tree.ray_cast(start, d, 5.0)[0] is None:
                    return True
    return False


def _object(name, bm, mats, parent):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    return o


def _collapse(o, ratio):
    """Collapse `o` to `ratio` of its triangles (Blender's Decimate, Collapse)."""
    if ratio < 1:
        mod = o.modifiers.new("far", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        o.modifiers.remove(mod)
        old = o.data
        o.data = me
        bpy.data.meshes.remove(old)


def _shares(budget, weights, tris, floor):
    """Each part's triangles of `budget`, by its weight, at least `floor`, never more than it has."""
    out = [None] * len(tris)
    free = set(range(len(tris)))
    rest = budget
    while free:
        total = sum(weights[i] for i in free) or 1
        done = [i for i in free if max(floor, rest * weights[i] / total) >= tris[i]]
        if not done:
            break
        for i in done:
            out[i] = tris[i]
            rest -= tris[i]
            free.discard(i)
    total = sum(weights[i] for i in free) or 1
    for i in free:
        out[i] = max(floor, rest * weights[i] / total)
    return out


def _reduce_parts(bm, budget, floor=8):
    """Each part on its own, collapsed to its share of `budget`: a share by its surface (to the power 0.7, so a small
    part keeps a little more than its size), at least `floor` triangles. One collapse over the whole gun would take
    a thin part (a buffer tube, a trigger guard) down to a spike."""
    bm.faces.index_update()
    islands = _islands(bm)
    weights = [sum(f.calc_area() for f in isl) ** 0.7 for isl in islands]
    tris = [sum(len(f.verts) - 2 for f in isl) for isl in islands]
    shares = _shares(budget, weights, tris, floor)
    out = bmesh.new()
    for isl, n, share in zip(islands, tris, shares):
        part = bm.copy()
        part.faces.ensure_lookup_table()
        mine = {f.index for f in isl}
        bmesh.ops.delete(part, geom=[f for i, f in enumerate(part.faces) if i not in mine], context="FACES")
        bmesh.ops.delete(part, geom=[v for v in part.verts if not v.link_faces], context="VERTS")
        me = bpy.data.meshes.new("far_part")
        part.to_mesh(me)
        part.free()
        o = bpy.data.objects.new("far_part", me)
        bpy.context.scene.collection.objects.link(o)
        _collapse(o, share / n if n else 1)
        out.from_mesh(o.data)
        old = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.meshes.remove(old)
    bm.free()
    return out


def _reduce(o, ratio):
    """Collapse `o` to `ratio` of its triangles, then shade it smooth with hard edges past 35 degrees."""
    _collapse(o, ratio)
    me = o.data
    me.name = o.name
    me.validate()  # the collapse can leave a face of no area
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(35))
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def far(root, budget=1200, small=0.012, thin=0.007):
    """Add `<gun>_far` next to `root` (the gun's empty): the gun in about `budget` triangles and a few materials."""
    w = root.name
    bpy.context.view_layer.update()
    parts = list(_parts(root))
    body = [o for o in parts if not o.name.endswith("_kit")]
    kit = [o for o in parts if o.name.endswith("_kit")]
    names = {s.material.name for o in body for s in o.material_slots if s.material}
    bm, mats = _gather(root, body, lambda n: FOLD[n] if FOLD.get(n) in names else n)
    before = sum(len(f.verts) - 2 for f in bm.faces)

    # 2. What is too small to see, and what nothing from outside reaches.
    islands = _islands(bm)
    tree = BVHTree.FromBMesh(bm)
    dirs = _directions()
    drop, small_n, hidden_n = [], 0, 0
    for isl in islands:
        lo = Vector((min(v.co.x for f in isl for v in f.verts), min(v.co.y for f in isl for v in f.verts), min(v.co.z for f in isl for v in f.verts)))
        hi = Vector((max(v.co.x for f in isl for v in f.verts), max(v.co.y for f in isl for v in f.verts), max(v.co.z for f in isl for v in f.verts)))
        if (hi - lo).length < small or sorted(hi - lo)[1] < thin:  # small, or thin both ways (a pin, a rail's tooth)
            drop += isl
            small_n += 1
        elif not _seen(isl, tree, dirs):
            drop += isl
            hidden_n += 1
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    kept = sum(len(f.verts) - 2 for f in bm.faces)
    # 3. The flat faces a cut split into many made one again (the shape stays the same): less for the collapse to do.
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), use_dissolve_boundaries=False, verts=bm.verts, edges=bm.edges,
                             delimit={"MATERIAL"})

    # 4. The materials folded to a few: one per role, unless they look different; the scarce into the nearest.
    area = [0.0] * len(mats)
    for f in bm.faces:
        area[f.material_index] += f.calc_area()
    total = sum(area) or 1
    keep = {}  # material index -> the index it goes into
    order = sorted(range(len(mats)), key=lambda i: -area[i])
    heads = []
    for i in order:
        if area[i] == 0:
            continue
        m = mats[i]
        role = ROLE.get(m.name) if m else None
        head = next((h for h in heads if role and ROLE.get(mats[h].name) == role and not _glows(m) and not _glows(mats[h])
                     and not _vivid(m) and (_apart(m, mats[h]) < ALIKE or (area[i] / total < BIG and _apart(m, mats[h]) < NEAR and _grey(m) and _grey(mats[h])))), None)
        if head is None:
            heads.append(i)
            keep[i] = i
        else:
            keep[i] = head
            area[head] += area[i]
    for h in sorted(heads, key=lambda i: area[i]):
        if len([g for g in heads if keep[g] == g]) <= 1 or area[h] / total >= SCARCE or _glows(mats[h]) or (_vivid(mats[h]) and area[h] / total >= 0.02):
            continue
        rest = [g for g in heads if g != h and keep[g] == g]
        role = ROLE.get(mats[h].name)
        to = min(rest, key=lambda g: _apart(mats[g], mats[h]) + (0 if role and ROLE.get(mats[g].name) == role else 0.1))
        for i, k in keep.items():
            if k == h:
                keep[i] = to
        area[to] += area[h]
    used = sorted({keep[i] for i in keep})
    slot = {i: used.index(keep[i]) for i in keep}
    for f in bm.faces:
        f.material_index = slot[f.material_index]
    mats = [mats[i] for i in used]

    holder = bpy.data.objects.new(w + "_far", None)
    bpy.context.scene.collection.objects.link(holder)
    holder.empty_display_size = 0.01
    # 5. Each part collapsed to its share.
    o = _object(w + "_far_body", _reduce_parts(bm, budget), mats, holder)
    tris = _reduce(o, 1)
    print(f"{w}_far: {before} triangles, {small_n} small and {hidden_n} hidden parts left out ({before - kept} triangles), "
          f"{tris} after the collapse; materials {[m.name for m in mats]}")
    if kit:
        kbm, kmats = _gather(root, kit, lambda n: n)
        k = _object(w + "_far_kit", kbm, kmats, holder)
        print(f"{w}_far_kit: {_reduce(k, 0.5)} triangles")
    return holder
