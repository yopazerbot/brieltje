"""Give a building model a second UV map (TEXCOORD_1) for baked light, in place.

The baked light of a model (tools/bake/bake_buildings.py) is stored in a few square textures,
its "pages". Every surface that gets baked light needs a spot of its own on a page, so this tool
cuts the model's surfaces into flat pieces ("charts": connected triangles facing about the same
way), lays each piece flat at a fixed size per texel, and packs them onto the pages. The result
goes into the model as a second UV map, and each mesh notes in its extras its page (`lm`), the
model (`lmModel`), the page size (`lmSize`) and the layout's id (`lmId`): tools/bake/bake_buildings.py bakes into
that layout and the game checks the id before it uses a bake, so a model that was built again
(and lost its layout) never shows another layout's light.

The rest of the model stays as it was: vertices are only split where a piece's edge needs two
UVs, and every other attribute is copied along. Glass, foliage, the small things (frames,
gutters, railings: their own LOD meshes), fittings, ground surfaces (roads, pavers, yards) and a
model's far version are left out: they keep real-time light.

  tools/.venv/Scripts/python.exe tools/bake/lightmap_uv.py            (every model in buildings.json)
  tools/.venv/Scripts/python.exe tools/bake/lightmap_uv.py molenhoek  (one of them)

tools/bake/buildings.json names the models and their texel size (metres per texel on walls and
roofs). --dry only prints the sizes.
"""
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np

DTYPE = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
PAD = 2  # texels of margin round each piece (filled by the bake's dilation; keeps mip levels apart)
CHART_COS = math.cos(math.radians(30))  # a piece grows over triangles within 30 degrees of its first one

# Meshes that keep real-time light: see-through, leaves, small details, loose fittings.
SKIP_WORDS = ("glass", "clear", "foliage", "detail", "fittings", "trim", "_in")
# Ground surfaces (roads, pavers, yards, terraces) keep real-time light too: the ground's own shading
# (world/groundShade.ts) already gives them the houses' shadows, and a rebuilt road lying in the
# village's ground came out of the bake black, where that ground covered it (Yoshi, 5 Nov 2026). The Sparrenhof's
# forecourt of gravel and setts too: the skirt down from its edge came out of the bake black, a black wedge along
# the road (8 Nov 2026).
GROUND_WORDS = ("asphalt", "pavers", "yard", "slab", "pave", "gravel", "setts")


