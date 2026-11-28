"""Farm buildings out in the countryside as models of our own: cow stables, machine sheds and storage halls that the
open data draws as plain boxes with flat lids.

  blender -b -P tools/farm_buildings.py -- web/public/models [fb_stables_1255 fb_shed_31 ...]

writes web/public/models/<name>.glb for each farm, or for the ones named, with the toolkit of the hand-made village
houses (tools/village_houses_kit.py; see tools/village_houses_b1.py for the names of the meshes and what the game does
with each). Each model stands in for the generated wall blocks of one farm, found in web/src/data/village.json by a
corner; their outlines are the root's `replaces` (the blocks stay in the data for walking into and for the server, so
every wall keeps within 0.15 m of them). Each is named by its spot in the model's metres, never by an address.

How they are dressed, after the way open-world games build farm buildings from a small set of parts (a plinth, sheet
walls, roof panels, trims at the corners and verges, door modules) and break up long runs of sheet with doors, light
strips and columns rather than dirt:
- a cow stable: a concrete plinth, windbreak netting between the columns of its long sides, sheet gables with sliding
  doors, a fibre-cement roof with an open ridge vent and rows of light strips;
- a machine shed or a storage hall: steel sheet walls over a low plinth, wide sectional or sliding doors, a strip of
  light panels under the eaves, a low-pitched sheet roof where the data has a flat lid (at about its height);
- an older brick stable: red brick, a row of small windows, a corrugated fibre-cement roof.

The data's roofs (eaves and ridge) are followed where it has them. The ribbed sheet of walls and roofs is the game's
own vertical slats (`cladding`) drawn four times as wide and tinted, as on vh_gable_house: no new texture, no image in
a file. Nothing here is personal: no sign, text, logo or number.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (Snapped, Opening, Roof, eave, draw_roofs, top_over, the materials, ONLY)


class Farm(Snapped):  # noqa: F405
    """Snapped, standing in for several wall blocks (a farm's buildings): each further one is hidden and snapped to."""

    def also_replaces(self, corner):
        ring = max((p["p"][0] for p in VILLAGE["prisms"] if any(abs(q[0] - corner[0]) < .02 and abs(q[1] - corner[1]) < .02 for q in p["p"][0])), key=len)  # noqa: F405
        self.replaces.append(ring)
        self.extra = getattr(self, "extra", []) + [self.local(p) for p in ring]
        return ring

    def snap(self, p):
        q = min(list(self.ring) + getattr(self, "extra", []), key=lambda r: (r[0] - p[0]) ** 2 + (r[1] - p[1]) ** 2)
        return tuple(q) if (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < .01 else tuple(p)

    def Y(self, y):
        """A height of the data (over the sea's level, as the terrain) as ours: over the ground at the origin."""
        return y - self.ground0


# The slats' mean colour (linear): a tint turns it to the colour asked for, as far as a tint can (it never lightens).
SLATS = (.3044, .1685, .0902)


def toward(color, mean=SLATS):
    """The tint that turns a texture of this mean colour to `color` on average (each channel at most 1)."""
    out = []
    for c, m in zip(linear(color), mean):  # noqa: F405
        k = min(1.0, c / m)
        out.append(round(255 * (12.92 * k if k <= .0031308 else 1.055 * k ** (1 / 2.4) - .055)))
    return "#" + "".join(f"{v:02x}" for v in out)


def sheet(color, stretch=(4, 1), normal=.8):
    """Ribbed sheet: the game's slats four times as wide, a rib every 18 cm, tinted to `color` from the wood's brown
    (dark and middle colours only)."""
    return {"texture": "cladding", "tint": toward(color), "stretch": stretch, "normalScale": normal}


# Precast concrete: the plaster, light and nearly plain, tinted to a concrete grey.
CONCRETE = {"texture": "plaster", "tint": toward("#a4a49e", (.8961, .8947, .8961)), "normalScale": .5}
LIGHT = {"tint": "#ffffff", "rough": .35}  # the light strips: flat colours per face


# ======================================================================================================================
# Parts.
class Hall:
    """A roof over a rectangle given by three world corners c0, c1, c3 (c0-c1 along the ridge, c0-c3 across):
    `gable` (two slopes, eaves at both long sides) or `shed` (one slope, low at c0-c1). Heights are ours; `ends` and
    `sides` say which overhangs it has."""

    def __init__(self, h, c0, c1, c3, eaves, top, kind="gable", side=.35, end=.3, ends=(True, True), sides=(True, True),
                 under="#bdbcb6", edge="#6f706c", board=.22):
        a, b, d = Vector(h.local(c0)), Vector(h.local(c1)), Vector(h.local(c3))  # noqa: F405
        self.t = (b - a).normalized()
        self.n = (d - a).normalized()
        self.L, self.W = (b - a).length, (d - a).length
        self.a, self.kind, self.eaves, self.top, self.side = a, kind, eaves, top, side
        # an overhang: True for the usual, False for none, a number for that many metres (a roof run on into the
        # slope of a taller one beside it, where draw_roofs cuts it along the valley)
        o = lambda v, usual: usual if v is True else 0 if v is False else v
        e0, e1 = o(ends[0], end), o(ends[1], end)
        s0, s1 = o(sides[0], side), o(sides[1], side)
        self.e0, self.e1, self.s0, self.s1 = e0, e1, s0, s1
        P = lambda x, c: tuple(a + self.t * x + self.n * c)
        foot = [P(-e0, -s0), P(self.L + e1, -s0), P(self.L + e1, self.W + s1), P(-e0, self.W + s1)]
        if kind == "gable":
            self.k = (top - eaves) / (self.W / 2)
            planes = [eave(P(0, 0), tuple(self.n), eaves, self.k), eave(P(0, self.W), tuple(-self.n), eaves, self.k)]  # noqa: F405
        else:
            self.k = (top - eaves) / self.W
            planes = [eave(P(0, 0), tuple(self.n), eaves, self.k)]  # noqa: F405
        self.P = P
        self.roof = Roof(foot, planes, under=under, edge=edge, thick=.12, board=board, ridge_r=.09, ridge_mesh="vh_trim")  # noqa: F405

    def at(self, x, c):
        return self.roof.height(*self.P(x, c))


def lights(h, hall, every=6.0, width=1.0, skip=()):
    """Rows of light strips (translucent sheets) in the roof, up each slope, every `every` metres along it."""
    n = max(1, int((hall.L - 2) / every))
    step = hall.L / n
    spans = [(.9, hall.W / 2 - .7)] if hall.kind == "gable" else [(.9, hall.W - .9)]
    if hall.kind == "gable":
        spans.append((hall.W / 2 + .7, hall.W - .9))
    for i in range(n):
        if i in skip:
            continue
        x = step * (i + .5)
        for c0, c1 in spans:
            pts = [(x - width / 2, c0), (x + width / 2, c0), (x + width / 2, c1), (x - width / 2, c1)]
            h.poly("vh_light", [(*hall.P(px, pc), hall.at(px, pc) + .025) for px, pc in pts], (0, 0, 1), "#aeb3ad")


def vent(h, hall, color="#2a2b2a"):
    """An open ridge: a dark slot along the ridge under a raised cap of sheet."""
    c = hall.W / 2
    x0, x1 = -hall.e0 + .1, hall.L + hall.e1 - .1
    y = hall.top
    a, b = hall.P(x0, c), hall.P(x1, c)
    h.seg("vh_trim", a, b, .5, y - .15, y + .2, color)
    for sgn in (-1, 1):  # the cap's two slopes
        p0, p1 = hall.P(x0, c), hall.P(x1, c)
        q0, q1 = hall.P(x0, c + sgn * .5), hall.P(x1, c + sgn * .5)
        h.poly("vh_roof", [(*p0, y + .34), (*p1, y + .34), (*q1, y + .2), (*q0, y + .2)], (0, 0, 1))
        h.poly("vh_trim", [(*p0, y + .3), (*p1, y + .3), (*q1, y + .16), (*q0, y + .16)], (0, 0, -1), "#3a3b3a")
        h.poly("vh_trim", [(*q0, y + .2), (*q1, y + .2), (*q1, y + .16), (*q0, y + .16)], (*(hall.n * sgn), 0), hall.roof.edge)


def gutters(h, hall, color="#8a8c8a", which=(0, 1), pipes=((2.0,), (2.0,))):
    """Gutters under the eaves of the slopes named (0: the c0-c1 side, 1: the far side of a gable), and downpipes at
    those distances along the ridge (negative: from the far end)."""
    for i in which:
        c_edge = -hall.s0 if i == 0 else hall.W + hall.s1
        c_wall = -.08 if i == 0 else hall.W + .08
        out = tuple(-hall.n if i == 0 else hall.n) + (0,)
        y = hall.at(0, c_edge) - hall.roof.board
        a, b = hall.P(-hall.e0 + .05, c_edge), hall.P(hall.L + hall.e1 - .05, c_edge)
        down = []
        for x in pipes[i] if i < len(pipes) else ():
            x = x if x >= 0 else hall.L + x
            p = hall.P(x, c_wall)
            down.append((p[0], p[1], h.ground(*p)))
        h.gutter((*a, y), (*b, y), out, color, down=down)


def away(poly, p):
    """How far a point lies from a polygon's edges (0 on them)."""
    best = 1e9
    for a, b in zip(poly, poly[1:] + poly[:1]):
        dx, dz = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz or 1)))
        best = min(best, math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]))  # noqa: F405
    return best


