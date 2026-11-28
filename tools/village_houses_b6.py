"""Hand-made houses among the generated ones, package B6: the house just north of the church, on the street behind it.

  blender -b -P tools/village_houses_b6.py -- web/public/models [vh_pale_hip]

writes web/public/models/<name>.glb for each house, or for the ones named, with the toolkit of the earlier packages
(tools/village_houses_kit.py; see tools/village_houses_b1.py for the names of the meshes and what the game does with
each). A house is named by its spot in the model's metres, never by an address. Its kind, colours and main openings
were compared with street-level pictures and views from above by eye; nothing was copied, traced or sampled from them,
and nothing personal is modelled (no number, name, text, sign, letterbox, car, plant or window dressing).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from village_houses_kit import *  # noqa: E402,F403  (Snapped, Opening, Roof, the details, the materials, ONLY)

House = Snapped  # noqa: F405  (the walls' ends drawn onto the outline's corners: village_houses_kit.py)


def flat_door(h, W, N, T, o, color, handle="#b9bcbe"):
    """A flat door leaf in an opening of no kind of its own (kind "leaf"), with a long upright bar for a handle."""
    s0, s1, y0, y1, r = o.s - o.w / 2, o.s + o.w / 2, o.y, o.y + o.h, o.reveal
    h.wbox(W, N, T, "vh_trim", s0, s1, y0, y1, r - .05, r, color)
    h.wbox(W, N, T, "vh_metal_small", s1 - .2, s1 - .16, y0 + .7, y0 + 1.7, r - .12, r - .05, handle)


# ======================================================================================================================
# 23. x 506.9, z -724.8: a modern house of pale grey-white brick, two storeys under a hipped roof of dark grey tiles with
# deep eaves and a soffit of warm wood; its front to the street: two tall windows over two glass doors, the entrance in a
# recessed band of darker brick with a glazed strip up both floors, a part beside it with low wide windows; a lower wing
# under its own hipped roof with a wide garage door and a band of high windows; a steel flue; dark tiles in front.
def pale_hip():
    h = House("vh_pale_hip", [514.22, -716.62], ([514.22, -716.62], [517.2, -726.04]), 6.363, {
        "vh_brick": {"texture": "nb_brick", "tint": "#dedad2", "normalScale": .45},
        "vh_dark": {"texture": "nb_brick", "tint": "#8c8984", "normalScale": .5},
        "vh_roof": {"texture": "roof_tiles", "tint": "#45474c", "normalScale": .3},
        "vh_paving": {"texture": "pavers", "tint": "#606368"},
        "vh_trim": TRIM, "vh_stone": STONE, "vh_glass": GLASS, "vh_frames_small": SMALL, "vh_metal_small": METAL,  # noqa: F405
    })
    # u along the house's west end to the south (the street at u -7.7, the front at u -5), d from the west end (0) east
    # toward the wing (16.9).
    gy = lambda u, d: h.ground(u, d)
    dark, wood, zinc = "#3a3c3f", "#a37d5c", "#9a9ea1"
    g0 = gy(-5.3, 4.5)
    fl = g0 + .15
    fu = fl + 3.0
    # The house: two storeys under a hipped roof (eaves 6.2 m, a short ridge), its eaves deep over a wooden soffit.
    uw, ue, DE = -5.06, 4.94, 9.2
    E, ov, k = g0 + 6.2, .8, .59
    main = Roof([(uw - ov, -ov), (ue + ov, -ov), (ue + ov, DE + ov), (uw - ov, DE + ov)],
                [eave((uw - ov, 0), (1, 0), E - k * ov, k), eave((ue + ov, 0), (-1, 0), E - k * ov, k),  # noqa: F405
                 eave((0, -ov), (0, 1), E - k * ov, k), eave((0, DE + ov), (0, -1), E - k * ov, k)], under=wood, edge=wood, board=.24)  # noqa: F405
    # The wing: one high storey, its hipped roof low and leaning into the house's east wall.
    ua0, ua1, da0, da1 = -2.18, 4.73, 9.3, 16.85
    EA, ova, ka = g0 + 4.7, .6, .36
    wing = Roof([(ua0 - ova, da0), (ua1 + ova, da0), (ua1 + ova, da1 + ova), (ua0 - ova, da1 + ova)],
                [eave((ua0 - ova, 0), (1, 0), EA - ka * ova, ka), eave((ua1 + ova, 0), (-1, 0), EA - ka * ova, ka),  # noqa: F405
                 eave((0, da1 + ova), (0, -1), EA - ka * ova, ka)], under=wood, edge=wood, board=.22)  # noqa: F405
    roofs = [main, wing]
    foot = [(g0 + .45, "vh_dark", None)]  # a plinth of darker brick
    win = lambda s, y, w, hh, cols=1, **kw: Opening(s, y, w, hh, frame=dark, reveal=.18, cols=cols, **kw)

    def wall(a, b, ops=(), mesh="vh_brick", **kw):
        return h.wall(a, b, top_over(roofs, a, b), ops, mesh=mesh, bands=kw.pop("bands", foot), **kw)  # noqa: F405

    # --- the street front: the west part with two tall windows over two glass doors ---------------------------------
    line = lambda d, off=0: (round(-4.94 - .01336 * d + off, 3), d)  # the front's line on the outline, `off` in
    wall(line(0), line(4.0), [win(1.05, fl, .95, 2.45, sill=False, transom=.72), win(2.95, fl, .95, 2.45, sill=False, transom=.72),
                              win(1.05, fu + .35, .95, 1.6), win(2.95, fu + .35, .95, 1.6)])
    # --- the entrance: 15 cm back, darker brick, a glazed strip up both floors, the tall door under glass ------------
    R = .15
    wall(line(4.0), line(4.0, R), out=(0, 1))
    W, N, T = wall(line(4.0, R), line(5.6, R), [win(.3, fl, .4, E - .3 - fl, sill=False), win(1.05, fl + 2.6, 1.0, E - .3 - fl - 2.6, sill=False),
                                                Opening(1.05, fl, 1.0, 2.5, "leaf", frame=dark, reveal=.12, sill=False)], mesh="vh_dark", bands=())
    strip, over, leaf = Opening(.3, fl, .4, E - .3 - fl, frame=dark, reveal=.18), Opening(1.05, fl + 2.6, 1.0, E - .3 - fl - 2.6, frame=dark, reveal=.18), \
        Opening(1.05, fl, 1.0, 2.5, reveal=.12)
    muntins(h, W, N, T, strip, rows=7, cols=1)  # noqa: F405
    muntins(h, W, N, T, over, rows=4, cols=1)  # noqa: F405
    flat_door(h, W, N, T, leaf, dark)
    h.wbox(W, N, T, "vh_frames_small", .5, .6, fl, E - .3, .1, .18, dark)  # the post between the strip and the door
    wall(line(5.6, R), line(5.6), out=(0, -1))
    # --- the part beside the entrance: a wide low window on each floor ------------------------------------------------
    wall(line(5.6), (-5.06, 8.98), [win(1.75, fl + 1.35, 2.2, .7, 2), win(1.75, fu + 1.35, 2.2, .8, 2)])
    # --- the house's other sides: its west end, the garden, its east end over the wing ------------------------------
    wall((4.94, 0), (-4.94, 0), [win(2.4, fl + .85, 1.2, 1.4), win(2.4, fu + .35, 1.0, 1.4), win(7.3, fl + .85, .9, 1.4), win(7.3, fu + .35, .9, 1.4)])
    wall((4.94, 0), (4.93, 9.44), [win(3.0, fl, 3.0, 2.45, 3, sill=False), win(7.4, fl + .85, 1.4, 1.4, 2),
                                   win(1.8, fu + .35, 1.0, 1.5), win(4.6, fu + .35, 1.0, 1.5), win(7.6, fu + .35, 1.0, 1.5)])
    wall((4.93, 9.44), (2.69, 9.54))
    wall((2.69, 9.54), (-1.45, 9.02), [win(2.2, fu + .45, .9, 1.2)], out=(0, 1))
    wall((-1.45, 9.02), (-5.06, 8.98), [win(1.8, fu + .35, .9, 1.4)])
    # --- the link to the wing: darker brick, set back -------------------------------------------------------------
    wall((-1.45, 9.02), (-1.48, 10.77), mesh="vh_dark", bands=())
    wall((-1.48, 10.77), (-2.09, 10.76))
    # --- the wing: the wide garage door to the street, a band of high windows over it; a door and windows behind ----
    wall((-2.09, 10.76), (-2.18, 16.77), [Opening(2.9, gy(-2.4, 13.6) + .02, 3.8, 2.3, "garage", door=dark, reveal=.16, sill=False),
                                          win(1.6, fl + 3.45, 2.3, .75), win(4.25, fl + 3.45, 2.3, .75)])
    wall((-2.18, 16.77), (4.73, 16.89), [win(2.2, fl + .9, 1.0, 1.3), Opening(5.0, fl, 1.0, 2.2, "door", door=dark, frame=dark, panels="glazed", reveal=.16, sill=False)])
    wall((4.73, 16.89), (4.72, 10.24), [win(3.3, fl + .5, 3.0, 1.8, 3)])
    wall((4.72, 10.24), (2.71, 10.32))
    wall((2.71, 10.32), (2.69, 9.54))
    draw_roofs(h, roofs)  # noqa: F405
    # --- gutters, downpipes, the flue -------------------------------------------------------------------------------
    ye = E - k * ov - .26
    gd = lambda u, d: (u, d, gy(u, d))
    h.gutter((uw - ov, -ov, ye), (uw - ov, DE + ov, ye), (-1, 0, 0), zinc, down=[gd(-5.0, .12), gd(-5.12, 8.85)])
    h.gutter((ue + ov, -ov, ye), (ue + ov, DE + ov, ye), (1, 0, 0), zinc, down=[gd(5.02, .2)])
    h.gutter((uw - ov, -ov, ye), (ue + ov, -ov, ye), (0, -1, 0), zinc)
    yw = EA - ka * ova - .24
    h.gutter((ua0 - ova, da0 + .7, yw), (ua0 - ova, da1 + ova, yw), (-1, 0, 0), zinc, down=[gd(-2.15, 10.9)])
    h.gutter((ua1 + ova, da0 + .7, yw), (ua1 + ova, da1 + ova, yw), (1, 0, 0), zinc, down=[gd(4.8, 16.7)])
    fu_, fd = 1.6, 3.0
    r = main.height(fu_, fd)
    h.rod("vh_metal_small", (fu_, fd, r - .2), (fu_, fd, r + 1.3), .1, 8, "#b8bbbd")
    h.rod("vh_metal_small", (fu_, fd, r + 1.3), (fu_, fd, r + 1.42), .16, 8, "#9fa3a5")
    # --- the forecourt of dark tiles, from the front to the street's edge ---------------------------------------------
    h.pave([(-6.9, -.6), (-5.0, -.6), (-5.06, 9.0), (-1.5, 9.05), (-1.5, 10.8), (-2.12, 10.8), (-2.22, 16.9), (-6.9, 16.9)], lift=.03, cell=1.0)
    h.export()


HOUSES = {"vh_pale_hip": pale_hip}
for _name, _build in HOUSES.items():
    if not ONLY or _name in ONLY:  # noqa: F405
        _build()