class Glb:
    def __init__(self, path: Path):
        raw = path.read_bytes()
        magic, _, length = struct.unpack_from("<III", raw, 0)
        assert magic == 0x46546C67, "not a GLB"
        jlen, jtype = struct.unpack_from("<II", raw, 12)
        assert jtype == 0x4E4F534A
        self.json = json.loads(raw[20:20 + jlen])
        off = 20 + jlen
        self.bin = b""
        if off < length:
            blen, btype = struct.unpack_from("<II", raw, off)
            assert btype == 0x004E4942
            self.bin = raw[off + 8:off + 8 + blen]

    def accessor(self, index: int) -> np.ndarray:
        """An accessor's values as stored (no normalisation), shape (count, width)."""
        a = self.json["accessors"][index]
        assert "sparse" not in a, "sparse accessors are not supported"
        dt = np.dtype(DTYPE[a["componentType"]])
        w = WIDTH[a["type"]]
        n = a["count"]
        if "bufferView" not in a:
            return np.zeros((n, w), dt)
        v = self.json["bufferViews"][a["bufferView"]]
        start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = v.get("byteStride", 0) or dt.itemsize * w
        if stride == dt.itemsize * w:
            return np.frombuffer(self.bin, dt, n * w, start).reshape(n, w).copy()
        out = np.empty((n, w), dt)
        for i in range(n):
            out[i] = np.frombuffer(self.bin, dt, w, start + i * stride)
        return out

    def floats(self, index: int) -> np.ndarray:
        """An accessor's values as floats, normalised integers mapped as glTF says."""
        a = self.json["accessors"][index]
        x = self.accessor(index)
        if not a.get("normalized") or x.dtype == np.float32:
            return x.astype(np.float64)
        info = np.iinfo(x.dtype)
        if info.min < 0:
            return np.maximum(x.astype(np.float64) / info.max, -1.0)
        return x.astype(np.float64) / info.max

    def write(self, path: Path, arrays: dict, keep_views: set):
        """Write the GLB again: every accessor from `arrays` (index -> (array, accessor json)) in a
        buffer view of its own; buffer views in `keep_views` (images) are copied as they were."""
        j = self.json
        out = bytearray()
        views = []
        remap = {}
        for vi in sorted(keep_views):
            v = j["bufferViews"][vi]
            data = self.bin[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
            while len(out) % 4:
                out.append(0)
            remap[vi] = len(views)
            nv = {"buffer": 0, "byteOffset": len(out), "byteLength": len(data)}
            views.append(nv)
            out += data
        accessors = []
        for ai in range(len(arrays)):
            arr, meta = arrays[ai]
            meta = {k: v for k, v in meta.items() if k not in ("bufferView", "byteOffset")}
            data = np.ascontiguousarray(arr).tobytes()
            while len(out) % 4:
                out.append(0)
            nv = {"buffer": 0, "byteOffset": len(out), "byteLength": len(data)}
            if meta.get("_target"):
                nv["target"] = meta.pop("_target")
            meta.pop("_target", None)
            meta["bufferView"] = len(views)
            meta["count"] = int(arr.shape[0])
            views.append(nv)
            accessors.append(meta)
            out += data
        while len(out) % 4:
            out.append(0)
        for img in j.get("images", []):
            if "bufferView" in img:
                img["bufferView"] = remap[img["bufferView"]]
        j["bufferViews"] = views
        j["accessors"] = accessors
        j["buffers"] = [{"byteLength": len(out)}]
        text = json.dumps(j, separators=(",", ":")).encode()
        text += b" " * ((4 - len(text) % 4) % 4)
        total = 12 + 8 + len(text) + 8 + len(out)
        blob = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(text), 0x4E4F534A) + text
        blob += struct.pack("<II", len(out), 0x004E4942) + bytes(out)
        path.write_bytes(blob)


def node_matrices(j) -> dict:
    """Each node's matrix in the model (the scene root's frame), by node index."""
    def local(n):
        if "matrix" in n:
            return np.array(n["matrix"], float).reshape(4, 4).T
        t = np.array(n.get("translation", [0, 0, 0]), float)
        x, y, z, w = n.get("rotation", [0, 0, 0, 1])
        s = np.array(n.get("scale", [1, 1, 1]), float)
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ])
        m = np.eye(4)
        m[:3, :3] = r * s
        m[:3, 3] = t
        return m

    out = {}

    def walk(i, parent):
        m = parent @ local(j["nodes"][i])
        out[i] = m
        for c in j["nodes"][i].get("children", []):
            walk(c, m)

    for s in j.get("scenes", [{"nodes": list(range(len(j["nodes"])))}]):
        for i in s["nodes"]:
            walk(i, np.eye(4))
    return out


