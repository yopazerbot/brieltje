"""The fittings of the café at the church (code id `keet`): a Belgian brown café, dark wood, brass and old enamel.

tools/keet.py calls `fittings(api)` and writes them with the rooms into web/src/data/keet_rooms.json. Everything here is
drawn in the inside's one mesh (world/walkIn.ts part()); `api.solid` adds what stops walkers, shots and zombies.

The frame: u along the front from the west corner (0 to 5.73 m), v into the building (0 to 17.44 m), heights over the
floor. In the frame's own words west is u = 0 and south is the back (v grows). The doors' leaves and their sweeps are kept
free (tools/keet.py checks the doorways).

No lettering anywhere: no names, no brands, no numbers. The clock and the dart board carry ticks only, the pictures are
blank or three flat bands, the enamel plates a plain field with a stripe. Bottles and glasses are plain shapes.
"""
import math

# --- colours -----------------------------------------------------------------------------------------------------------
WOOD, DARK, TOP = "#4a2e1c", "#3a2416", "#2f1d10"
BRASS, IRON, ENAMEL, NICKEL = "#b08d3c", "#26262a", "#2f4a3a", "#a8a8a0"
CLOTH, CUSHION, OPAL, BULB, CREAM = "#1f6b45", "#1a5c3b", "#efe6cf", "#ffd9a0", "#d9c9a0"
NET, PORCELAIN, SEAT, MICA = "#f1ede2", "#ecebe6", "#5c4330", "#c8742a"
MIRROR, GLASS, FRIDGE, TILL = "#87959a", "#b9c6c4", "#2a2a2c", "#6b6b6f"
BOTTLES = ("#5a3418", "#2f5a34", "#93a8a0")
MAT_CREAM, MAT_RED, CORK, STEEL, CARD = "#e3d6b4", "#8a3a32", "#b98d5c", "#b4b6b8", "#f4f1e8"
FACE, BLACK, SHADE = "#e9dfc2", "#151515", "#24402f"
BLUE, RED, WHITE = "#23395b", "#7a2e2a", "#f0ede4"
BANDS = (("#b9c6c8", "#7f9a6a", "#b59a62"), ("#c9c2a8", "#6f8a5c", "#8a6a48"), ("#aebcc6", "#5f7f6a", "#a88d5a"))
BALLS = ("#d8b020", "#2a4a9a", "#b8342a", "#5a2a7a", "#d8742a", "#2a7a4a", "#7a2a2a")


def _away(room, u, v):
    """How far (u, v) lies outside a room's rectangle (0 inside)."""
    u0, v0, u1, v1 = room
    return math.hypot(max(u0 - u, 0, u - u1), max(v0 - v, 0, v - v1))


