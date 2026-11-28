"""Hand-made houses among the generated ones, package B4: four houses across the open ground from the football ground's
portal, the row a player sees on arriving there.

  blender -b -P tools/village_houses_b4.py -- web/public/models [vh_solar_house vh_steep_gable ...]

writes web/public/models/<name>.glb for each house, or for the ones named, with the toolkit of the earlier packages
(tools/village_houses_kit.py; see tools/village_houses_b1.py for the names of the meshes and what the game does with
each). A house is named by its spot in the model's metres, never by an address. Its kind, colours and main openings
were compared with street-level pictures by eye; nothing was copied, traced or sampled from them, and nothing
personal is modelled (no number, name, text, sign, letterbox, car or window dressing). The portal looks at their
backs, so the backs carry as much as the fronts.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (Snapped, Opening, Roof, the details, the materials, ONLY)

House = Snapped  # noqa: F405  (the walls' ends drawn onto the outline's corners: village_houses_kit.py)


def over(ring, y, pad=.05):
    """The height of a flat roof over a plan ring, for top_over's `also`: y in the ring or within `pad` of its edges."""
    def f(u, d):
        if inside(ring, (u, d)):  # noqa: F405
            return y
        for a, b in zip(ring, ring[1:] + ring[:1]):
            t = Vector((b[0] - a[0], b[1] - a[1]))  # noqa: F405
            s = max(0, min(1, ((u - a[0]) * t.x + (d - a[1]) * t.y) / (t.length_squared or 1)))
            if math.dist((u, d), (a[0] + t.x * s, a[1] + t.y * s)) < pad:  # noqa: F405
                return y
        return -99
    return f


def flat_roof(h, ring, y, coping="#a5a29b", top="#3a3a3a"):
    """A flat roof over a plan ring at height y: its top (vh_stone takes the snow) and a coping along every edge."""
    h.poly("vh_stone", [(u, d, y - .02) for u, d in ring], (0, 0, 1), top)
    for a, b in zip(ring, ring[1:] + ring[:1]):
        h.seg("vh_stone", a, b, .28, y, y + .07, coping)


def solar(h, pl, u0, u1, d0, d1, nu, nd, cell="#1c2330", rim="#8d9296", lift=.12):
    """Solar panels on a roof plane `pl`: nu by nd panels over the plan rectangle, on a rail a little over the tiles."""
    y = lambda u, d, e=0.0: at(pl, u, d) + lift + e  # noqa: F405
    up = (-pl[1], -pl[2], 1)
    ring = [(u0, d0), (u1, d0), (u1, d1), (u0, d1)]
    h.poly("vh_solar", [(u, d, y(u, d, -.015)) for u, d in ring], up, rim)
    for (ua, da), (ub, db) in zip(ring, ring[1:] + ring[:1]):  # the edge, down to the tiles
        mid = ((ua + ub) / 2 - (u0 + u1) / 2, (da + db) / 2 - (d0 + d1) / 2, 0)
        h.poly("vh_solar", [(ua, da, y(ua, da, -.015)), (ub, db, y(ub, db, -.015)), (ub, db, at(pl, ub, db)), (ua, da, at(pl, ua, da))], mid, rim)  # noqa: F405
    du, dd, g = (u1 - u0) / nu, (d1 - d0) / nd, .025
    for i in range(nu):
        for j in range(nd):
            a, b, c, e = u0 + du * i + g, u0 + du * (i + 1) - g, d0 + dd * j + g, d0 + dd * (j + 1) - g
            h.poly("vh_solar", [(a, c, y(a, c)), (b, c, y(b, c)), (b, e, y(b, e)), (a, e, y(a, e))], up, cell)


def skylight(h, pl, u, d, w, l, frame="#3b3d3e"):
    """A roof window lying in the slope: a dark pane in a frame a little proud of the tiles."""
    up = (-pl[1], -pl[2], 1)
    for m, k, c, e in (("vh_solar", 0, frame, .05), ("vh_solar", .06, "#27303a", .065)):
        ring = [(u - w / 2 + k, d - l / 2 + k), (u + w / 2 - k, d - l / 2 + k), (u + w / 2 - k, d + l / 2 - k), (u - w / 2 + k, d + l / 2 - k)]
        h.poly(m, [(p, q, at(pl, p, q) + e) for p, q in ring], up, c)  # noqa: F405


