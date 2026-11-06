"""Place level house floors at their entrances and carry walls into sloping ground."""
import math


def frontage_base(house, relief):
    """Builder base (floor minus 5 cm), preserving deliberately raised or walk-in houses."""
    if "raise" in house or house.get("inside"):
        return house["y0"]
    a, b = house["front"]
    length = math.dist(a, b)
    if length < 1e-6:
        return house["y0"]
    direction = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
    doors = [o for o in house["openings"] if o[4] in ("d", "ad") and o[2] < 0.05]
    if not doors:
        doors = [o for o in house["openings"] if o[4] == "g" and o[2] < 0.05]
    positions = [o[0] for o in doors] or [length / 2]
    # The high entrance fixes a level floor; existing steps meet the lower entrances.
    return round(max(relief.height(a[0] + direction[0] * s + house["out"][0] * 0.5,
                                   a[1] + direction[1] * s + house["out"][1] * 0.5)
                     for s in positions) + house.get("threshold", 0.05) - 0.05, 3)


def wall_bottom(a, b, base, height):
    """A flat foundation safely below the terrain all along the wall, not just at its ends."""
    steps = max(1, math.ceil(math.dist(a, b)))
    lowest = min(height(a[0] + (b[0] - a[0]) * i / steps,
                        a[1] + (b[1] - a[1]) * i / steps) for i in range(steps + 1))
    return min(-1.2, lowest - base - 0.25)