class Fit:
    """The part shapes of `api` with a few of the café's own: discs and rectangles on a wall, chairs, lamps."""

    def __init__(self, api):
        self.api = api
        rooms = api.rooms
        # The ceiling's beams (tools/keet.py: every 0.9 m from 0.45 m in, 12 cm wide, 14 cm deep).
        self.beams = []
        for u, v in ((2.5, 4.0), (4.0, 12.0)):  # the front room and the bar room, found by a point in each
            u0, v0, u1, v1 = self.room(u, v)
            v = v0 + .45
            while v + .06 < v1:
                self.beams.append((u0, u1, v))
                v += .9

    def ceiling(self, u, v):
        """The height of the ceiling or a beam's underside over (u, v)."""
        for u0, u1, bv in self.beams:
            if u0 <= u <= u1 and abs(v - bv) < .075:
                return 2.61
        return 2.75

    def room(self, u, v):
        """The rectangle (u0, v0, u1, v1) of the room round (u, v), whatever its name in tools/keet.py."""
        return self.api.rooms[min(self.api.rooms, key=lambda n: _away(self.api.rooms[n], u, v))]

    def solid(self, u0, v0, u1, v1, y0, y1):
        """A block that stops walkers, shots and zombies, named after the room it stands in: standing on it is still
        being in that room (the HUD's place, indoors for the parachute and the sound)."""
        um, vm = (u0 + u1) / 2, (v0 + v1) / 2
        name = min(self.api.rooms, key=lambda n: _away(self.api.rooms[n], um, vm))
        self.api.solid(u0, v0, u1, v1, y0, y1, name)

    # --- on a wall ---
    def rect(self, axis, at, depth, c, y, length, height, angle=0.0, color=CREAM):
        """A rectangle on a wall: the wall across `axis` ('u' or 'v') at `at`, standing `depth` out of it (signed, towards
        the room), centred at `c` along the wall and `y` up, `length` along its own direction at `angle` from the level."""
        if abs(math.cos(angle)) < 1e-3:
            angle, length, height = 0.0, height, length
        dc, dy = math.cos(angle) * length / 2, math.sin(angle) * length / 2
        mid = at + depth / 2
        if axis == "v":
            a, b = (c - dc, y - dy, mid), (c + dc, y + dy, mid)
        else:
            a, b = (mid, y - dy, c - dc), (mid, y + dy, c + dc)
        self.api.beam(a, b, abs(depth), height, color)

    def disc(self, axis, at, depth, c, y, r, color, sides=12):
        """A round plate on a wall: a regular polygon of `sides` (8 or 12) as rectangles turned round its middle."""
        m = sides // 2
        h = 2 * r * math.tan(math.pi / (2 * m))
        for k in range(m):
            self.rect(axis, at, depth, c, y, 2 * r, h, k * math.pi / m, color)

    def framed(self, axis, at, sign, c, y, w, h, bands=None):
        """A picture: a dark frame, a blank cream field or three flat bands of colour (a plain landscape)."""
        self.rect(axis, at, sign * .025, c, y, w, h, 0, DARK)
        fw, fh = w - .08, h - .08
        if bands is None:
            self.rect(axis, at, sign * .03, c, y, fw, fh, 0, CREAM)
            return
        for k, col in enumerate(bands):
            bh = fh * (.45, .3, .25)[k]
            top = y + fh / 2 - sum(fh * s for s in (.45, .3, .25)[:k])
            self.rect(axis, at, sign * .03, c, top - bh / 2, fw, bh, 0, col)

    # --- standing things ---
    def chair(self, cu, cv, fu, fv):
        """A bentwood café chair at (cu, cv) facing (fu, fv): a round seat, four splayed legs with a ring, two bent hoops
        for its back. Its solid: 0.42 m square, as high as the seat."""
        api = self.api
        ru, rv = fv, -fu

        def p(a, b, y):
            return (cu + a * ru + b * fu, y, cv + a * rv + b * fv)

        api.lathe(cu, .43, cv, [(0, 0), (.2, 0), (.2, .03), (0, .03)], SEAT, 10)
        for a, b in ((.13, .13), (-.13, .13), (.13, -.13), (-.13, -.13)):
            api.rod(p(a, b, .43), p(a * 1.19, b * 1.19, 0), .013, DARK, 6)
        api.lathe(cu, .2, cv, [(.2, 0), (.2, .016)], DARK, 6)
        for s in (1, -1):
            api.rod(p(s * .13, -.13, .43), p(s * .15, -.19, .75), .012, DARK, 6)
            api.rod(p(s * .15, -.19, .75), p(s * .1, -.215, .85), .012, DARK, 6)
            api.rod(p(s * .1, -.215, .85), p(0, -.225, .88), .012, DARK, 6)
            api.rod(p(s * .075, -.17, .46), p(s * .075, -.205, .66), .01, DARK, 6)
        api.rod(p(-.075, -.205, .66), p(.075, -.205, .66), .01, DARK, 6)
        self.solid(cu - .21, cv - .21, cu + .21, cv + .21, 0, .46)

    def stool(self, cu, cv):
        """A bar stool: a round seat of 0.34 m at 0.76 m on four splayed legs with a foot ring."""
        api = self.api
        api.lathe(cu, .72, cv, [(0, 0), (.17, 0), (.17, .04), (0, .04)], WOOD, 12)
        for su, sv in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            api.rod((cu + su * .09, .72, cv + sv * .09), (cu + su * .14, 0, cv + sv * .14), .016, DARK, 6)
        api.lathe(cu, .29, cv, [(.168, 0), (.168, .02)], BRASS, 12)
        self.solid(cu - .18, cv - .18, cu + .18, cv + .18, 0, .76)

    def mat(self, u, y, v, k):
        """A beer mat: a plain disc of 10 cm."""
        self.api.lathe(u, y, v, [(.05, 0), (.05, .004), (0, .004)], (MAT_CREAM, MAT_RED)[k % 2], 8)

    def pendant(self, u, v, bottom, r, color=OPAL):
        """A hanging lamp: a cord and a brass cap, a closed shade of opal glass with its underside at `bottom`."""
        api = self.api
        h = r * .8
        api.lathe(u, bottom, v, [(0, 0), (r, 0), (r * .85, h * .45), (r * .35, h * .9), (0, h)], color, 8)
        api.lathe(u, bottom + h - .01, v, [(.03, 0), (.025, .05), (0, .05)], BRASS, 6)
        api.rod((u, bottom + h + .04, v), (u, self.ceiling(u, v), v), .006, IRON, 6)

    def globe(self, u, v, bottom, r=.09):
        """A small opal globe on a brass rod."""
        api = self.api
        prof = [(r * math.sin(math.pi * k / 4), r - r * math.cos(math.pi * k / 4)) for k in range(5)]
        api.lathe(u, bottom, v, prof, OPAL, 8)
        api.lathe(u, bottom + 2 * r - .015, v, [(.035, 0), (.035, .03), (0, .03)], BRASS, 6)
        api.rod((u, bottom + 2 * r + .015, v), (u, self.ceiling(u, v), v), .008, BRASS, 6)

    def bulb(self, u, v, bottom=2.33):
        """A bare bulb on its cord."""
        api = self.api
        api.lathe(u, bottom, v, [(0, 0), (.025, .012), (.03, .04), (.014, .07), (0, .072)], BULB, 6)
        api.rod((u, bottom + .07, v), (u, bottom + .11, v), .015, WHITE, 6)
        api.rod((u, bottom + .11, v), (u, self.ceiling(u, v), v), .005, IRON, 6)


