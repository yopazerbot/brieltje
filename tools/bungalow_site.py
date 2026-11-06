"""Where the bungalow stands and where its drive runs, in the game's coordinates (metres): its plot on the open-data outline
and the parking place with its drive, so that tools/street.py leaves the neighbours' blocks, hedges and fences out there.
The outside only: nothing of the bungalow's inside is here.

Plan coordinates: u from the left facade to the right one, v from the back to the front (towards the road).
"""
from shapely.geometry import Polygon
from shapely.ops import unary_union

ORIGIN = (83.343, 197.185)  # plan (0, 0): back corner of the left facade
E = (-0.7684, -0.64)  # plan u in the world
S = (0.64, -0.7684)  # plan v in the world (towards the road)
ROAD_V = 21.5  # the road's edge in front of the house
PARKING = (9.75, 0.6, 16.0, 14.6)  # right facade: paved parking


def P(u, v):
    return (ORIGIN[0] + u * E[0] + v * S[0], ORIGIN[1] + u * E[1] + v * S[1])


def R(u0, v0, u1, v1):
    return Polygon([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)])


def site():
    """Where the bungalow stands, with the larger GRB outline of the house and the old garage's
    outline (neighbouring buildings from the open data that overlap it are left out: the garage
    is gone)."""
    return unary_union([R(-1.8, -7.2, 11.0, 14.1), R(-6.9, -10.8, -2.8, -0.7)])


def clear():
    """Where the plot-line hedges and fences make way for the parking place and its drive (world)."""
    u0, v0, u1, v1 = PARKING
    return R(u0 - 0.3, v0 - 0.5, u1 + 0.5, ROAD_V + 1.0)