SOLAR = {"tint": "#ffffff", "rough": .3, "metal": .3}


# ======================================================================================================================
# 13. x -200.2, z -1194.5: a modern house of pale buff brick, two storeys under a low hipped roof of dark tiles with
# solar panels on its street side, a flat-roofed single storey in front with a grey garage door and the entrance in
# a wall of dark slate, a flat-roofed garden room at the back with wide glazing; dark frames throughout.
def solar_house():
    h = House("vh_solar_house", [-203.16, -1188.09], ([-191.85, -1195.12], [-193.14, -1202.08]), -5.11, {
        "vh_brick": {"texture": "nb_brick", "tint": "#d9ccb4", "normalScale": .45},  # paler than nb_yellow's range
        "vh_roof": {"texture": "roof_tiles", "tint": "#3a3c40", "normalScale": .3},
        "vh_slate": {"texture": "roof_tiles", "tint": "#7a7d80", "normalScale": .7},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
        "vh_solar": SOLAR,
    })
    # u along the street front to the south (toward the steep gable next door), d from the garage's front (0) back.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    dark, coping, under = "#2f3133", "#bdb7aa", "#dcd8cf"
    E, FL, ov, k = 6.3 + lift, 3.15 + lift, .55, .5
    u0, d0, d1 = -8.42, 2.8, 12.4
    u1 = lambda d: 3.54 - .05 * d / 17.89  # the east side runs straight from the front to the back
    U1 = u1(7.6)
    Ee = E - k * ov
    main = Roof([(u0 - ov, d0 - ov), (U1 + ov, d0 - ov), (U1 + ov, d1 + ov), (u0 - ov, d1 + ov)],
                [eave((0, d0 - ov), (0, 1), Ee, k), eave((0, d1 + ov), (0, -1), Ee, k),  # noqa: F405
                 eave((u0 - ov, 0), (1, 0), Ee, k), eave((U1 + ov, 0), (-1, 0), Ee, k)], under=under, edge=dark, board=.34)  # noqa: F405
    roofs = [main]
    front = [(-3.54, 0), (3.54, 0), (u1(2.8), 2.8), (-3.52, 2.77)]
    back = [(-1.93, 12.38), (u1(12.4), 12.4), (3.49, 17.89), (-2.02, 17.89)]
    g0 = gy(0, -.3)
    fl = g0 + .15
    fu = fl + 3.0  # the upper floor
    foot = [(g0 + .12, "vh_trim", "#55575a")]
    win = lambda s, y, w, hh, cols=1: Opening(s, y, w, hh, frame=dark, reveal=.2, cols=cols, sill=False)

    def wall(a, b, ops=(), top=None, **kw):
        return h.wall(a, b, top if top is not None else top_over(roofs, a, b), ops, bands=kw.pop("bands", foot), **kw)  # noqa: F405

    # --- the front: the garage and the entrance in its wall of slate, the upper floor set back over it ---------------
    door = Opening(1.25, fl, 1.0, 2.3, "door", door=dark, frame=dark, panels="glazed", reveal=.25, sill=False)
    garage = Opening(4.85, gy(1.3, -.2) + .02, 3.0, 2.3, "garage", door="#6e7174", reveal=.2, sill=False)
    W, N, T = wall((-3.54, 0), (3.54, 0), [door, garage], top=FL - .02)
    top = FL - .3
    for s0, s1, y0, y1 in ((0, door.s - .5, g0 - .05, top), (door.s + .5, 2.6, g0 - .05, top), (door.s - .5, door.s + .5, fl + 2.3, top)):
        h.wbox(W, N, T, "vh_slate", s0, s1, y0, y1, -.05, 0)
    h.wbox(W, N, T, "vh_trim", -.05, 2.65, top, top + .06, -.07, 0, dark)
    wall((-3.52, 2.77), (-3.54, 0), top=FL - .02)
    wall((-3.52, 2.77), (u1(2.8), 2.8), [win(3.5, fu + .3, 2.6, 1.6, 2)], bottom=FL - .1, out=(0, -1), bands=())
    # The main front beside the garage: a tall window from the floor, a wide one over it.
    wall((-3.52, 2.77), (-8.42, 2.84), [win(2.9, fl, 2.6, 2.4, 2), win(2.45, fu + .3, 3.4, 1.6, 2)])
    # --- the north end and the back -----------------------------------------------------------------------------
    wall((-8.42, 2.84), (-8.39, 12.4), [win(2.4, fl + .9, 1.2, 1.4), win(6.8, fl + .9, 2.4, 1.4, 2), win(2.4, fu + .4, 1.2, 1.4), win(6.8, fu + .4, 1.8, 1.4, 2)])
    wall((-8.39, 12.4), (-1.93, 12.38), [win(3.1, fl, 3.4, 2.3, 3), win(1.9, fu + .3, 1.4, 1.5), win(4.6, fu + .3, 1.4, 1.5)])
    wall((-1.93, 12.38), (u1(12.4), 12.4), [win(2.7, fu + .3, 2.6, 1.5, 2)], bottom=FL - .1, out=(0, 1), bands=())
    # The garden room: a row of sliding doors to the garden, a narrow window to the side.
    wall((-1.93, 12.38), (-2.02, 17.89), [win(3.2, fl + .9, 1.0, 1.4)], top=FL - .02)
    wall((-2.02, 17.89), (3.49, 17.89), [win(2.75, fl, 4.6, 2.3, 4)], top=FL - .02)
    # --- the south side, along the next house: the garden room, the main block, the garage -------------------------
    wall((3.49, 17.89), (u1(12.4), 12.4), [win(2.8, fl + .9, 1.2, 1.4)], top=FL - .02)
    wall((u1(12.4), 12.4), (u1(2.8), 2.8), [win(2.2, fl + .9, 1.0, 1.4), win(6.4, fl + .9, 1.0, 1.4), win(4.3, fu + .4, 1.2, 1.4), win(7.6, fu + .4, .8, 1.4)])
    wall((u1(2.8), 2.8), (3.54, 0), top=FL - .02)
    flat_roof(h, front, FL, coping, "#4a4a4a")
    flat_roof(h, back, FL, coping, "#4a4a4a")
    draw_roofs(h, roofs)  # noqa: F405
    ye = Ee - .3
    h.gutter((u0 - ov, d0 - ov, ye), (U1 + ov, d0 - ov, ye), (0, -1, 0), dark, down=[(u0 - .08, 2.95, gy(u0 - .08, 2.95))])
    h.gutter((U1 + ov, d1 + ov, ye), (u0 - ov, d1 + ov, ye), (0, 1, 0), dark, down=[(u0 - .08, 12.25, gy(u0 - .08, 12.25))])
    # The panels: two rows over the street side's slope, clear of its hips (its plane narrows by a metre a metre up).
    pl = main.planes[0]
    solar(h, pl, -5.0, .1, d0 - .3, d0 + 3.2, 5, 2)
    h.rod("vh_metal_small", (-2.0, 9.6, main.height(-2.0, 9.6) - .2), (-2.0, 9.6, main.height(-2.0, 9.6) + .9), .08, 8, "#a9adb0")
    h.export()