def tops(roofs, a, b, drop=.06):
    """top_over, and where no roof's footprint covers the wall (an outline a little past the data's roof), the roof
    nearest to it, its planes carried on."""
    A, B = Vector(a), Vector(b)  # noqa: F405
    L = (B - A).length
    n = max(2, int(L / .05))
    pts = []
    for i in range(n + 1):
        p = A + (B - A) * (i / n)
        ys = [R.height(p.x, p.y) for R in roofs if R.covers(p.x, p.y, .02)]
        if not ys:
            R = min(roofs, key=lambda R: away(R.F, (p.x, p.y)))
            ys = [R.height(p.x, p.y)]
        pts.append((L * i / n, max(ys) - drop))
    keep = [pts[0]]
    for i in range(1, len(pts) - 1):
        (s0, y0), (s1, y1), (s2, y2) = keep[-1], pts[i], pts[i + 1]
        if abs(y0 + (y2 - y0) * (s1 - s0) / (s2 - s0) - y1) > 1e-4:
            keep.append(pts[i])
    keep.append(pts[-1])
    return keep


def ring_walls(h, ring, halls, dress=lambda i, L, g: ([], []), mesh="vh_sheet", plinth=1.0, plinth_mesh="vh_plinth",
               corners="#6f706c", skip=()):
    """The outer walls along a ring of world corners, each under the highest roof over it, with a plinth band and
    corner trims. `dress(i, L, ground)` gives edge i's openings and calls that draw on it (each takes W, N, T)."""
    loc = [h.local(p) for p in ring]
    roofs = [x.roof for x in halls]
    out = []
    mesh_of = mesh if callable(mesh) else (lambda i: mesh)
    plinth_of = plinth if callable(plinth) else (lambda i: plinth)
    for i, a in enumerate(loc):
        mesh, plinth = mesh_of(i), plinth_of(i)
        b = loc[(i + 1) % len(loc)]
        A, B = Vector(a), Vector(b)  # noqa: F405
        L = (B - A).length
        if i in skip or L < .05:
            out.append(None)
            continue
        t = (B - A) / L
        n = Vector((t.y, -t.x))  # noqa: F405
        if inside(loc, tuple((A + B) / 2 + n * .05)):  # noqa: F405
            n = -n
        ground = min(h.ground(*(A + (B - A) * f)) for f in (0, .25, .5, .75, 1))
        ops, calls = dress(i, L, ground)
        W, N, T = h.wall(a, b, tops(roofs, a, b), ops, mesh=mesh, bottom=ground - .35,  # noqa: F405
                         bands=[(ground + plinth, plinth_mesh, None)] if plinth else (), out=tuple(n))
        for f in calls:
            f(W, N, T)
        if corners and mesh == "vh_sheet":  # a folded trim down each corner of sheet, over the plinth
            top = tops(roofs, a, b)
            for s0, s1, y1 in ((0, .14, top[0][1]), (L - .14, L, top[-1][1])):
                h.wbox(W, N, T, "vh_trim", s0, s1, ground + plinth, y1, -.025, 0, corners)
        out.append((W, N, T, L, ground))
    return out


