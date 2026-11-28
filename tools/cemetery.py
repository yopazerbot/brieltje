"""The village cemetery north-west of the church, at the end of the street behind it, as a model of our own in place of
the plain paved patch the open data draws there (a `pave_light` cover of about 1,900 m2, its middle near x 414,
z -591 in web/src/data/village.json, which stays in the data under the model's own ground).

  blender -b -P tools/cemetery.py -- web/public/models

writes web/public/models/cemetery.glb with the toolkit of the hand-made village houses (tools/village_houses_kit.py:
the ground, the meshes and materials by the game's own textures, `blocks` for walking into, the export). It stands in
for no house (`alone`: its root has no `replaces`); web/src/world/villageHouses.ts lists it with a reach of 350 m.

What it holds is what a small Flemish village cemetery typically has, not a copy of this one or of any grave: a clipped
yew hedge round three sides, a low brick wall with brick piers on the street side and a wrought-iron double gate that
stands open, a gravel main path from the gate to a tall stone cross at the far end, two side paths and a cross path,
grass between the rows, rows of plain headstones and grave slabs in blue stone and granite (some with a small cross on
top, some low kerbed graves filled with gravel), clipped thujas, benches, a tap and a bin by the gate. The layout
(the rows facing the paths, the cross path) follows the open orthophoto by eye only; nothing was traced or sampled.

Plain, calm and respectful, as it is a real place where real people lie: no name, date, inscription, photo, text,
emblem or symbol on any stone, nothing broken or eerie. Games build a cemetery from a few stone shapes repeated with
small changes of colour, height and spacing, and with gaps between them; so does this, every stone a few bevelled
boxes, about 8,000 triangles in all.

The frame: s along the cemetery from its far (south) end toward the street, w across it from its west side, both in
metres, turned 10 degrees from the game's axes to lie along the data's outline. The model's origin is the middle of
the gate; its u is w - W_GATE and its d is s - S_WALL (the kit's frame: u along the front, d out of it).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (House, terrain, clip_convex, area, inside, Vector, VILLAGE, the materials)

NAME = "cemetery"
# The data's cover of the cemetery, found by a corner; the frame below fits its outline (an oriented box of 95 by 22 m).
CORNER = (394.8, -541.86)
TURN = math.radians(10.0)  # noqa: F405
T = Vector((math.sin(TURN), -math.cos(TURN)))  # noqa: F405  s: toward the street
N = Vector((math.cos(TURN), math.sin(TURN)))  # noqa: F405  w: across, from the west side
S0, W0 = 599.05, 293.95  # the box's corner as dot products with T and N
WIDTH = 22.2
S_WALL = 90.0  # the street side's wall
W_GATE = WIDTH / 2
HEDGE = .7  # thick
STONES = {  # blue stone and granites, darker and lighter (sRGB)
    "blue": "#3e4348", "dark": "#26282b", "black": "#1b1c1e", "grey": "#6a6c6e", "light": "#8d8e8c", "warm": "#5a4b47",
}


class Cemetery(House):  # noqa: F405
    """A House on its own frame: no wall block to stand in for."""

    def __init__(self, meshes):
        cover = next(p for p in VILLAGE["prisms"] if p["m"] == "pave_light" and any(abs(q[0] - CORNER[0]) < .02 and abs(q[1] - CORNER[1]) < .02 for q in p["p"][0]))  # noqa: F405
        self.cover = cover["p"][0]
        self.name = NAME
        self.along, self.depth = N.copy(), T.copy()  # the kit's handedness: depth = (along.y, -along.x)
        assert abs(self.depth.x - self.along.y) < 1e-9 and abs(self.depth.y + self.along.x) < 1e-9
        self.origin = self.rect(S_WALL, W_GATE)
        self.ground0 = terrain(*self.origin)  # noqa: F405
        self.base = 0
        self.meshes = meshes
        self.faces = defaultdict(list)  # noqa: F405
        self.replaces = []
        self.blocks = []
        self.rng = random.Random(NAME)  # noqa: F405
        self.ring = [self.local(p) for p in self.cover]
        self.foot = -1.0

    def rect(self, s, w):
        """A world point (x, z) of the frame."""
        return T * (S0 + s) + N * (W0 + w)

    def at(self, s, w):
        """The frame's point as the kit's local (u, d)."""
        return (w - W_GATE, s - S_WALL)

    def g(self, s, w):
        """The ground's height there, over the ground at the origin."""
        return self.ground(*self.at(s, w))

    # --- in the frame ---------------------------------------------------------------------------------------------
    def fbox(self, mesh, s0, s1, w0, w1, y0, y1, color=None):
        """A box in the frame (y over the origin's ground), with no bottom."""
        (u0, d0), (u1, d1) = self.at(s0, w0), self.at(s1, w1)
        self.box(mesh, min(u0, u1), max(u0, u1), min(d0, d1), max(d0, d1), y0, y1, color)

    def fblock(self, m, s0, s1, w0, w1, y0, y1):
        self.block(m, [self.at(s0, w0), self.at(s0, w1), self.at(s1, w1), self.at(s1, w0)], y0, y1)

    def drape(self, mesh, s0, s1, w0, w1, lift, color=None):
        """Ground over a rectangle of the frame, on the relief: cut along the terrain's own grid and diagonals, so it
        lies exactly `lift` over the grass everywhere (world/modelGround.ts claims it over the data's cover)."""
        rect = [tuple(self.rect(s, w)) for s, w in ((s0, w0), (s1, w0), (s1, w1), (s0, w1))]
        xs, zs = [p[0] for p in rect], [p[1] for p in rect]
        st = GRID["step"]  # noqa: F405
        i0, i1 = int((min(xs) - GRID["x0"]) // st), int((max(xs) - GRID["x0"]) // st)  # noqa: F405
        j0, j1 = int((min(zs) - GRID["z0"]) // st), int((max(zs) - GRID["z0"]) // st)  # noqa: F405
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                x, z = GRID["x0"] + i * st, GRID["z0"] + j * st  # noqa: F405
                for tri in ([(x, z), (x + st, z), (x + st, z + st)], [(x, z), (x + st, z + st), (x, z + st)]):
                    piece = clip_convex(tri, rect)  # noqa: F405
                    if piece:
                        self.poly(mesh, [(*self.local(p), terrain(*p) - self.ground0 + lift) for p in piece], (0, 0, 1), color)  # noqa: F405

    def stone(self, mesh, s, w_front, w_back, profile, y, color):
        """An upright stone: a profile (x along s from its middle, y up) between two faces across w, bottom buried."""
        pts = [(s + x, yy) for x, yy in profile]
        if area(pts) < 0:  # noqa: F405
            pts.reverse()
        cs = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        P = lambda ps, w, yy: (*self.at(ps, w), y + yy)
        front = -1 if w_front < w_back else 1
        self.poly(mesh, [P(a, w_front, b) for a, b in pts], (front, 0, 0), color)
        self.poly(mesh, [P(a, w_back, b) for a, b in pts], (-front, 0, 0), color)
        for (a0, b0), (a1, b1) in zip(pts, pts[1:] + pts[:1]):
            if b0 < 1e-6 and b1 < 1e-6:
                continue  # its foot, in the ground
            out = (0, (a0 + a1) / 2 - cs, (b0 + b1) / 2 - cy)
            self.poly(mesh, [P(a0, w_front, b0), P(a1, w_front, b1), P(a1, w_back, b1), P(a0, w_back, b0)], out, color)


# ======================================================================================================================
def profiles(W, H, kind):
    """The face of a headstone W wide and H high: a few plain shapes, all without any sign on them."""
    c = min(.06, W * .1)
    if kind == "flat":  # straight with chamfered top corners
        return [(-W / 2, 0), (W / 2, 0), (W / 2, H - c), (W / 2 - c, H), (-W / 2 + c, H), (-W / 2, H - c)]
    if kind == "round":  # a shallow rounded top
        top = [(W / 2 * math.cos(math.pi * k / 4), H + .12 * math.sin(math.pi * k / 4)) for k in range(5)]  # noqa: F405
        return [(-W / 2, 0), (W / 2, 0)] + top
    if kind == "gable":  # a low point
        return [(-W / 2, 0), (W / 2, 0), (W / 2, H), (0, H + .1), (-W / 2, H)]
    if kind == "shoulder":  # a narrower top over two shoulders
        k = W * .18
        return [(-W / 2, 0), (W / 2, 0), (W / 2, H - .14), (W / 2 - k, H - .14), (W / 2 - k, H), (-W / 2 + k, H), (-W / 2 + k, H - .14), (-W / 2, H - .14)]
    raise ValueError(kind)


def grave(h, s, w_head, f, r, recent):
    """One grave, s its middle along the row, its head at w_head and its foot toward w_head + f * 2 (f: +1 or -1)."""
    color = STONES[r.choice(["blue", "blue", "dark", "dark", "black", "grey", "grey", "light", "warm"])]
    mesh = "vh_granite" if color in (STONES["dark"], STONES["black"], STONES["warm"]) else "vh_stone"
    width = r.choice((.8, .9, .9, 1.0))
    length = r.choice((1.8, 1.9, 2.0))
    kind = r.random()
    g = h.g(s, w_head + f * length / 2)
    w_foot = w_head + f * length
    # The bed: a slab, a kerb round gravel, or grass.
    lo, hi = min(w_head, w_foot), max(w_head, w_foot)
    if kind < (.5 if recent else .35):  # a covering slab
        h.fbox(mesh, s - width / 2, s + width / 2, lo, hi, g - .1, g + .14, color)
    elif kind < .75:  # a low kerb round a bed of gravel
        k = .08
        outer = [h.at(s - width / 2, lo), h.at(s + width / 2, lo), h.at(s + width / 2, hi), h.at(s - width / 2, hi)]
        inner = [h.at(s - width / 2 + k, lo + k), h.at(s + width / 2 - k, lo + k), h.at(s + width / 2 - k, hi - k), h.at(s - width / 2 + k, hi - k)]
        mu, md = h.at(s, (lo + hi) / 2)
        y0, y1, yg = g - .1, g + .14, g + .12
        for i in range(4):
            a, b, p, q = outer[i], outer[(i + 1) % 4], inner[i], inner[(i + 1) % 4]
            out = ((a[0] + b[0]) / 2 - mu, (a[1] + b[1]) / 2 - md, 0)
            h.poly(mesh, [(*a, y0), (*b, y0), (*b, y1), (*a, y1)], out, color)
            h.poly(mesh, [(*a, y1), (*b, y1), (*q, y1), (*p, y1)], (0, 0, 1), color)
        h.poly("vh_gravel", [(*p, yg) for p in inner], (0, 0, 1))
    # The headstone, at the head, its face to the foot (and to the path).
    sw = width - r.choice((.0, .1, .2))
    sh = r.choice((.6, .7, .8, .9, 1.0)) if kind >= .35 else r.choice((.5, .6, .7))
    thick = r.choice((.1, .12, .15))
    shape = r.choice(("flat", "flat", "round", "gable", "shoulder"))
    w_back = w_head + f * .05
    gh = h.g(s, w_back + f * thick / 2)
    if r.random() < .25:  # a plinth under it
        h.fbox(mesh, s - sw / 2 - .05, s + sw / 2 + .05, min(w_back - f * .05, w_back + f * (thick + .05)), max(w_back - f * .05, w_back + f * (thick + .05)), gh - .1, gh + .1, color)
        gh += .1
    h.stone(mesh, s, w_back + f * thick, w_back, profiles(sw, sh, shape), gh - .05, color)
    top = gh - .05 + sh + (.1 if shape in ("round", "gable") else 0)
    if shape in ("flat", "shoulder") and r.random() < .3:  # a small plain cross on top
        cw, ch = .05, .32
        w_mid = w_back + f * thick / 2
        h.fbox(mesh, s - cw, s + cw, w_mid - cw * .8, w_mid + cw * .8, top - .01, top + ch, color)
        h.fbox(mesh, s - .12, s + .12, w_mid - cw * .8, w_mid + cw * .8, top + ch * .58, top + ch * .58 + .09, color)
        top += ch
    h.fblock("stone", s - sw / 2, s + sw / 2, min(w_back, w_back + f * thick), max(w_back, w_back + f * thick), gh - .3, top)


def bench(h, s, w, along_s=True, face=1):
    """A bench of wooden slats on two concrete legs, its back away from `face` (+1: it looks toward larger w or s)."""
    g = h.g(s, w)
    wood, legs = "#6e5641", "#9c9a94"
    L = 1.8
    if along_s:  # the bench runs along s, looking across w
        for ds in (-.7, .7):
            h.fbox("vh_trim", s + ds - .06, s + ds + .06, w - .25, w + .25, g - .1, g + .42, legs)
        for k in range(3):
            w0 = w - .22 + k * .15
            h.fbox("vh_trim", s - L / 2, s + L / 2, w0, w0 + .12, g + .42, g + .47, wood)
        wb = w - face * .27
        for ds in (-.7, .7):
            h.fbox("vh_trim", s + ds - .05, s + ds + .05, wb - .04, wb + .04, g + .42, g + .85, legs)
        for y in (.58, .74):
            h.fbox("vh_trim", s - L / 2, s + L / 2, wb - .03 * face - .02, wb - .03 * face + .02, g + y, g + y + .11, wood)
        h.fblock("old_wood", s - L / 2, s + L / 2, w - .3, w + .3, g - .1, g + .47)
    else:  # it runs across w, looking along s
        for dw in (-.7, .7):
            h.fbox("vh_trim", s - .25, s + .25, w + dw - .06, w + dw + .06, g - .1, g + .42, legs)
        for k in range(3):
            s0 = s - .22 + k * .15
            h.fbox("vh_trim", s0, s0 + .12, w - L / 2, w + L / 2, g + .42, g + .47, wood)
        sb = s - face * .27
        for dw in (-.7, .7):
            h.fbox("vh_trim", sb - .04, sb + .04, w + dw - .05, w + dw + .05, g + .42, g + .85, legs)
        for y in (.58, .74):
            h.fbox("vh_trim", sb - .02, sb + .02, w - L / 2, w + L / 2, g + y, g + y + .11, wood)
        h.fblock("old_wood", s - .3, s + .3, w - L / 2, w + L / 2, g - .1, g + .47)


def thuja(h, s, w, height=2.4, r=.55):
    """A clipped thuja or yew: a tall rounded column of the hedge's leaves."""
    g = h.g(s, w)
    u, d = h.at(s, w)
    h.blob("vh_hedge", u, d, g + height / 2 - .1, (r, r, height / 2), rings=4, steps=7)
    h.block("nb_hedge", [(u - r * .7, d - r * .7), (u + r * .7, d - r * .7), (u + r * .7, d + r * .7), (u - r * .7, d + r * .7)], g - .2, g + height)


def gate_leaf(h, s_hinge, w_hinge, length, toward):
    """One leaf of the wrought-iron gate, standing open against the inside of the wall: it runs from its hinge down
    along s (into the cemetery), its bars upright, a ring of plain scroll-free rails."""
    iron = "#1f2122"
    g = h.g(s_hinge, w_hinge)
    s1 = s_hinge - length
    w0, w1 = w_hinge - .02, w_hinge + .02
    for y0, y1 in ((.08, .13), (.62, .66), (1.36, 1.42)):  # rails
        h.fbox("vh_iron_small", s1, s_hinge, w0 - .005, w1 + .005, g + y0, g + y1, iron)
    for sx in (s_hinge - .03, s1 + .03):  # stiles
        h.fbox("vh_iron_small", sx - .025, sx + .025, w0 - .01, w1 + .01, g + .05, g + 1.5, iron)
    n = int(length / .13)
    for k in range(1, n):  # bars, a little higher toward the free end
        sx = s_hinge - length * k / n
        top = 1.42 + .12 * k / n
        h.fbox("vh_iron_small", sx - .011, sx + .011, w0, w1, g + .13, g + top, iron)
    h.fblock("steel", s1, s_hinge, w0, w1, g - .1, g + 1.5)


def pier(h, s, w, height=1.65):
    g = h.g(s, w)
    h.fbox("vh_brick", s - .24, s + .24, w - .24, w + .24, g - .3, g + height)
    h.fbox("vh_stone", s - .29, s + .29, w - .29, w + .29, g + height, g + height + .09, STONES["blue"])
    h.fbox("vh_stone", s - .2, s + .2, w - .2, w + .2, g + height + .09, g + height + .16, STONES["blue"])
    h.fblock("nb_red", s - .24, s + .24, w - .24, w + .24, g - .3, g + height + .16)


def wall(h, w0, w1, s=S_WALL, height=1.0):
    """The low brick wall on the street side, a blue-stone coping on it, cut into pieces of at most 4 m on the relief."""
    n = max(1, math.ceil((w1 - w0) / 4))  # noqa: F405
    for k in range(n):
        a, b = w0 + (w1 - w0) * k / n, w0 + (w1 - w0) * (k + 1) / n
        g = min(h.g(s, a), h.g(s, b))
        h.fbox("vh_brick", s - .15, s + .15, a, b, g - .3, g + height)
        h.fbox("vh_stone", s - .19, s + .19, a, b, g + height, g + height + .07, STONES["blue"])
        h.fblock("nb_red", s - .15, s + .15, a, b, g - .3, g + height + .07)


def hedge(h, s0, s1, w0, w1, height=1.5):
    """A clipped yew hedge on the relief, in pieces of at most 6 m, its blocks for walking into."""
    long_s = s1 - s0 > w1 - w0
    span = (s1 - s0) if long_s else (w1 - w0)
    n = max(1, math.ceil(span / 6))  # noqa: F405
    for k in range(n):
        if long_s:
            a, b = s0 + span * k / n, s0 + span * (k + 1) / n
            g = min(h.g(a, (w0 + w1) / 2), h.g(b, (w0 + w1) / 2))
            h.fbox("vh_hedge", a, b, w0, w1, g - .2, g + height)
            h.fblock("nb_hedge", a, b, w0, w1, g - .2, g + height)
        else:
            a, b = w0 + span * k / n, w0 + span * (k + 1) / n
            g = min(h.g((s0 + s1) / 2, a), h.g((s0 + s1) / 2, b))
            h.fbox("vh_hedge", s0, s1, a, b, g - .2, g + height)
            h.fblock("nb_hedge", s0, s1, a, b, g - .2, g + height)


def calvary(h, s, w):
    """A tall plain stone cross on a stepped base at the end of the main path."""
    g = h.g(s, w)
    c = STONES["blue"]
    y = g - .1
    for half, rise in ((1.0, .3), (.7, .3), (.35, .5)):
        h.fbox("vh_stone", s - half, s + half, w - half, w + half, y, y + rise, c)
        y += rise
        if half > .5:
            h.fblock("stone", s - half, s + half, w - half, w + half, g - .3, y)
    h.fbox("vh_stone", s - .13, s + .13, w - .13, w + .13, y, y + 3.4, c)
    h.fbox("vh_stone", s - .13, s + .13, w - .8, w + .8, y + 2.35, y + 2.6, c)
    h.fbox("vh_stone", s - .17, s + .17, w - .17, w + .17, y + 3.4, y + 3.47, c)  # a small cap on the shaft
    h.fblock("stone", s - .35, s + .35, w - .35, w + .35, g, y + 3.47)


def tap_and_bin(h, s, w):
    """A water tap on a dark green post over a grid, and a green bin beside it."""
    green = "#2f4a3a"
    g = h.g(s, w)
    h.fbox("vh_stone", s - .3, s + .3, w - .3, w + .3, g - .1, g + .06, "#7c7b77")
    h.fbox("vh_iron_small", s - .05, s + .05, w - .2, w - .1, g + .06, g + 1.05, green)
    h.fbox("vh_iron_small", s - .025, s + .025, w - .1, w + .05, g + .82, g + .87, "#8f9390")  # the spout
    h.fbox("vh_iron_small", s - .035, s + .035, w + .02, w + .07, g + .76, g + .82, "#8f9390")
    h.fblock("steel", s - .05, s + .05, w - .2, w - .1, g, g + 1.05)
    u, d = h.at(s, w + .75)
    gb = h.g(s, w + .75)
    h.rod("vh_iron_small", (u, d, gb - .05), (u, d, gb + .85), .26, 8, green)
    h.rod("vh_iron_small", (u, d, gb + .85), (u, d, gb + .9), .29, 8, "#273d30")
    h.block("steel", [(u - .26, d - .26), (u + .26, d - .26), (u + .26, d + .26), (u - .26, d + .26)], gb - .05, gb + .9)


# ======================================================================================================================
def build():
    h = Cemetery({
        "vh_lawn": {"texture": "grass", "tint": "#b9c7a2"},
        "vh_gravel": {"texture": "gravel", "tint": "#d4ccbd"},
        "vh_pavers": {"texture": "pavers", "tint": "#a5a39d"},
        "vh_clinker": {"texture": "clinker", "tint": "#b0705a"},
        "vh_hedge": {"texture": "hedge", "tint": "#62804a"},
        "vh_brick": {"texture": "nb_brick", "tint": "#8a5444", "normalScale": .55},
        "vh_stone": {"tint": "#ffffff", "rough": .82},
        "vh_granite": {"tint": "#ffffff", "rough": .32},  # polished
        "vh_trim": TRIM, "vh_iron_small": {"tint": "#ffffff", "rough": .55, "metal": .4},  # noqa: F405
    })
    for s, w in ((0, 0), (0, WIDTH), (S_WALL, 0), (S_WALL, WIDTH)):
        p = h.rect(s, w)
        if not inside(h.cover, tuple(p)):  # noqa: F405
            print(f"note: the frame's corner s {s}, w {w} lies outside the data's cover")
    E = HEDGE + .2  # the hedges' inner face
    # The ground: grass over the whole, gravel paths over it (claimed higher: world/modelGround.ts cuts the grass under).
    h.drape("vh_lawn", .2, S_WALL - .15, .2, WIDTH - .2, .03)
    main = (W_GATE - 1.5, W_GATE + 1.5)
    side = ((3.6, 5.0), (WIDTH - 5.0, WIDTH - 3.6))
    h.drape("vh_gravel", 1.0, S_WALL + .15, *main, .05)
    for w0, w1 in side:
        h.drape("vh_gravel", 1.0, 85.0, w0, w1, .05)
    h.drape("vh_gravel", 45.0, 46.8, E, main[0], .05)  # the cross path, in two halves either side of the main path
    h.drape("vh_gravel", 45.0, 46.8, main[1], WIDTH - E, .05)
    h.drape("vh_gravel", 85.0, S_WALL - .15, E, main[0], .05)  # inside the gate, across
    h.drape("vh_gravel", 85.0, S_WALL - .15, main[1], WIDTH - E, .05)
    h.drape("vh_gravel", 1.0, 7.4, side[0][1], main[0], .05)  # round the cross at the far end
    h.drape("vh_gravel", 1.0, 7.4, main[1], side[1][0], .05)
    # The hedges round three sides, the wall and the gate on the street side.
    hedge(h, .2, S_WALL - .15, .2, .2 + HEDGE)
    hedge(h, .2, S_WALL - .15, WIDTH - .2 - HEDGE, WIDTH - .2)
    hedge(h, .2, .2 + HEDGE, .2 + HEDGE, WIDTH - .2 - HEDGE)
    for w in (.25, main[0] - .24, main[1] + .24, WIDTH - .25):
        pier(h, S_WALL, w)
    wall(h, .49, main[0] - .48)
    wall(h, main[1] + .48, WIDTH - .49)
    gate_leaf(h, S_WALL - .2, main[0] + .04, 1.45, 1)
    gate_leaf(h, S_WALL - .2, main[1] - .04, 1.45, -1)
    # The rows: graves face the paths, heads to the hedges and back to back in the middle columns.
    r = random.Random("cemetery rows")  # noqa: F405
    # (head w, direction to the foot); each column's foot lies by a path
    cols = [(E + .2, 1),  # along the west hedge, to the west path
            (side[0][1] + 2.1, -1), (side[0][1] + 2.2, 1),  # back to back, to the west path and the main path
            (main[1] + 2.1, -1), (main[1] + 2.2, 1),  # back to back, to the main path and the east path
            (WIDTH - E - .2, -1)]  # along the east hedge, to the east path
    graves = 0
    for k, (w_head, f) in enumerate(cols):
        outer = k in (0, 5)
        for s0, s1, recent in ((8.4 if not outer else 1.6, 44.4, False), (47.4, 84.2, True)):
            s = s0 + .6
            while s < s1 - .5:
                if r.random() < (.52 if recent else .46):
                    grave(h, s, w_head, f, r, recent)
                    graves += 1
                s += r.choice((1.25, 1.3, 1.35))
    # The cross, the thujas round it and along the paths, the benches, the tap and the bin.
    calvary(h, 3.6, W_GATE)
    for s, w in ((3.6, W_GATE - 2.8), (3.6, W_GATE + 2.8), (46.0, E + .7), (46.0, WIDTH - E - .7), (87.5, main[0] - 1.0), (87.5, main[1] + 1.0)):
        thuja(h, s, w)
    bench(h, 6.4, W_GATE - 4.6, along_s=False, face=-1)
    bench(h, 6.4, W_GATE + 4.6, along_s=False, face=-1)
    bench(h, 87.4, main[1] + 3.6, along_s=False, face=-1)
    tap_and_bin(h, 87.6, E + 1.2)
    print(f"{graves} graves")
    forecourt(h)
    # The data's fence posts and wires along the cemetery's sides stood just inside the new hedges: within the frame
    # and a metre round it they go (main.ts: clearFences), as the hedges stand in for them.
    gone = [[round(c, 2) for c in h.rect(s, w)] for s, w in ((-1, -1), (S_WALL, -1), (S_WALL, WIDTH + 1), (-1, WIDTH + 1))]
    h.export({"alone": True, "fencesGone": [gone]})


def forecourt(h):
    """The data's paved cover runs on a few metres past the wall: concrete pavers there, with a band of red clinkers
    along the wall's foot, as a village cemetery's forecourt often is. In strips a quarter of a metre wide across w,
    each as far as the cover reaches in its middle (the drapes are rectangles; the cover's edge is ragged)."""
    s0, step = S_WALL + .15, .25
    w = 0.0
    while w < WIDTH - 1e-6:
        w1 = min(WIDTH, w + step)
        reach = s0
        while reach < S_WALL + 8 and inside(h.cover, tuple(h.rect(reach + .05, (w + w1) / 2))):  # noqa: F405
            reach += .05
        if reach > s0 + .3:
            h.drape("vh_clinker", s0, min(reach, s0 + .45), w, w1, .04)
            if reach > s0 + .45:
                h.drape("vh_pavers", s0 + .45, reach, w, w1, .04)
        w = w1


build()