def counter(f):
    """The counter: its block (tools/keet.py) dressed as a panelled front of dark wood, a top with an overhang, a brass
    foot rail on brackets; on it a tap column, a till and beer mats."""
    api = f.api
    u0, v0, u1, v1, h = 2.20, 7.67, 2.80, 10.85, 1.10
    api.box((u0 + u1 + .03) / 2, h, (v0 + v1) / 2, u1 - u0 + .07, .04, v1 - v0, TOP, 0, "oak")  # 5 cm over the front
    f.solid(u0, v0, u1 + .05, v1, 0, h + .04)  # over the plain block: its top, and a room's name to stand on
    # The front: a kick board, a top rail, four stiles and three fields between (the panels seem sunk between them).
    api.box(u1 + .01, 0, (v0 + v1) / 2, .02, .12, v1 - v0, DARK)
    api.box(u1 + .01, .98, (v0 + v1) / 2, .02, .12, v1 - v0, WOOD, 0, "oak")
    stiles = [v0 + .05, v0 + (v1 - v0) / 3, v0 + 2 * (v1 - v0) / 3, v1 - .05]
    for s in stiles:
        api.box(u1 + .01, .12, s, .02, .86, .1, WOOD, 0, "oak")
    for a, b in zip(stiles, stiles[1:]):
        api.box(u1 + .005, .2, (a + b) / 2, .01, .7, b - a - .22, DARK, 0, "oak")
    # Its end by the gate: one field.
    api.box((u0 + u1) / 2, .12, v1 + .005, u1 - u0 - .12, .86, .01, DARK, 0, "oak")
    # The foot rail, 0.20 m up and 0.12 m out from the front, on four brackets.
    api.rod((u1 + .12, .2, v0 + .06), (u1 + .12, .2, v1 - .04), .025, BRASS, 8)
    for v in (v0 + .25, v0 + 1.25, v0 + 2.25, v1 - .2):
        api.rod((u1 + .02, .3, v), (u1 + .12, .2, v), .012, BRASS, 6)
    top = h + .04
    # The tap column (the bartender pulls from behind, towards -u): a brass post, a cross bar, three plain taps with
    # white handles, a drip tray under them.
    tu, tv = 2.52, 9.0
    api.rod((tu, top, tv), (tu, top + .45, tv), .03, BRASS, 8)
    api.rod((tu, top + .38, tv - .2), (tu, top + .38, tv + .2), .025, BRASS, 8)
    for v in (tv - .14, tv, tv + .14):
        api.rod((tu, top + .38, v), (tu - .1, top + .33, v), .012, BRASS, 6)
        api.rod((tu - .1, top + .33, v), (tu - .1, top + .25, v), .01, BRASS, 6)
        api.rod((tu - .01, top + .4, v), (tu - .03, top + .56, v), .012, WHITE, 6)
    api.box(tu - .1, top, tv, .16, .02, .44, NICKEL)
    # The till: a body, a sloped bank of keys, a small display.
    api.box(2.48, top, 10.4, .4, .13, .35, TILL)
    api.beam((2.31, top + .17, 10.4), (2.55, top + .25, 10.4), .33, .05, TILL)
    api.box(2.62, top + .13, 10.4, .14, .17, .35, TILL)
    api.box(2.62, top + .3, 10.4, .1, .07, .2, "#3a3a3e")
    api.box(2.31, top + .03, 10.4, .02, .05, .2, "#4a4a4e")
    for k, v in enumerate((8.0, 8.55, 9.55, 10.0)):
        f.mat(2.71, top, v, k)
    for v in (8.4, 9.25, 10.1):
        f.stool(3.1, v)
    for v in (8.3, 9.25, 10.2):
        f.globe(2.5, v, 2.05)