def junction(h, a, b, high, low, mesh="vh_sheet"):
    """Where a higher hall meets a lower one on the line a-b (world): its wall from under the lower roof up to its own,
    facing the lower hall."""
    A, B = h.local(a), h.local(b)
    top = tops([high.roof], A, B, drop=.02)
    bottom = [(s, y - .3) for s, y in tops([low.roof], A, B, drop=0)]
    mid = (Vector(A) + Vector(B)) / 2  # noqa: F405
    toward = Vector(low.P(low.L / 2, low.W / 2)) - mid  # noqa: F405
    h.wall(A, B, top, mesh=mesh, bottom=bottom, out=tuple(toward))


def slide(h, W, N, T, s, w, hh, ground, color, rail="#5d5f5e", open_to=1):
    """A sliding door of ribbed sheet hung proud of the wall, its rail running on to the side it opens to."""
    s0, s1 = s - w / 2, s + w / 2
    h.wbox(W, N, T, "vh_door", s0, s1, ground + .02, ground + hh, -.09, -.02)
    for x in (s0, s1):
        h.wbox(W, N, T, "vh_trim", x - .04, x + .04, ground + .02, ground + hh, -.1, -.08, color)
    h.wbox(W, N, T, "vh_trim", s0, s1, ground + hh - .08, ground + hh, -.1, -.08, color)
    r0, r1 = (s0 - .1, s1 + w * .95) if open_to > 0 else (s0 - w * .95, s1 + .1)
    h.wbox(W, N, T, "vh_metal_small", r0, r1, ground + hh + .02, ground + hh + .14, -.12, 0, rail)