# ======================================================================================================================
# 14. x -201.2, z -1213.3: a red brick house of the 1990s, one storey and a room in its steep roof of dark tiles, its
# gable to the street with a brick chimney at its top, roof windows in its slopes, a flat-roofed garage at its side.
def steep_gable():
    h = House("vh_steep_gable", [-209.82, -1216.24], ([-194.32, -1209.01], [-195.45, -1215.38]), -5.04, {
        "vh_brick": {"texture": "nb_brick", "tint": "#8c5442", "normalScale": .55},  # in nb_red's range
        "vh_roof": {"texture": "roof_tiles", "tint": "#3b3e43", "normalScale": .3},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
        "vh_solar": SOLAR,
    })
    # u along the street gable to the south (away from the modern house), d from the gable (0) to the back (14).
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, foot_c = "#f0efea", "#6d6a66"
    E, ov, vg = 3.72 + lift, .3, .25
    uw, ue, D = -3.24, 3.25, 14.0
    k = 4.8 / ((ue - uw) / 2)  # the ridge 4.8 m over the eaves, as the data's roof
    main = Roof([(uw - ov, -vg), (ue + ov, -vg), (ue + ov, D + vg), (uw - ov, D + vg)],
                [eave((uw - ov, 0), (1, 0), E - k * ov, k), eave((ue + ov, 0), (-1, 0), E - k * ov, k)],  # noqa: F405
                under=white, edge=white, board=.26)
    roofs = [main]
    WF = 2.9 + lift
    side = [(ue, 3.95), (6.74, 3.99), (6.59, 14.0), (ue, 14.0)]
    flat_at = over(side, WF + .07)
    g0 = gy(0, -.3)
    fl = g0 + .15
    fu = fl + 2.75
    foot = [(g0 + .35, "vh_trim", foot_c)]
    win = lambda s, y, w, hh, cols=1: Opening(s, y, w, hh, frame=white, reveal=.16, cols=cols)

    def wall(a, b, ops=(), top=None, **kw):
        return h.wall(a, b, top if top is not None else top_over(roofs, a, b, also=[flat_at]), ops, bands=kw.pop("bands", foot), **kw)  # noqa: F405

    # --- the street gable: a window and the door below, a window in the roof's room, a small one high up ----------
    door = Opening(4.75, fl, 1.0, 2.15, "door", door="#5b4033", frame=white, panels="glazed", reveal=.18, sill=False, step=(g0, .3))
    W, N, T = wall((-3.23, 0), (3.23, 0), [win(1.75, fl + .8, 1.8, 1.4, 2), door, win(3.23, fu + .45, 1.3, 1.3, 2), win(3.23, fu + 2.45, .6, .75)])
    shutter_box(h, W, N, T, Opening(1.75, fl + .8, 1.8, 1.4, reveal=.16))  # noqa: F405
    wall((3.23, 0), (3.26, 3.95), [win(2.0, fl + .9, .9, 1.2)])
    # --- the garage beside it, set back, under a flat roof ---------------------------------------------------------
    wall((3.26, 3.95), (6.74, 3.99), [Opening(1.75, gy(5.0, 3.7) + .02, 2.5, 2.15, "garage", door="#e8e7e2", reveal=.14, sill=False)], top=WF - .02)
    wall((6.74, 3.99), (6.59, 14.0), [win(6.5, fl + .9, .9, .9)], top=WF - .02)
    h.wall((3.26, 3.95), (ue, 14.0), top_over(roofs, (3.26, 3.95), (ue, 14.0)), bottom=WF - .1, out=(1, 0))
    flat_roof(h, side, WF, "#9b978f")
    # --- the back, toward the football ground: the garden door and a wide window, the roof's room over them -------
    wall((6.59, 14.0), (-3.24, 13.96), [win(1.65, fl + .9, 1.0, 1.0), Opening(4.9, fl, 1.0, 2.15, "door", door=white, frame=white, panels="glazed", reveal=.16, sill=False),
                                         win(7.4, fl + .6, 2.4, 1.6, 3), win(6.6, fu + .45, 1.3, 1.3, 2), win(6.6, fu + 2.45, .6, .75)])
    # --- the north side, toward the modern house: windows under the eaves; the roof windows over them --------------
    wall((-3.24, 13.96), (-3.23, 0), [win(2.6, fl + .8, 1.2, 1.3, 2), win(7.0, fl + .8, 1.2, 1.3, 2), win(11.2, fl + .8, 1.2, 1.3, 2)])
    draw_roofs(h, roofs)  # noqa: F405
    ye = E - k * ov - .3
    h.gutter((uw - ov, -vg, ye), (uw - ov, D + vg, ye), (-1, 0, 0), "#74706a", down=[(uw - .08, .2, gy(uw, .2)), (uw - .08, 13.8, gy(uw, 13.8))])
    h.gutter((ue + ov, -vg, ye), (ue + ov, 3.7, ye), (1, 0, 0), "#74706a")
    for d in (3.6, 9.4):
        skylight(h, main.planes[0], -1.55, d, .78, 1.15)
    skylight(h, main.planes[1], 1.55, 9.4, .78, 1.15)
    # The chimney at the street gable's top, a little behind the verge.
    h.chimney(0, .7, .55, .7, main.height(0, .7) - .5, main.height(0, .7) + 1.0, "vh_brick", pots=[(0, 0)])
    h.export()