def back_bar(f):
    """Against the west wall behind the bar: three fridges with glass fronts, a cupboard and a small sink under one
    worktop, a mirror over it and three shelves of glasses and bottles."""
    api = f.api
    u0, u1, v0, v1 = .30, .90, 7.80, 11.60
    # The fridges: a body round three shelves of bottles, a glass front.
    fv = [7.80, 8.40, 9.00, 9.60]
    api.box(.34, 0, (fv[0] + fv[-1]) / 2, .04, .9, fv[-1] - fv[0], FRIDGE)  # the backs
    api.box((u0 + u1) / 2 + .02, 0, (fv[0] + fv[-1]) / 2, u1 - u0 - .04, .08, fv[-1] - fv[0], FRIDGE)  # the plinth
    for v in fv:
        api.box((u0 + u1) / 2 + .02, .08, min(max(v, fv[0] + .015), fv[-1] - .015), u1 - u0 - .04, .82, .03, FRIDGE)
    for a, b in zip(fv, fv[1:]):
        api.box(u1 - .01, .84, (a + b) / 2, .02, .06, b - a, FRIDGE)  # the doors' top rails
        api.rod((u1 + .01, .2, b - .07), (u1 + .01, .7, b - .07), .008, NICKEL, 6)  # handles
        api.block("glassfix", u1 - .015, a + .015, u1 - .005, b - .015, .08, .84, walk=False)
        for k, y in enumerate((.08, .36, .62)):
            if k:
                api.box((u0 + u1) / 2 + .02, y - .015, (a + b) / 2, u1 - u0 - .1, .015, b - a - .03, NICKEL)
            for j in range(4):
                v = a + .135 + j * .11
                col = BOTTLES[(j + k + int(a * 10)) % 3]
                api.lathe(.66, y, v, [(.028, 0), (.028, .15), (.011, .2), (0, .22)], col, 5)  # behind glass: five sides do
    # The cupboard and the sink's cabinet, the worktop over all, a steel top over the sink.
    api.box((u0 + u1) / 2 + .02, 0, 10.3, u1 - u0 - .04, .9, 1.4, WOOD, 0, "oak")
    for v in (9.95, 10.65):
        api.box(u1 + .005, .1, v, .01, .72, .62, DARK, 0, "oak")
        api.box(u1 + .015, .75, v + (.26 if v < 10 else -.26), .015, .04, .02, BRASS)
    api.box((u0 + u1) / 2 + .02, 0, 11.3, u1 - u0 - .04, .9, .6, WOOD, 0, "oak")
    api.box(u1 + .005, .1, 11.3, .01, .72, .5, DARK, 0, "oak")
    api.box((u0 + u1) / 2 + .01, .9, 9.4, u1 - u0 + .02, .04, 3.2, TOP, 0, "oak")
    api.box((u0 + u1) / 2 + .01, .9, 11.3, u1 - u0 + .02, .04, .6, STEEL)
    api.box(.62, .935, 11.3, .36, .01, .42, "#6e7072")  # the basin
    api.rod((.42, .94, 11.3), (.42, 1.2, 11.3), .012, NICKEL, 6)
    api.rod((.42, 1.2, 11.3), (.58, 1.15, 11.3), .01, NICKEL, 6)
    f.solid(u0, v0, u1 + .02, v1, 0, .94)
    # The mirror in a dark frame, and three shelves before it on two brass uprights.
    api.box(.325, 1.15, 9.7, .05, .95, 3.5, DARK)
    api.box(.335, 1.2, 9.7, .05, .85, 3.4, MIRROR)
    for v in (8.05, 11.35):
        api.rod((.5, 1.12, v), (.5, 2.1, v), .01, BRASS, 6)
    shelves = (1.25, 1.6, 1.95)
    for y in shelves:
        api.box(.44, y - .025, 9.7, .18, .025, 3.3, WOOD, 0, "oak")
    # On them: 36 glasses (straight, tulip, goblet) and 24 bottles, no labels.
    straight = [(.03, 0), (.034, .12), (0, .12)]  # open underneath: they stand on the shelf
    tulip = [(.026, 0), (.036, .06), (.03, .12), (0, .12)]
    goblet = [(.032, 0), (.006, .012), (.006, .07), (.04, .1), (0, .15)]
    bottle = [(.034, 0), (.034, .18), (.014, .24), (.012, .28), (0, .28)]
    for j in range(18):  # the lowest shelf: straight glasses and tulips
        v = 8.2 + j * .17 + (.2 if j >= 9 else 0)
        api.lathe(.44, shelves[0], v, straight if j % 2 else tulip, GLASS, 8)
    for k, y in enumerate(shelves[1:]):  # the upper two: bottles at both ends, goblets between
        for j in range(12):
            v = 8.15 + j * .1 + (1.7 if j >= 6 else 0)
            api.lathe(.45, y, v, bottle, BOTTLES[(j + k) % 3], 8)
            api.rod((.45, y + .275, v), (.45, y + .3, v), .013, BRASS if (j + k) % 2 else NICKEL, 6)
        for j in range(9):
            api.lathe(.44, y, 8.95 + j * .15, goblet, GLASS, 8)