def band(h, W, N, T, s0, s1, y0, y1, gap=0.0, every=None):
    """A strip of light panels on a wall, a little proud of it (between s0 and s1), split every `every` metres."""
    if every is None:
        h.poly("vh_light", [W(s0, y0, -.015), W(s1, y0, -.015), W(s1, y1, -.015), W(s0, y1, -.015)], N, "#b7bcb5")
        return
    s = s0
    while s < s1 - .2:
        e = min(s + every - gap, s1)
        h.poly("vh_light", [W(s, y0, -.015), W(e, y0, -.015), W(e, y1, -.015), W(s, y1, -.015)], N, "#b7bcb5")
        s += every


def bays(L, width, margin=.6):
    """Bays of about `width` along a wall of length L: (s0, s1) each, with columns between (0.3 m) and margins."""
    n = max(1, round((L - 2 * margin) / width))
    w = (L - 2 * margin) / n
    return [(margin + w * k + .15, margin + w * (k + 1) - .15) for k in range(n)]


def netting(h, W, N, T, s0, s1, y0, y1, color="#56645a"):
    """Windbreak netting in a curtain opening: a dark green screen set back in the reveal, a tube along its foot."""
    h.wbox(W, N, T, "vh_net", s0, s1, y0, y1, .12, .14, color)
    h.wbox(W, N, T, "vh_metal_small", s0, s1, y0 + .02, y0 + .1, .06, .12, "#7d807e")


def curtain_wall(h, L, ground, y0, y1, width=4.8, color="#56645a"):
    """The openings and the netting of a stable's long side: curtain bays between columns."""
    ops, calls = [], []
    for s0, s1 in bays(L, width):
        ops.append(Opening((s0 + s1) / 2, y0, s1 - s0, y1 - y0, "curtain", reveal=.16, sill=False))  # noqa: F405
        calls.append(lambda W, N, T, s0=s0, s1=s1: netting(h, W, N, T, s0, s1, y0, y1, color))
    return ops, calls