def charts_of(p: np.ndarray, tris: np.ndarray):
    """Split triangles (indices into p, world positions) into flat connected pieces. Returns a chart
    id per triangle and each triangle's normal."""
    a, b, c = p[tris[:, 0]], p[tris[:, 1]], p[tris[:, 2]]
    n = np.cross(b - a, c - a)  # area-weighted (twice the area)
    area2 = np.linalg.norm(n, axis=1)
    n = n / np.maximum(area2, 1e-12)[:, None]
    # Weld by position (1 mm) so pieces grow across the hard edges the model split its vertices at.
    key = np.round(p * 1000).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.ravel()
    wt = weld[tris]
    edges = np.concatenate([wt[:, [0, 1]], wt[:, [1, 2]], wt[:, [2, 0]]])
    owner = np.tile(np.arange(len(tris)), 3)
    edges.sort(axis=1)
    order = np.lexsort((edges[:, 1], edges[:, 0]))
    es, eo = edges[order], owner[order]
    same = np.all(es[1:] == es[:-1], axis=1)
    neighbours = [[] for _ in range(len(tris))]
    # Runs of equal edges: every pair in a run are neighbours (two for a clean edge).
    i = 0
    m = len(es)
    starts = np.flatnonzero(np.concatenate([[True], ~same]))
    ends = np.concatenate([starts[1:], [m]])
    for s, e in zip(starts, ends):
        if e - s < 2:
            continue
        group = eo[s:e]
        for x in group:
            for y in group:
                if x != y:
                    neighbours[x].append(y)
    chart = np.full(len(tris), -1, np.int64)
    count = 0
    for seed in range(len(tris)):
        if chart[seed] >= 0:
            continue
        chart[seed] = count
        sn = n[seed]
        stack = [seed] if area2[seed] > 1e-10 else []  # a sliver stays a piece of its own
        while stack:
            t = stack.pop()
            for u in neighbours[t]:
                if chart[u] < 0 and area2[u] > 1e-10 and float(n[u] @ sn) > CHART_COS:
                    chart[u] = count
                    stack.append(u)
        count += 1
    return chart, n * area2[:, None], count


def flatten(p: np.ndarray, tris: np.ndarray, normal: np.ndarray):
    """A piece's corners on its own plane (metres), turned so its bounding box is smallest.
    `normal`: the piece's normal, weighted by area (any length; zero for a piece of slivers)."""
    length = np.linalg.norm(normal)
    normal = normal / length if length > 1e-12 else np.array([0.0, 1.0, 0.0])
    if abs(normal[1]) < 0.9:
        u = np.cross([0.0, 1.0, 0.0], normal)
    else:
        u = np.cross(normal, [0.0, 0.0, 1.0])
    u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    pts = p[tris.ravel()]
    xy = np.stack([pts @ u, pts @ v], axis=1)
    # Try the directions of the piece's own edges (walls come out level already).
    best = None
    corners = xy.reshape(-1, 3, 2)
    d = np.concatenate([corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 1]])
    ang = np.unique(np.round(np.mod(np.arctan2(d[:, 1], d[:, 0]), math.pi / 2), 3))[:24]
    for t in np.concatenate([[0.0], ang]):
        c, s = math.cos(t), math.sin(t)
        r = xy @ np.array([[c, -s], [s, c]])
        lo, hi = r.min(axis=0), r.max(axis=0)
        area = float(np.prod(hi - lo))
        if best is None or area < best[0] - 1e-9:
            best = (area, r - lo, hi - lo)
    return best[1], best[2]


class Page:
    """Shelf packing on one square page: rows of pieces, tallest first."""

    def __init__(self, size: int):
        self.size = size
        self.shelves = []  # [y, height, x used]
        self.top = 0

    def place(self, w: int, h: int):
        for sh in self.shelves:
            if h <= sh[1] and sh[2] + w <= self.size:
                x = sh[2]
                sh[2] += w
                return x, sh[0]
        if self.top + h <= self.size and w <= self.size:
            self.shelves.append([self.top, h, w])
            self.top += h
            return 0, self.top - h
        return None

    def snapshot(self):
        return [s[:] for s in self.shelves], self.top

    def restore(self, snap):
        self.shelves, self.top = [s[:] for s in snap[0]], snap[1]