# ======================================================================================================================
# 15. x -191.4, z -1164.7: a white bungalow of the 1970s, a low plinth of grey, a hipped roof of dark tiles over an
# L-shaped plan, wide windows of three lights on its front, a rendered chimney.
def hip_bungalow():
    h = House("vh_hip_bungalow", [-199.86, -1157.99], ([-183.22, -1162.78], [-190.2, -1170.94]), -4.57, {
        "vh_render": {"texture": "plaster", "tint": "#eeebe4", "normalScale": .35},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3c3e42", "normalScale": .3},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
    })
    # u along the front to the south-east (left to right seen from the street), d from the front (0) to the back.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    white, frame, plinth = "#f1f0eb", "#dcdcd7", "#6e6c68"
    E, ov, k = 2.95 + lift, .5, .6
    uw, ue, um, dm, dw = -5.37, 10.22, 1.82, 8.87, 15.78  # the outline's west and east ends, the wing's west side, the backs
    Ee = E - k * ov
    # The main roof over the front part and the wing's roof over the east part meet as one L-shaped hipped roof: the
    # main roof stops where its ridge meets the wing's east slope, and the wing's planes lie a centimetre under the
    # main's where both cover the same ground (its front and its east), so each slope is drawn once.
    main = Roof([(uw - ov, -ov), (5.78, -ov), (5.78, dm + ov), (uw - ov, dm + ov)],
                [eave((0, -ov), (0, 1), Ee, k), eave((0, dm + ov), (0, -1), Ee, k), eave((uw - ov, 0), (1, 0), Ee, k)],  # noqa: F405
                under=white, edge=white, board=.26)
    wing = Roof([(um - ov, -ov), (ue + ov, -ov), (ue + ov, dw + ov), (um - ov, dw + ov)],
                [eave((0, -ov), (0, 1), Ee - .01, k), eave((um - ov, 0), (1, 0), Ee - .01, k),  # noqa: F405
                 eave((ue + ov, 0), (-1, 0), Ee - .01, k), eave((0, dw + ov), (0, -1), Ee - .01, k)], under=white, edge=white, board=.26)  # noqa: F405
    roofs = [main, wing]
    g0 = gy(2.0, -.3)
    fl = g0 + .25
    foot = [(g0 + .4, "vh_trim", plinth)]
    win = lambda s, w, hh=1.35, cols=None: Opening(s, fl + .75, w, hh, frame=frame, reveal=.14, cols=cols or (3 if w > 2 else 2 if w > 1.1 else 1))

    def wall(a, b, ops=(), **kw):
        return h.wall(a, b, top_over(roofs, a, b), ops, mesh="vh_render", bands=foot, **kw)  # noqa: F405

    # --- the front: a wide window, the door with a narrow light beside it, a second window; a wide one at the end ----
    door = Opening(7.9, fl, 1.0, 2.1, "door", door="#c9c4b8", frame=frame, panels="glazed", reveal=.14, sill=False, step=(g0, .45))
    wall((-5.37, 0), (-5.05, -.02))
    wall((-5.05, -.02), (-5.02, .42))
    wall((-5.02, .42), (5.37, .45), [win(2.3, 2.4), win(6.6, 1.0), door])
    wall((5.37, .45), (5.37, 0))
    wall((5.37, 0), (10.17, -.02), [win(2.5, 2.4)])
    # --- the west end and the back of the front part, the wing's sides and back -------------------------------------
    wall((-5.32, 8.88), (-5.37, 0), [win(2.6, 1.2), win(6.2, 1.2)])
    wall((1.82, 8.85), (-5.32, 8.88), [win(2.2, 1.8), Opening(5.0, fl, .95, 2.1, "door", door=white, frame=frame, panels="glazed", reveal=.14, sill=False, step=(gy(-1.6, 9.2), .35))])
    wall((1.81, 15.76), (1.82, 8.85), [win(2.4, 1.2), win(5.0, 1.8)])
    wall((10.22, 15.79), (1.81, 15.76), [win(2.4, 1.2), win(6.0, 2.4)])
    wall((10.17, -.02), (10.22, 15.79), [win(3.0, 1.2), win(8.0, 1.8), win(12.6, 1.2, 1.1)])
    draw_roofs(h, roofs)  # noqa: F405
    ye = Ee - .28
    h.gutter((uw - ov, -ov, ye), (ue + ov, -ov, ye), (0, -1, 0), white, down=[(uw + .1, -.08, gy(uw, -.08)), (10.1, -.08, gy(10.1, -.08))])
    h.gutter((um - ov, dm + ov, ye), (uw - ov, dm + ov, ye), (0, 1, 0), white, down=[(-5.2, 8.95, gy(-5.2, 8.95))])
    h.gutter((ue + ov, dw + ov, ye), (um - ov, dw + ov, ye), (0, 1, 0), white, down=[(10.1, 15.87, gy(10.1, 15.87))])
    h.chimney(-2.8, 3.6, .6, .6, main.height(-2.8, 3.6) - .4, main.height(-2.8, 3.6) + .9, "vh_render", cap="#8f8c86")
    h.export()