# ======================================================================================================================
# 01. x 1254.8, z -569.5: a big cow stable of three halls side by side, east of Molenhoek.
def stables_1255():
    h = Farm("fb_stables_1255", [1249.52, -584.21], ([1277.74, -525.19], [1275.76, -584.8]), 0, {
        "vh_sheet": sheet("#3c5446"),  # dark green steel sheet on the gables
        "vh_door": sheet("#4a4e4c"),
        "vh_plinth": CONCRETE,
        "vh_roof": sheet("#545556", (3, 1), .7),  # grey fibre-cement
        "vh_net": {"tint": "#ffffff", "rough": .95},
        "vh_light": LIGHT, "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,
    })
    Y = h.Y
    ring = h.outline
    # The east hall, 20.5 m wide and 84 long, its ridge north-south; the two west halls 20 by 30 against it.
    east = Hall(h, (1254.47, -607.97), (1257.26, -524.39), (1274.96, -608.66), Y(18.49), Y(21.53))
    nw = Hall(h, (1236.4, -553.1), (1237.39, -523.61), (1256.28, -553.76), Y(18.18), Y(21.15), ends=(False, True), sides=(True, False))
    sw = Hall(h, (1235.41, -582.88), (1236.4, -553.1), (1255.29, -583.54), Y(19.62), Y(22.61), ends=(True, False), sides=(True, False))
    # The low annex south-west of the east hall: a lean-to against it.
    annex = Hall(h, (1248.52, -607.83), (1249.52, -584.21), (1255.09, -607.99), Y(17.6), Y(18.2), kind="shed", side=.3,
                 ends=(True, False), sides=(True, False))
    halls = [east, nw, sw, annex]
    plinth = 1.4

    def dress(i, L, g):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        long_side = abs(a[0] - b[0]) < 4 and L > 20  # the halls' long sides run north-south
        if long_side:
            return curtain_wall(h, L, g, g + plinth, Y(18.49) - .55 if a[0] > 1260 else Y(18.18) - .45)
        if L > 12:  # a gable: a sliding door in its middle, the light panels high up
            mid = L / 2
            return ([], [lambda W, N, T, L=L: slide(h, W, N, T, mid, 4.0, 4.2, g, "#e4e4df", open_to=1),
                         lambda W, N, T, L=L: band(h, W, N, T, 1.0, mid - 2.6, g + 3.4, g + 4.0, .1, 2.0),
                         lambda W, N, T, L=L: band(h, W, N, T, mid + 2.6, L - 1.0, g + 3.4, g + 4.0, .1, 2.0)])
        if L > 5:  # the annex's end: a plain door
            return [Opening(L / 2, g + .05, 1.0, 2.1, "door", door="#5f7a72", frame="#e4e4df", reveal=.12, sill=False)], []
        return [], []

    ring_walls(h, ring, halls, dress, plinth=plinth)
    # Where the halls meet over the outline: the south-west hall stands higher than the north-west one and than the
    # east hall's eaves; the east hall's side shows over the north-west one.
    junction(h, (1236.4, -553.1), (1256.28, -553.76), sw, nw)
    junction(h, (1256.28, -553.76), (1255.29, -583.54), sw, east)
    junction(h, (1257.27, -524.28), (1256.28, -553.76), east, nw)
    draw_roofs(h, [x.roof for x in halls])  # noqa: F405
    for x in (east, nw, sw):
        vent(h, x)
        lights(h, x, 6.0)
    # South of the walls the east hall's roof runs on over an open bay on steel columns.
    open_to = 23.4  # m along the east hall from its south end: the bay
    spots = [(x, east.W - .15) for x in (.15, 6.0, 12.0, 18.0)] + [(.15, c) for c in (5.0, 10.2, 15.4)]
    for x, c in spots:
        u, d = east.P(x, c)
        g = h.ground(u, d)
        h.box("vh_trim", u - .13, u + .13, d - .13, d + .13, g - .2, east.at(x, c) - .12, "#5c5e5d")
        h.block("steel", [(u - .13, d - .13), (u + .13, d - .13), (u + .13, d + .13), (u - .13, d + .13)], g - .2, east.at(x, c) - .12)
    gutters(h, east, which=(1,), pipes=((), (open_to + 3.0, -3.0)))
    gutters(h, nw, which=(0,), pipes=((3.0,),))
    gutters(h, sw, which=(0,), pipes=((-3.0,),))
    h.export()


def materials(walls, roof, door, extra=None):
    m = {"vh_sheet": sheet(walls), "vh_door": sheet(door), "vh_plinth": CONCRETE, "vh_roof": sheet(roof, (3, 1), .7),
         "vh_net": {"tint": "#ffffff", "rough": .95}, "vh_light": LIGHT, "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS,
         "vh_frames_small": SMALL, "vh_metal_small": METAL}
    m.update(extra or {})
    return m


def sectional(s, g, w=4.5, hh=4.5, color="#c4c6c3"):
    """A sectional door (a garage door's panels, as big as a tractor needs)."""
    return Opening(s, g + .03, w, hh, "garage", door=color, reveal=.16, sill=False)  # noqa: F405


def man_door(s, g, color="#4a4e4c", frame="#d9d9d4"):
    return Opening(s, g + .05, 1.0, 2.1, "door", door=color, frame=frame, reveal=.12, sill=False)  # noqa: F405


def columns(h, hall, spots, color="#5c5e5d"):
    """Steel columns under a roof (at hall coordinates along, across) that stop a player."""
    for x, c in spots:
        u, d = hall.P(x, c)
        g = h.ground(u, d)
        y1 = hall.at(x, c) - .12
        h.box("vh_trim", u - .12, u + .12, d - .12, d + .12, g - .2, y1, color)
        h.block("steel", [(u - .12, d - .12), (u + .12, d - .12), (u + .12, d + .12), (u - .12, d + .12)], g - .2, y1)