def pack(jobs, size: int, single: bool):
    """Place every mesh's pieces on pages of `size` texels (all on one page if `single`); the pages,
    or None when `single` and they don't fit. Sets each piece's x, y and each mesh's page."""
    pages: list[Page] = []
    for job in jobs:
        rects = sorted((r for _, _, rs in job["pieces"] for r in rs), key=lambda r: (-r["h"], -r["w"]))
        placed = False
        candidates = pages + [Page(size)] if not (single and pages) else pages
        for pi, page in enumerate(candidates):
            snap = page.snapshot()
            spots = []
            for r in rects:
                at = page.place(r["w"], r["h"])
                if at is None:
                    break
                spots.append(at)
            if len(spots) == len(rects):
                if pi == len(pages):
                    pages.append(page)
                for r, (x, y) in zip(rects, spots):
                    r["x"], r["y"] = x, y
                job["page"] = pi
                placed = True
                break
            page.restore(snap)
        if not placed:
            if single:
                return None
            raise SystemExit(f"{job['name']}: its pieces don't fit on one page")
    return pages


def process(path: Path, texel: float, page_size: int, dry: bool) -> dict:
    g = Glb(path)
    j = g.json
    mats = j.get("materials", [])
    world = node_matrices(j)
    mesh_node = {}
    for ni, nd in enumerate(j["nodes"]):
        if "mesh" in nd:
            mesh_node.setdefault(nd["mesh"], []).append(ni)
    # Read every accessor once; new and changed ones replace them by index.
    arrays = {i: (g.accessor(i), dict(a)) for i, a in enumerate(j["accessors"])}
    for i, a in enumerate(j["accessors"]):
        if "bufferView" in a:
            arrays[i][1]["_target"] = j["bufferViews"][a["bufferView"]].get("target")
    keep_views = {img["bufferView"] for img in j.get("images", []) if "bufferView" in img}

    jobs = []  # per mesh: list of (primitive, tris, chart rects)
    for mi, mesh in enumerate(j["meshes"]):
        for key in ("lm", "lmModel", "lmId", "lmSize"):  # a mesh left out this time keeps no old notes
            mesh.setdefault("extras", {}).pop(key, None)
        for prim in mesh["primitives"]:
            prim["attributes"].pop("TEXCOORD_1", None)
        nodes = mesh_node.get(mi, [])
        name = (mesh.get("name") or "").lower()
        mat = mats[mesh["primitives"][0]["material"]] if "material" in mesh["primitives"][0] else {}
        mname = (mat.get("name") or "").lower()
        extras = mat.get("extras") or {}
        # A model's far version (the town's, beyond 230 m) too: there the light needs no detail.
        far = name.startswith("far_")
        ground = any(w in name or w in mname for w in GROUND_WORDS)
        if len(nodes) != 1 or far or ground or any(w in name or w in mname for w in SKIP_WORDS) or extras.get("lod") or mat.get("alphaMode") == "BLEND":
            continue
        size = texel
        m = world[nodes[0]]
        pieces = []
        for prim in mesh["primitives"]:
            if prim.get("mode", 4) != 4:
                continue
            pos = g.floats(prim["attributes"]["POSITION"])
            p = pos @ m[:3, :3].T + m[:3, 3]
            tris = g.accessor(prim["indices"]).reshape(-1, 3).astype(np.int64) if "indices" in prim else np.arange(len(p)).reshape(-1, 3)
            chart, normals, count = charts_of(p, tris)
            order = np.argsort(chart, kind="stable")
            bounds = np.searchsorted(chart[order], np.arange(count + 1))
            rects = []
            todo = [order[bounds[c]:bounds[c + 1]] for c in range(count)]
            while todo:
                tri_ids = todo.pop()
                xy, ext = flatten(p, tris[tri_ids], normals[tri_ids].sum(axis=0))
                # A piece that fills little of its box (a kerb or a pavement round a bend): cut in two
                # across its length until the parts are about straight.
                if len(tri_ids) > 1 and max(ext) > 4 * size:
                    c3 = xy.reshape(-1, 3, 2)
                    e1, e2 = c3[:, 1] - c3[:, 0], c3[:, 2] - c3[:, 0]
                    flat_area = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum()
                    if flat_area < 0.45 * ext[0] * ext[1]:
                        axis = 0 if ext[0] >= ext[1] else 1
                        mid = c3[:, :, axis].mean(axis=1)
                        cut = mid <= np.median(mid)
                        if 0 < cut.sum() < len(cut):
                            todo += [tri_ids[cut], tri_ids[~cut]]
                            continue
                # At least one texel each way, so every piece covers a texel centre.
                w = max(1, math.ceil(ext[0] / size))
                h = max(1, math.ceil(ext[1] / size))
                sx = w * size / max(ext[0], 1e-9) if ext[0] > 1e-9 else 0.0
                sy = h * size / max(ext[1], 1e-9) if ext[1] > 1e-9 else 0.0
                uv = np.stack([xy[:, 0] * sx / size, xy[:, 1] * sy / size], axis=1)  # texels within the piece
                if ext[0] <= 1e-9:
                    uv[:, 0] = 0.5
                if ext[1] <= 1e-9:
                    uv[:, 1] = 0.5
                rects.append({"tris": tri_ids, "uv": uv, "w": w + 2 * PAD, "h": h + 2 * PAD})
            pieces.append((prim, tris, rects))
        area = sum(r["w"] * r["h"] for _, _, rs in pieces for r in rs)
        jobs.append({"mesh": mi, "name": mesh.get("name"), "pieces": pieces, "area": area, "texel": size})

    # Pack: biggest meshes first; a mesh's pieces all go on one page. A small model gets one smaller page.
    jobs.sort(key=lambda x: -x["area"])
    total = sum(job["area"] for job in jobs)
    pages = None
    for size in (256, 512, 1024):
        if size < page_size and total < size * size * 0.85:
            pages = pack(jobs, size, single=True)
            if pages is not None:
                page_size = size
                break
    if pages is None:
        for job in jobs:
            if job["area"] > page_size * page_size * 0.92:
                raise SystemExit(f"{path.name}: {job['name']} needs {job['area'] / page_size ** 2:.2f} pages at {job['texel']} m a texel; use a coarser texel")
        pages = pack(jobs, page_size, single=False)
    used = [sum(r["w"] * r["h"] for job in jobs if job["page"] == pi for _, _, rs in job["pieces"] for r in rs) for pi in range(len(pages))]
    report = {"model": path.name, "size": page_size, "pages": len(pages), "fill": [round(u / page_size ** 2, 2) for u in used],
              "meshes": {job["name"]: {"page": job["page"], "texel": job["texel"], "pieces": sum(len(rs) for _, _, rs in job["pieces"])} for job in jobs}}
    if dry:
        return report

    # Write the layout: split vertices where a piece's edge needs two UVs.
    digest = hashlib.sha256()
    next_index = len(arrays)
    for job in jobs:
        j["meshes"][job["mesh"]].setdefault("extras", {})["lm"] = job["page"]
        for prim, tris, rects in job["pieces"]:
            n_corner = tris.size
            corner_uv = np.zeros((n_corner, 2))
            corner_chart = np.zeros(n_corner, np.int64)
            for ci, r in enumerate(rects):
                ids = r["tris"]
                uv = r["uv"].reshape(-1, 3, 2) + np.array([r["x"] + PAD, r["y"] + PAD])
                corner_uv.reshape(-1, 3, 2)[ids] = uv / page_size
                corner_chart.reshape(-1, 3)[ids] = ci
            src = tris.ravel()
            key = src * (len(rects) + 1) + corner_chart
            uniq, first, inverse = np.unique(key, return_index=True, return_inverse=True)
            new_src = src[first]
            new_uv = corner_uv[first]
            for attr, ai in list(prim["attributes"].items()):
                arr, meta = arrays[ai]
                meta = {k: v for k, v in meta.items() if k not in ("min", "max")}
                values = arr[new_src]
                if attr == "POSITION":
                    meta["min"] = values.min(axis=0).tolist()
                    meta["max"] = values.max(axis=0).tolist()
                arrays[next_index] = (values, meta)
                prim["attributes"][attr] = next_index
                next_index += 1
            uv32 = new_uv.astype(np.float32)
            arrays[next_index] = (uv32, {"componentType": 5126, "type": "VEC2", "count": len(uv32), "_target": 34962})
            prim["attributes"]["TEXCOORD_1"] = next_index
            next_index += 1
            if "TEXCOORD_0" not in prim["attributes"]:
                # Importers (Blender's) read UV maps in order and stop at a gap: a stand-in first one.
                arrays[next_index] = (uv32.copy(), {"componentType": 5126, "type": "VEC2", "count": len(uv32), "_target": 34962})
                prim["attributes"]["TEXCOORD_0"] = next_index
                next_index += 1
            idx = inverse.ravel().astype(np.uint32 if len(uniq) > 65535 else np.uint16)
            arrays[next_index] = (idx.reshape(-1, 1), {"componentType": 5125 if idx.dtype == np.uint32 else 5123, "type": "SCALAR", "count": len(idx), "_target": 34963})
            prim["indices"] = next_index
            next_index += 1
            digest.update(uv32.tobytes())
            digest.update(idx.tobytes())
    # Drop accessors nothing points at any more, renumbering the rest.
    used_ids = set()
    for mesh in j["meshes"]:
        for prim in mesh["primitives"]:
            used_ids.update(prim["attributes"].values())
            if "indices" in prim:
                used_ids.add(prim["indices"])
            for t in prim.get("targets", []):
                used_ids.update(t.values())
    for sk in j.get("skins", []):
        if "inverseBindMatrices" in sk:
            used_ids.add(sk["inverseBindMatrices"])
    for an in j.get("animations", []):
        for s in an["samplers"]:
            used_ids.update((s["input"], s["output"]))
    keep = sorted(used_ids)
    new_id = {old: k for k, old in enumerate(keep)}
    for mesh in j["meshes"]:
        for prim in mesh["primitives"]:
            prim["attributes"] = {k: new_id[v] for k, v in prim["attributes"].items()}
            if "indices" in prim:
                prim["indices"] = new_id[prim["indices"]]
            prim["targets"] = [{k: new_id[v] for k, v in t.items()} for t in prim.get("targets", [])] or None
            if prim["targets"] is None:
                del prim["targets"]
    for sk in j.get("skins", []):
        if "inverseBindMatrices" in sk:
            sk["inverseBindMatrices"] = new_id[sk["inverseBindMatrices"]]
    for an in j.get("animations", []):
        for s in an["samplers"]:
            s["input"], s["output"] = new_id[s["input"]], new_id[s["output"]]
    lm_id = digest.hexdigest()[:16]
    for job in jobs:
        j["meshes"][job["mesh"]]["extras"].update({"lmModel": path.stem, "lmId": lm_id, "lmSize": page_size})
    g.write(path, {new_id[o]: arrays[o] for o in keep}, keep_views)
    report["id"] = lm_id
    return report


def main():
    args = sys.argv[1:]
    dry = "--dry" in args
    names = [a for a in args if not a.startswith("--")]
    here = Path(__file__).resolve().parent
    config = json.loads((here / "buildings.json").read_text(encoding="utf-8"))
    models = here.parents[1] / "web" / "public" / "models"
    for name, spec in config["models"].items():
        if names and name not in names:
            continue
        r = process(models / f"{name}.glb", spec["texel"], config["page"], dry)
        print(json.dumps({k: v for k, v in r.items() if k != "meshes"}))
        for mesh, m in r["meshes"].items():
            print(f"   {mesh}: page {m['page']}, {m['pieces']} pieces at {m['texel']} m")


if __name__ == "__main__":
    main()