def front_room(f):
    api = f.api
    # --- the pool table: centre (2.50, 4.40), 2.24 m along u, 1.27 m along v, 0.80 m high ---
    cu, cv, L, W = 2.50, 4.40, 2.24, 1.27
    u0, u1, v0, v1 = cu - L / 2, cu + L / 2, cv - W / 2, cv + W / 2
    leg = [(.06, 0), (.075, .04), (.05, .1), (.066, .3), (.05, .5), (.06, .56)]
    for u in (u0 + .14, cu, u1 - .14):
        for v in (v0 + .12, v1 - .12):
            api.lathe(u, 0, v, leg, WOOD, 6)
    api.box(cu, .56, cv, L - .06, .18, W - .06, WOOD, 0, "oak")
    api.box(cu, .62, cv, L - .24, .125, W - .24, CLOTH)
    rail = .12
    for v in (v0 + rail / 2, v1 - rail / 2):
        api.box(cu, .74, v, L, .06, rail, DARK, 0, "oak")
    for u in (u0 + rail / 2, u1 - rail / 2):
        api.box(u, .74, cv, rail, .06, W - 2 * rail, DARK, 0, "oak")
    for a, b in ((u0 + rail + .06, cu - .05), (cu + .05, u1 - rail - .06)):
        for v in (v0 + rail + .02, v1 - rail - .02):
            api.box((a + b) / 2, .745, v, b - a, .045, .04, CUSHION)
    for u in (u0 + rail + .02, u1 - rail - .02):
        api.box(u, .745, cv, .04, .045, W - 2 * rail - .12, CUSHION)
    for u in (u0 + rail - .01, cu, u1 - rail + .01):  # the six pockets, dark notches in the corners and the long sides' middles
        for v in (v0 + rail - .01, v1 - rail + .01):
            api.box(u, .745, v, .1, .058, .1 if u != cu else .07, BLACK)
    for k in (1, 2, 3):  # the rails' small pale diamonds
        for s in (-1, 1):
            for v in (v0 + rail / 2, v1 - rail / 2):
                api.box(cu + s * k * .25, .8, v, .022, .003, .022, CREAM)
    for v in (cv - .26, cv, cv + .26):
        for u in (u0 + rail / 2, u1 - rail / 2):
            api.box(u, .8, v, .022, .003, .022, CREAM)
    # Fifteen balls in a triangle near the east end (plain colours: no numbers, no stripes) and the white one.
    r = .028
    ball = [(r * math.sin(math.pi * k / 4), r - r * math.cos(math.pi * k / 4)) for k in range(5)]
    n = 0
    for row in range(5):
        for j in range(row + 1):
            col = BLACK if (row, j) == (2, 1) else BALLS[n % 7]
            if (row, j) != (2, 1):
                n += 1
            api.lathe(3.0 + row * .0495, .745, cv + (j - row / 2) * .0575, ball, col, 6)
    api.lathe(1.95, .745, cv + .05, ball, WHITE, 6)
    f.solid(u0, v0, u1, v1, 0, .8)
    # The lamp over it: a long dark green shade with brass rims, warm bulbs under it, on two chains.
    y0 = 1.75
    api.box(cu, y0 + .13, cv, 1.4, .02, .255, SHADE)
    for s in (-1, 1):
        api.box(cu, y0, cv + s * .12, 1.4, .13, .015, SHADE)
        api.box(cu + s * .7, y0, cv, .015, .13, .255, SHADE)
        api.beam((cu - .71, y0 + .006, cv + s * .128), (cu + .71, y0 + .006, cv + s * .128), .02, .012, BRASS)
    api.box(cu, y0 + .1, cv, 1.36, .01, .22, BULB)  # the bulbs' warm glow behind a diffuser
    for u in (cu - .5, cu + .5):
        api.rod((u, y0 + .15, cv), (u, f.ceiling(u, cv), cv), .006, BRASS, 6)

    # --- the cue rack on the west wall at v 4.4, four cues in it, the triangle hung on it; two cues in the corner ---
    api.box(.33, 1.2, 4.4, .06, .6, .8, WOOD, 0, "oak")
    api.box(.37, .22, 4.4, .1, .04, .8, WOOD, 0, "oak")  # the butts' ledge
    clips = [4.08 + k * .128 for k in range(6)]
    for v in clips:
        api.box(.38, 1.7, v, .04, .03, .03, BRASS)
    for v in (clips[0], clips[1], clips[4], clips[5]):
        api.rod((.39, .26, v), (.39, .82, v), .015, DARK, 6)
        api.rod((.39, .82, v), (.385, 1.76, v), .01, "#d8c08a", 6)
    for a, b in (((.37, 1.62, 4.4), (.37, 1.36, 4.25)), ((.37, 1.36, 4.25), (.37, 1.36, 4.55)), ((.37, 1.36, 4.55), (.37, 1.62, 4.4))):
        api.beam(a, b, .025, .03, WOOD)
    for k, (bu, bv) in enumerate(((.47, 7.35), (.42, 7.28))):
        top = (.335, 1.45 - k * .03, 7.5 - k * .02)
        mid = (bu + (top[0] - bu) * .38, .55, bv + (top[2] - bv) * .38)
        api.rod((bu, 0, bv), mid, .015, DARK, 6)
        api.rod(mid, top, .01, "#d8c08a", 6)

    # --- the dart board on the west wall at v 6.3, centre 1.73 m, in a square wooden surround; a blank slate beside ---
    dv, dy = 6.3, 1.73
    api.box(.32, dy - .3, dv, .04, .6, .6, WOOD, 0, "oak")
    f.disc("u", .34, .01, dv, dy, .225, BLACK)
    f.disc("u", .34, .014, dv, dy, .17, RED)
    f.disc("u", .34, .018, dv, dy, .16, CREAM)
    for k in range(10):  # ten dark wedges between the cream ones (a twentieth turn each)
        t = math.pi / 2 + k * math.pi / 5
        for r0, r1 in ((.018, .085), (.085, .159)):
            rm = (r0 + r1) / 2
            f.rect("u", .34, .022, dv + rm * math.cos(t), dy + rm * math.sin(t), r1 - r0, 2 * rm * math.tan(math.pi / 20), t, BLACK)
    f.disc("u", .34, .026, dv, dy, .018, "#2a7a4a", 8)
    f.disc("u", .34, .03, dv, dy, .008, RED, 8)
    api.box(.315, 1.48, 5.75, .03, .5, .42, DARK)
    api.box(.325, 1.51, 5.75, .03, .44, .36, "#2d3033")

    # --- the stove against the dividing wall: a Leuven stove on a plate of dark tiles, its pipe into the wall ---
    su, sv = 2.30, 7.205
    api.box(su, 0, 7.10, .9, .012, .9, "#3a3634")
    for a in (-1, 1):
        for b in (-1, 1):
            api.rod((su + a * .24, .012, sv + b * .18), (su + a * .24, .1, sv + b * .18), .022, IRON, 6)
    api.box(su, .1, sv, .55, .6, .45, IRON)
    for a in (-1, 1):
        api.box(su + a * .28, .17, sv, .01, .46, .33, ENAMEL)
    front = sv - .225
    api.box(su, .15, front - .005, .48, .51, .01, ENAMEL)
    api.box(su, .3, front - .012, .24, .25, .01, IRON)
    api.box(su, .35, front - .018, .16, .15, .006, MICA)
    api.box(su, .16, front - .012, .2, .08, .01, IRON)
    api.box(su + .1, .42, front - .025, .03, .02, .02, NICKEL)
    api.box(su, .7, 7.075, .6, .03, .75, IRON)
    api.beam((su - .3, .715, 6.695), (su + .3, .715, 6.695), .012, .036, NICKEL)
    for a in (-1, 1):
        api.beam((su + a * .305, .715, 6.69), (su + a * .305, .715, 7.45), .012, .036, NICKEL)
    for a, b in (((su - .33, .8, 6.67), (su + .33, .8, 6.67)), ((su - .33, .8, 6.67), (su - .33, .8, 7.4)), ((su + .33, .8, 6.67), (su + .33, .8, 7.4))):
        api.rod(a, b, .008, NICKEL, 6)
    for a, b in ((-1, 6.67), (1, 6.67), (-1, 7.4), (1, 7.4)):
        api.rod((su + a * .33, .73, b), (su + a * .33, .8, b), .006, NICKEL, 6)
    for a in (-1, 1):
        api.rod((su + a * .2, .4, front), (su + a * .2, .7, 6.72), .008, NICKEL, 6)
    api.lathe(su, .73, 7.36, [(.075, 0), (.075, .03)], NICKEL, 12)
    api.rod((su, .73, 7.36), (su, 2.05, 7.36), .06, IRON, 12)
    api.rod((su, 2.05, 7.36), (su, 2.17, 7.47), .06, IRON, 12)
    api.rod((su, 2.17, 7.45), (su, 2.17, 7.58), .06, IRON, 12)
    f.disc("v", 7.55, -.006, su, 2.17, .1, NICKEL, 8)
    f.solid(su - .3, 6.75, su + .3, 7.55, 0, .9)
    f.solid(su - .08, 7.28, su + .08, 7.55, .9, 2.26)
    # A coal scuttle beside it.
    api.lathe(2.95, 0, 7.25, [(0, 0), (.13, 0), (.15, .28), (.13, .32), (0, .29)], IRON, 8)
    api.rod((2.81, .3, 7.25), (2.95, .42, 7.25), .008, BRASS, 6)
    api.rod((2.95, .42, 7.25), (3.09, .3, 7.25), .008, BRASS, 6)
    f.solid(2.8, 7.1, 3.1, 7.4, 0, .34)

    # --- two café tables under the front window, two chairs each, a beer mat on each ---
    for k, tu in enumerate((1.40, 3.30)):
        table(f, tu, .68, k)
        f.chair(tu - .5, .68, 1, 0)
        f.chair(tu + .5, .68, -1, 0)
        f.pendant(tu, .68, 1.95, .13)
    # --- on the east wall: the coat rack, the notice board, a picture ---
    ue = 5.43
    api.box(ue - .015, 1.63, 5.6, .03, .13, 1.2, DARK, 0, "oak")
    for k in range(7):
        v = 5.06 + k * .18
        api.rod((ue - .03, 1.68, v), (ue - .1, 1.72, v), .007, BRASS, 6)
    api.curtain(ue - .1, 5.42, ue - .1, 5.78, 1.0, 1.68, .035, 3, "#3a4048")  # a plain coat
    api.beam((ue - .1, 1.67, 5.4), (ue - .1, 1.67, 5.8), .1, .04, "#3a4048")
    api.lathe(ue - .1, 1.66, 6.04, [(.085, 0), (.08, .05), (.04, .08), (0, .085)], "#5a4a3a", 8)  # a cap
    api.box(ue - .16, 1.66, 6.04, .08, .008, .14, "#5a4a3a")
    api.box(ue - .035, 1.2, 1.15, .07, .7, .9, DARK)
    api.box(ue - .04, 1.24, 1.15, .07, .62, .82, CORK)
    for k in range(6):
        api.box(ue - .076, 1.32 + (k // 3) * .26, .9 + (k % 3) * .25, .004, .16 + .03 * (k % 2), .14, CARD)
    f.framed("u", ue, -1, 4.45, 1.8, .5, .4, BANDS[0])
    # --- on the dividing wall, the front room's side: two plain enamel plates ---
    wd = 7.55
    for w, h in ((.5, .2), (.44, .3), (.32, .36)):  # an oval in dark blue (stepped), a white rim, one stripe
        f.rect("v", wd, -.008, 1.0, 1.85, w + .03, h + .03, 0, WHITE)
        f.rect("v", wd, -.012, 1.0, 1.85, w, h, 0, BLUE)
    f.rect("v", wd, -.016, 1.0, 1.85, .44, .035, 0, WHITE)
    f.rect("v", wd, -.008, 3.5, 1.93, .43, .31, 0, WHITE)  # a shield in dull red
    f.rect("v", wd, -.008, 3.5, 1.78, .3, .3, math.pi / 4, WHITE)
    f.rect("v", wd, -.012, 3.5, 1.93, .4, .28, 0, RED)
    f.rect("v", wd, -.012, 3.5, 1.78, .278, .278, math.pi / 4, RED)
    f.rect("v", wd, -.016, 3.5, 1.97, .4, .035, 0, WHITE)
    # --- net half-curtains on brass rails, 4 cm inside the glass ---
    for w in api.windows:
        if w["fixed"] == "v":
            at, y0, y1 = w["w0"] + .19, .95, 1.75
            api.curtain(w["s0"] + .01, at, w["s1"] - .01, at, y0, y1 - .02, .012, 8, NET)
            api.rod((w["s0"], y1, at), (w["s1"], y1, at), .008, BRASS, 6)
        else:
            at, y0, y1 = 5.73 - .19, .85, 1.55
            api.curtain(at, w["s0"] + .01, at, w["s1"] - .01, y0, y1 - .02, .012, 5, NET)
            api.rod((at, y1, w["s0"]), (at, y1, w["s1"]), .008, BRASS, 6)


def table(f, tu, tv, k):
    """A small café table: a square top of 0.60 m on a cast-iron column with a cross foot, a beer mat on it."""
    api = f.api
    api.box(tu, .71, tv, .6, .03, .6, WOOD, 0, "oak")
    api.box(tu, .69, tv, .2, .02, .2, IRON)
    api.rod((tu, .04, tv), (tu, .69, tv), .03, IRON, 8)
    api.beam((tu - .24, .02, tv), (tu + .24, .02, tv), .05, .04, IRON)
    api.beam((tu, .02, tv - .24), (tu, .02, tv + .24), .05, .04, IRON)
    f.mat(tu + .1, .74, tv + .05, k)
    f.solid(tu - .3, tv - .3, tu + .3, tv + .3, 0, .74)


def bar_room(f):
    api = f.api
    ue = 5.43
    # --- two wall tables against the east wall, four chairs each (two at each short end), a lamp over each ---
    for k, tv in enumerate((11.30, 13.85)):
        tu = (4.63 + ue - .02) / 2
        api.box(tu, .71, tv, ue - .02 - 4.63, .03, 1.2, WOOD, 0, "oak")
        api.box(tu, .63, tv, .5, .08, .9, DARK)
        for s in (-1, 1):
            api.rod((tu, .04, tv + s * .35), (tu, .63, tv + s * .35), .03, IRON, 8)
            api.beam((tu - .26, .02, tv + s * .35), (tu + .26, .02, tv + s * .35), .07, .04, IRON)
        f.solid(4.63, tv - .6, ue, tv + .6, 0, .74)
        for s in (-1, 1):
            for cu in (4.83, 5.21):
                f.chair(cu, tv + s * .76, 0, -s)
        f.mat(tu - .15, .74, tv - .3, k)
        f.mat(tu + .1, .74, tv + .35, k + 1)
        f.pendant(tu, tv, 1.95, .13)
    # --- the round regulars' table at the back, a brass bell in its middle, five chairs, its own lamp ---
    cu, cv = 3.95, 16.05
    api.lathe(cu, .715, cv, [(0, 0), (.475, 0), (.475, .035), (0, .035)], WOOD, 20)
    api.lathe(cu, .05, cv, [(.09, 0), (.06, .06), (.045, .2), (.07, .36), (.045, .52), (.06, .665)], DARK, 8)
    for k in range(3):
        t = math.pi / 2 + k * 2 * math.pi / 3
        api.beam((cu, .045, cv), (cu + .34 * math.cos(t), .025, cv + .34 * math.sin(t)), .06, .05, DARK)
    api.lathe(cu, .75, cv, [(0, 0), (.035, 0), (.03, .02), (.015, .045), (.006, .05), (0, .06)], BRASS, 8)
    f.solid(cu - .34, cv - .34, cu + .34, cv + .34, 0, .75)
    f.solid(cu - .475, cv - .2, cu + .475, cv + .2, 0, .75)
    f.solid(cu - .2, cv - .475, cu + .2, cv + .475, 0, .75)
    for k in range(5):
        t = math.pi / 2 + k * 2 * math.pi / 5
        f.chair(cu + .72 * math.cos(t), cv + .72 * math.sin(t), -math.cos(t), -math.sin(t))
    f.pendant(cu, cv, 1.85, .2)
    # --- the wall clock on the dividing wall (the bar room's side): ticks only, ten past ten ---
    wd, ku, ky = 7.67, 3.4, 2.05
    f.disc("v", wd, .05, ku, ky, .2, WOOD)
    f.disc("v", wd, .055, ku, ky, .17, FACE)
    for k in range(12):
        t = math.pi / 2 - k * math.pi / 6
        f.rect("v", wd, .059, ku + .152 * math.cos(t), ky + .152 * math.sin(t), .025, .014 if k % 3 == 0 else .007, t, IRON)
    for t, ln, w in ((math.radians(145), .09, .012), (math.radians(30), .135, .008)):
        f.rect("v", wd, .062 if ln < .1 else .065, ku + ln / 2 * math.cos(t), ky + ln / 2 * math.sin(t), ln, w, t, IRON)
    f.disc("v", wd, .068, ku, ky, .01, IRON, 8)
    # --- pictures: on the east wall between the windows, and on the partition ---
    f.framed("u", ue, -1, 11.3, 1.8, .7, .5, BANDS[1])
    f.framed("u", ue, -1, 12.58, 1.75, .4, .3)
    f.framed("u", 2.80, 1, 15.3, 1.68, .5, .4, BANDS[2])
    f.framed("u", 2.80, 1, 16.4, 1.65, .4, .3)
    # --- a shelf over them along the partition, five plain jugs and tankards ---
    api.box(2.89, 2.02, 15.8, .18, .03, 2.3, WOOD, 0, "oak")
    for v in (14.85, 16.75):
        api.box(2.83, 1.9, v, .06, .12, .03, WOOD, 0, "oak")
    jug = [(0, 0), (.06, 0), (.075, .08), (.05, .17), (.056, .2), (0, .2)]
    tankard = [(0, 0), (.045, 0), (.045, .12), (.04, .13), (0, .13)]
    for k, (v, shape, col) in enumerate(((14.95, jug, "#8a8f96"), (15.35, tankard, "#d8ccb0"), (15.8, jug, "#6a4a30"), (16.2, tankard, "#9a9a94"), (16.6, jug, "#d8ccb0"))):
        api.lathe(2.9, 2.05, v, shape, col, 6)
        hu = 2.9 + (.07 if shape is jug else .05)
        api.rod((hu, 2.05 + .05, v), (hu + .03, 2.05 + .1, v), .007, col, 6)


def toilets(f):
    """Each toilet: a bowl and its cistern against the back wall, a small basin on a side wall with a mirror over it, a
    paper holder, a coat hook by the door; bare bulbs; the corridors kept clear but for a picture, crates, a broom."""
    api = f.api
    vb = 17.13
    for cu, side, hook in ((2.125, 2.70, 1.615), (.875, .30, 1.385)):
        sign = -1 if side > 2 else 1  # out of the side wall, into the toilet
        api.box(cu, .4, vb - .09, .4, .4, .18, PORCELAIN)
        api.box(cu, .8, vb - .095, .43, .03, .2, PORCELAIN)
        api.box(cu + .12, .83, vb - .09, .05, .02, .03, NICKEL)  # the flush button
        api.lathe(cu, 0, vb - .37, [(.12, 0), (.1, .06), (.1, .22), (.18, .36), (.19, .39), (.13, .4), (0, .33)], PORCELAIN, 8)
        api.lathe(cu, 0, vb - .37, [(.19, .405), (.185, .42), (.13, .42), (.12, .41)], DARK, 8)
        u0, _, u1, _ = f.room(cu, 16.5)
        f.solid(u0, vb - .56, u1, vb + .01, 0, .83)  # wall to wall: no slot of 0.37 m beside the bowl
        bu = side + sign * .12
        api.lathe(bu, .72, 15.9, [(0, 0), (.08, 0), (.18, .1), (.2, .14), (.16, .15), (0, .11)], PORCELAIN, 8)
        api.rod((bu, 0, 15.9), (bu, .72, 15.9), .06, PORCELAIN, 10)
        api.rod((side, .92, 15.9), (side + sign * .1, .92, 15.9), .01, NICKEL, 6)
        api.rod((side + sign * .1, .92, 15.9), (side + sign * .1, .88, 15.9), .01, NICKEL, 6)
        # The basin's solid reaches the bowl's: the nook between them by the wall (0.47 m) would hold a player fast.
        f.solid(min(side, side + sign * .3), 15.7, max(side, side + sign * .3), vb - .56, 0, .86)
        api.box(side + sign * .015, 1.18, 15.9, .03, .5, .44, DARK)
        api.box(side + sign * .025, 1.21, 15.9, .03, .44, .38, MIRROR)
        api.box(side + sign * .02, .74, 16.55, .04, .04, .06, NICKEL)
        api.rod((side + sign * .08, .7, 16.48), (side + sign * .08, .7, 16.62), .05, WHITE, 10)
        api.rod((hook, 1.7, 14.7), (hook, 1.74, 14.76), .007, BRASS, 6)
        f.bulb(cu, 15.9)
    f.bulb(1.5, 12.5)
    f.bulb(1.5, 13.95)
    f.framed("v", 13.30, 1, 1.5, 1.78, .3, .25, BANDS[0])
    # The back corridor: two crates of plain bottles stacked against the partition at its back (out of the doors'
    # sweeps and the step's way), a broom in the corner.
    for k in range(2):
        api.box(1.4, k * .28, 13.05, .4, .27, .3, "#6e2a24")
    api.box(1.4, .54, 13.05, .36, .005, .26, "#3a1a16")
    for j in range(6):
        api.rod((1.27 + (j % 3) * .13, .45, 12.97 + (j // 3) * .16), (1.27 + (j % 3) * .13, .6, 12.97 + (j // 3) * .16), .012, BOTTLES[j % 2], 6)
    for k in range(2):
        api.box(1.4, .17 + k * .28, 12.9 - .002, .12, .04, .004, "#3a1a16")
    f.solid(1.2, 12.9, 1.6, 13.2, 0, .56)
    api.rod((2.55, .07, 13.12), (2.66, 1.35, 13.17), .012, "#a07a4a", 6)
    api.box(2.53, 0, 13.12, .3, .05, .06, "#5a3a22")
    api.box(2.53, .05, 13.12, .28, .03, .05, "#7a6a4a")


def fittings(api):
    f = Fit(api)
    counter(f)
    back_bar(f)
    front_room(f)
    bar_room(f)
    toilets(f)