# ======================================================================================================================
# 02. x 30.5, z -956.4: a long machine shed by the road; where its walls step in at the north-west the roof runs on
# over an open bay on columns.
def shed_31():
    h = Farm("fb_shed_31", [26.61, -991.78], ([26.61, -991.78], [18.43, -948.96]), 0, materials("#474d47", "#4b4d50", "#3f4441"))
    Y = h.Y
    ring = h.outline
    # One low-pitched roof over the whole 21 m by 59 m (the data's flat lid is at 6.3 m over the ground).
    hall = Hall(h, (26.61, -991.78), (15.44, -933.81), (47.26, -988.15), Y(4.95), Y(6.8), side=.4, end=.35)
    W_ = 21.0

    def dress(i, L, g):
        if i == 0:  # the long west side, to the road: three sectional doors, light panels under the eaves
            return [sectional(s, g) for s in (8.0, 20.0, 32.0)], [lambda W, N, T: band(h, W, N, T, 1.0, L - 1.0, g + 4.85, g + 5.45, .1, 2.5)]
        if i == 4:  # the long east side: a door and the light panels
            return [man_door(30.0, g)], [lambda W, N, T: band(h, W, N, T, 1.0, L - 1.0, g + 4.85, g + 5.45, .1, 2.5)]
        if i == 5:  # the south end: a sliding door
            return [], [lambda W, N, T: slide(h, W, N, T, 7.0, 5.0, 4.6, g, "#d9d9d4", open_to=1)]
        if i == 3:  # the north end
            return [man_door(5.0, g)], []
        return [], []

    ring_walls(h, ring, [hall], dress, plinth=1.0)
    draw_roofs(h, [hall.roof])  # noqa: F405
    lights(h, hall, 7.5, .9)
    # The open bay: columns on the roof's free corner and along its open sides.
    x0 = (Vector(h.local((18.43, -948.96))) - hall.a).dot(hall.t)  # noqa: F405
    columns(h, hall, [(x, .15) for x in (x0 + 5.0, x0 + 10.0, hall.L - .15)] + [(hall.L - .15, 5.2)])
    gutters(h, hall, pipes=((2.0, -2.0), (2.0, -2.0)))
    h.export()


# ======================================================================================================================
# 03. x 536.5, z 102.5: a hay barn along the Walleweederede, dark red sheet, its big doors to the lane and the ends.
def barn_537():
    h = Farm("fb_barn_537", [520.88, 113.16], ([520.88, 113.16], [554.99, 106.87]), 0, materials("#4f3431", "#4d4c4e", "#33302f"))
    Y = h.Y
    hall = Hall(h, (520.88, 113.16), (554.99, 106.87), (518.05, 98.03), Y(-.25), Y(1.35))

    def dress(i, L, g):
        if i == 0:  # to the lane: a wide sliding door, light panels under the eaves either side
            return [man_door(28.0, g)], [lambda W, N, T: slide(h, W, N, T, 14.0, 6.0, 4.6, g, "#d9d9d4", open_to=-1),
                                         lambda W, N, T: band(h, W, N, T, 17.6, L - 1.0, g + 4.55, g + 5.0, .1, 2.0)]
        if i == 2:
            return [], [lambda W, N, T: band(h, W, N, T, 1.0, L - 1.0, g + 4.55, g + 5.0, .1, 2.0)]
        return [], [lambda W, N, T: slide(h, W, N, T, L / 2, 4.5, 4.4, g, "#d9d9d4", open_to=1)]

    ring_walls(h, h.outline, [hall], dress, plinth=.8)
    draw_roofs(h, [hall.roof])  # noqa: F405
    lights(h, hall, 7.0, .9)
    gutters(h, hall, pipes=((1.5, -1.5), (1.5, -1.5)))
    h.export()


# ======================================================================================================================
# 04. x 1399.1, z 326.9: a tall storage hall by the Blekte: concrete push walls to 2.6 m, grey sheet above.
def store_1399():
    h = Farm("fb_store_1399", [1410.43, 313.57], ([1410.43, 313.57], [1392.68, 310.67]), 0, materials("#565b5e", "#4b4d50", "#4a4e4c"))
    Y = h.Y
    hall = Hall(h, (1392.68, 310.67), (1387.82, 340.36), (1410.43, 313.57), Y(5.55), Y(7.2))

    def dress(i, L, g):
        if i == 0:  # the south end, to the road: a big sectional door, light panels over it
            return [sectional(L / 2, g, 5.0, 5.0)], [lambda W, N, T: band(h, W, N, T, 1.0, L - 1.0, g + 5.6, g + 6.3, .1, 2.0)]
        if i == 2:  # the north end, to the farm: a sliding door and a door
            return [man_door(L - 2.5, g)], [lambda W, N, T: slide(h, W, N, T, L / 2 - 1.5, 5.0, 5.0, g, "#d9d9d4", open_to=-1)]
        return [], [lambda W, N, T: band(h, W, N, T, 1.0, L - 1.0, g + 5.6, g + 6.3, .1, 2.0)]

    ring_walls(h, h.outline, [hall], dress, plinth=2.6)
    draw_roofs(h, [hall.roof])  # noqa: F405
    lights(h, hall, 6.0, .9)
    gutters(h, hall, pipes=((1.5, -1.5), (1.5, -1.5)))
    h.export()