# ======================================================================================================================
# 16. x -147.0, z -1157.3: a tall house of rosy red brick, two storeys and a steep roof of dark tiles with its gable
# ends clipped, solar panels on its street side and a chimney at its west end, a steep front gable over a bay with
# a tall window framed in grey-green boards, a lower wing of dark brick at the back under a flat roof.
def tall_gable():
    h = House("vh_tall_gable", [-145.16, -1166.79], ([-136.72, -1159.07], [-141.94, -1163.32]), -4.58, {
        "vh_brick": {"texture": "nb_brick", "tint": "#b6846f", "normalScale": .55},
        "vh_dark": {"texture": "nb_brick", "tint": "#5c4a42", "normalScale": .55},
        "vh_roof": {"texture": "roof_tiles", "tint": "#3a3d41", "normalScale": .3},
        "vh_clad": {"texture": "cladding", "tint": "#b9c6b6", "stretch": (4, 1), "normalScale": .8},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
        "vh_solar": SOLAR,
    })
    # u along the street front to the east (the clipped gable seen across the field at u 8), d from the front back.
    lift = h.base
    gy = lambda u, d: h.ground(u, d)
    dark, zinc = "#3a3c3e", "#8e9295"
    E, ov, vg, k, kh = 5.8 + lift, .35, .3, 1.1, 2.2
    uw, ue, D = -3.37, 8.06, 10.46
    Ee = E - k * ov
    RG = E + k * D / 2
    Hc = RG - 1.7  # the gables' clipped tops begin here
    main = Roof([(uw - vg, -ov), (ue + vg, -ov), (ue + vg, D + ov), (uw - vg, D + ov)],
                [eave((0, -ov), (0, 1), Ee, k), eave((0, D + ov), (0, -1), Ee, k),  # noqa: F405
                 eave((uw - vg, 0), (1, 0), Hc, kh), eave((ue + vg, 0), (-1, 0), Hc, kh)], under="#d6d2c9", edge=dark, board=.26)  # noqa: F405
    # The front gable over the bay: steep, its ridge toward the street, running into the main roof.
    bu0, bu1, bd = 3.36, 8.05, -.65
    kc = 1.45
    cross = Roof([(bu0 - .25, bd - .3), (bu1 + .25, bd - .3), (bu1 + .25, 4.2), (bu0 - .25, 4.2)],
                 [eave((bu0 - .25, 0), (1, 0), E - kc * .25, kc), eave((bu1 + .25, 0), (-1, 0), E - kc * .25, kc)],  # noqa: F405
                 under="#d6d2c9", edge=dark, board=.22)
    roofs = [main, cross]
    WF = 3.1 + lift
    wing = [(1.43, 10.46), (8.06, 10.46), (8.06, 10.81), (8.66, 10.81), (8.66, 15.07), (2.98, 15.07), (2.98, 11.56), (1.43, 11.56)]
    flat_at = over(wing, WF + .07)
    g0 = gy(0, -.3)
    fl = g0 + .2
    fu = fl + 2.85
    foot = [(g0 + .3, "vh_trim", "#5f5b57")]
    win = lambda s, y, w, hh, cols=1: Opening(s, y, w, hh, frame=dark, reveal=.18, cols=cols)

    def wall(a, b, ops=(), top=None, **kw):
        return h.wall(a, b, top if top is not None else top_over(roofs, a, b, also=[flat_at]), ops, bands=kw.pop("bands", foot), **kw)  # noqa: F405

    # --- the street front: windows and the door, two windows over them; the bay under its gable ---------------------
    door = Opening(4.75, fl, 1.0, 2.2, "door", door=dark, frame=dark, panels="glazed", reveal=.2, sill=False, step=(g0, .35))
    wall((-3.37, 0), (3.37, 0), [win(1.6, fl + .8, 1.2, 1.4, 2), door, win(1.6, fu + .55, 1.0, 1.35, 2), win(4.75, fu + .55, 1.0, 1.35, 2)])
    wall((3.37, 0), (3.36, -.65))
    up = win(2.35, fu + .45, 1.3, 1.9, 2)
    W, N, T = wall((3.36, -.65), (8.05, -.66), [win(2.35, fl + .8, 1.8, 1.4, 2), up])
    h.wbox(W, N, T, "vh_clad", up.s - 1.0, up.s + 1.0, fl + 2.45, up.y + up.h + .35, -.06, 0)  # the boards round the tall window
    # --- the clipped gable to the east, seen across the field --------------------------------------------------------
    wall((8.05, -.66), (8.06, 10.81), [win(2.4, fl + .8, 1.2, 1.4, 2), win(7.6, fl + .8, 1.2, 1.4, 2), win(3.4, fu + .55, 1.0, 1.35, 2),
                                       win(7.6, fu + .55, 1.0, 1.35, 2), win(5.9, E + 1.6, .8, 1.1)])
    # --- the wing at the back: dark brick, a wide window to the garden ----------------------------------------------
    dwall = lambda a, b, ops=(): h.wall(a, b, WF - .02, ops, mesh="vh_dark", bands=foot)
    dwall((8.06, 10.81), (8.66, 10.81))
    dwall((8.66, 10.81), (8.66, 15.07), [win(2.2, fl + .9, 1.2, 1.3)])
    dwall((8.66, 15.07), (2.98, 15.07), [win(2.9, fl, 3.6, 2.2, 3)])
    dwall((2.98, 15.07), (2.98, 11.56))
    dwall((2.98, 11.56), (1.43, 11.56), [Opening(.78, fl, .9, 2.1, "door", door=dark, frame=dark, panels="glazed", reveal=.16, sill=False)])
    dwall((1.43, 11.56), (1.43, 10.46))
    flat_roof(h, wing, WF, "#77736d")
    # --- the back over the wing and beside it, the west gable with the chimney --------------------------------------
    h.wall((1.43, D), (8.06, D), top_over(roofs, (1.43, D), (8.06, D)), [win(2.4, fu + .55, 1.0, 1.35, 2), win(5.2, fu + .55, 1.0, 1.35, 2)], bottom=WF - .1, out=(0, 1))
    wall((1.43, D), (-3.36, 10.45), [win(2.6, fl + .8, 1.6, 1.4, 2), win(2.6, fu + .55, 1.0, 1.35, 2)])
    wall((-3.36, 10.45), (-3.37, 0), [win(3.0, fl + .8, 1.0, 1.4), win(7.4, fu + .55, 1.0, 1.35, 2), win(5.2, E + 1.6, .8, 1.1)])
    draw_roofs(h, roofs)  # noqa: F405
    ye = Ee - .3
    h.gutter((uw - vg, -ov, ye), (bu0 - .25, -ov, ye), (0, -1, 0), zinc, down=[(uw + .1, -.08, gy(uw, -.08))])
    h.gutter((ue + vg, D + ov, ye), (uw - vg, D + ov, ye), (0, 1, 0), zinc, down=[(-3.25, 10.55, gy(-3.25, 10.55))])
    h.gutter((ue + vg, bd - .3, E - .3), (ue + vg, -ov, E - .3), (1, 0, 0), zinc)
    # The panels: two rows on the street side's slope, between the clipped gable's top and the front gable.
    solar(h, main.planes[0], uw + .4, bu0 - .55, .2, 3.6, 5, 2)
    h.chimney(uw + .75, D / 2, .6, .75, RG - 1.2, RG + .9, "vh_brick", pots=[(0, 0)])
    h.export()


HOUSES = {"vh_solar_house": solar_house, "vh_steep_gable": steep_gable, "vh_hip_bungalow": hip_bungalow, "vh_tall_gable": tall_gable}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:  # noqa: F405
        _build()