# ======================================================================================================================
# 05. x 1173.7, z 470.6 and x 1166.6, z 446.3: two long buildings by the Blekte, a cow stable with netting in its sides
# and a machine shed across the yard from it.
def pair_1170():
    h = Farm("fb_pair_1170", [1191.2, 487.13], ([1191.2, 487.13], [1149.76, 468.02]), 0, materials("#3e4d44", "#525355", "#3f4441"))
    Y = h.Y
    stable = h.outline
    shed = h.also_replaces([1189.54, 448.08])
    # The stable: the data's gable over 41.5 m, a low flat-roofed end to the east under a lean-to.
    hall = Hall(h, (1149.7, 468.08), (1187.41, 485.39), (1156.14, 454.05), Y(-.01), Y(2.58), end=.35)
    low = Hall(h, (1187.41, 485.39), (1193.85, 471.35), (1191.2, 487.13), Y(-.1), Y(-.45), kind="shed", side=.3, end=0,
               ends=(False, False), sides=(False, True))
    g0 = h.ground(*h.local((1170.0, 470.0)))

    def dress_stable(i, L, g):
        if i in (1, 3):  # the long sides: netting between the columns over a concrete plinth
            return curtain_wall(h, L, g, g + 1.2, Y(-.01) - .45, 4.2)
        if i == 2:  # the west end, to the road: a sliding door
            return [], [lambda W, N, T: slide(h, W, N, T, L / 2, 3.6, 3.0, g, "#d9d9d4", open_to=1)]
        return [man_door(L / 2, g)], []

    ring_walls(h, stable, [hall, low], dress_stable, plinth=1.2)
    junction(h, (1187.41, 485.39), (1193.85, 471.35), hall, low)
    vent(h, hall)
    lights(h, hall, 6.5, .9)
    gutters(h, hall, pipes=((2.0, -2.0), (2.0, -2.0)))
    # The machine shed: a low-pitched roof at about the data's lid, sectional doors to the yard.
    mach = Hall(h, (1143.65, 444.51), (1182.68, 462.68), (1150.46, 429.89), Y(1.5), Y(2.9))

    def dress_shed(i, L, g):
        if i == 2:  # to the yard and the stable
            return [sectional(s, g, 4.2, 4.0) for s in (7.0, 17.0, 27.0)], [lambda W, N, T: band(h, W, N, T, 30.0, L - 1.0, g + 4.0, g + 4.5, .1, 2.0)]
        if i == 0:  # the south side: light panels
            return [], [lambda W, N, T: band(h, W, N, T, 1.0, L - 1.0, g + 4.0, g + 4.5, .1, 2.0)]
        if i == 1:  # the west end, to the road
            return [], [lambda W, N, T: slide(h, W, N, T, L / 2, 4.6, 4.0, g, "#d9d9d4", open_to=-1)]
        return [man_door(L / 2, g)], []

    ring_walls(h, shed, [mach], dress_shed, plinth=1.0)
    draw_roofs(h, [hall.roof, low.roof, mach.roof])  # noqa: F405
    lights(h, mach, 7.0, .9)
    gutters(h, mach, pipes=((2.0, -2.0), (2.0, -2.0)))
    h.export()


# ======================================================================================================================
# 06. x -11.7, z -752.8: an older brick stable by the road, a row of small windows, a corrugated roof.
def stable_m12():
    h = Farm("fb_stable_m12", [-20.72, -767.46], ([-20.72, -767.46], [-18.57, -737.07]), 0,
             materials("#4a4e4c", "#4e4f51", "#4a3a30", {"vh_brick": {"texture": "nb_brick", "tint": "#8a4c3c", "normalScale": .6}}))
    Y = h.Y
    hall = Hall(h, (-20.78, -767.45), (-18.57, -737.07), (-4.82, -768.62), Y(6.88), Y(9.4), side=.4, under="#8f8a84", edge="#3f3d3b")

    def dress(i, L, g):
        if i in (0, 2):  # the long sides: small windows in a row, a door
            ops = [Opening(s, g + 2.1, 1.0, .7, frame="#e9e8e3", reveal=.18, sill=True, cols=2) for s in [2.5 + 3.2 * k for k in range(int((L - 4) / 3.2) + 1)] if abs(s - L / 2) > 1.2]  # noqa: F405
            ops.append(Opening(L / 2, g + .05, 1.1, 2.15, "door", door="#4a3a30", frame="#e9e8e3", reveal=.18, sill=False))  # noqa: F405
            return ops, []
        return [], [lambda W, N, T: slide(h, W, N, T, L / 2, 3.4, 3.2, g, "#e9e8e3", open_to=1)]

    ring_walls(h, h.outline, [hall], dress, mesh="vh_brick", plinth=.5, plinth_mesh="vh_plinth")
    draw_roofs(h, [hall.roof])  # noqa: F405
    gutters(h, hall, "#6f706c", pipes=((1.0, -1.0), (1.0, -1.0)))
    h.export()


# ======================================================================================================================
# 07. x 1033.2, z 47.7: a big storage hall by the Blekte with a lean-to along its west side and an older brick wing
# across its north end.
def hall_1030():
    h = Farm("fb_hall_1030", [1011.91, 27.25], ([1041.81, 23.43], [1011.91, 27.25]), 0,
             materials("#565c58", "#4b4d50", "#4a4e4c", {"vh_brick": {"texture": "nb_brick", "tint": "#9a7a62", "normalScale": .6}}))
    Y = h.Y
    big = Hall(h, (1019.02, 26.2), (1024.57, 71.88), (1041.81, 23.43), Y(2.29), Y(6.38), end=.35)
    # (the lean-to's top kept under the hall's eaves; its roof and the wing's run on into the slopes they meet)
    lean = Hall(h, (1011.88, 27.21), (1015.43, 56.5), (1019.04, 26.34), Y(.17), Y(2.15), kind="shed", side=.3, end=.3,
                ends=(True, 3.6), sides=(True, False))
    wing = Hall(h, (995.29, 58.94), (1022.6, 55.63), (997.27, 75.2), Y(-.09), Y(5.48), end=.3, ends=(True, 10.0),
                under="#8f8a84", edge="#3f3d3b")
    halls = [big, lean, wing]
    ring = h.outline
    WING = {1, 2, 3, 4, 5, 6}  # the wing's walls (and the little jog where it meets the hall)

    def dress(i, L, g):
        if i == 9:  # the south end: the hall's big sectional door, the lean-to's door
            return [sectional(L - 11.5, g, 5.0, 4.8), man_door(3.5, g)], [lambda W, N, T: band(h, W, N, T, 8.0, L - 1.0, g + 6.0, g + 6.8, .1, 2.0)]
        if i == 8:  # the long east side
            return [man_door(10.0, g)], [lambda W, N, T: band(h, W, N, T, 1.0, L - 1.0, g + 4.6, g + 5.2, .1, 2.5)]
        if i == 7:  # the north end: a sliding door
            return [], [lambda W, N, T: slide(h, W, N, T, L / 2, 5.0, 4.6, g, "#d9d9d4", open_to=1)]
        if i == 0:  # the lean-to's west side: light panels
            return [], [lambda W, N, T: band(h, W, N, T, 1.0, L - 1.0, g + 2.4, g + 3.0, .1, 2.5)]
        if i in (1, 3):  # the wing's long sides: small windows, a door
            ops = [Opening(s, g + 1.6, .9, .8, frame="#e9e8e3", reveal=.18, cols=2) for s in (3.0, 7.0, 11.0, 15.0) if s < L - 2]  # noqa: F405
            if i == 3:
                ops.append(Opening(L - 4.0, g + .05, 1.0, 2.1, "door", door="#4a3a30", frame="#e9e8e3", reveal=.18, sill=False))  # noqa: F405
            return ops, []
        if i == 2:  # the wing's west gable: a plank door
            return [Opening(L / 2, g + .05, 2.4, 2.6, "door", door="#4a3a30", frame="#e9e8e3", reveal=.18, sill=False)], []  # noqa: F405
        return [], []

    ring_walls(h, ring, halls, dress, mesh=lambda i: "vh_brick" if i in WING else "vh_sheet",
               plinth=lambda i: .5 if i in WING else (3.2 if i == 0 else 2.4))
    junction(h, (1019.02, 26.2), (1022.6, 55.63), big, lean)
    junction(h, (1022.6, 55.63), (1024.57, 71.88), big, wing)
    draw_roofs(h, [x.roof for x in halls])  # noqa: F405
    lights(h, big, 6.5, .9)
    gutters(h, big, which=(1,), pipes=((), (1.5, -1.5)))
    gutters(h, lean, which=(0,), pipes=((1.5,),))
    gutters(h, wing, "#6f706c", which=(1,), pipes=((), (1.5,)))
    h.export()


FARMS = {"fb_stables_1255": stables_1255, "fb_shed_31": shed_31, "fb_barn_537": barn_537, "fb_store_1399": store_1399,
         "fb_pair_1170": pair_1170, "fb_stable_m12": stable_m12, "fb_hall_1030": hall_1030}
for _name, _build in FARMS.items():
    if not ONLY or _name in ONLY:  # noqa: F405
        _build()
