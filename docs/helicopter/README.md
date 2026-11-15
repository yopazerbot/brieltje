# The helicopter's model

A generic light twin with a shrouded tail rotor, built in Blender from its published sizes by
`tools/helicopter.py` (helpers in `tools/heli_parts.py`) into `web/public/models/helicopter.glb`. It carries no
maker's name, no logo, no registration, no real operator's look and no text anywhere. Reference pictures were only
used for comparing; nothing from them is in the repository.

    blender -b -P tools/helicopter.py -- web/public/models/helicopter.glb [preview_dir] [--views a,b] [--livery A|B|C] [--manifest docs/helicopter/manifest.json] [--beauty]

Two builds give the same bytes. The run fails, before the file is written, on a failed check or a broken budget
(65,000 triangles near, 5,000 far, 1,900,000 bytes). `manifest.json` lists every node with its place, its parent and
its triangles, the materials each mesh draws, the draw calls, and the sizes measured on the built model.

- `review.jpg`: the review renders from Blender (Eevee, the striped-sky test included).
- `game.jpg`: the model in the game, from `node tools/dev/helishots.mjs` (High and Low, day, dusk and night).

## The livery

The game's own, following no real operator: the body in `Paint`; one broad band in `PaintB` slanting back across
the cabin all round the machine (over the roof and the cowling, under the belly); the tail all in `Paint`; the rotor
cap and the blade tip bands in `PaintC`. The game colours the three
materials per machine: A evening blue, sunny yellow, chalk; B sunny yellow, evening blue, chalk; C chalk, evening
blue, sunny yellow.

## The interface for the flight code, as built

Metres; nose to -z, +x right, +y up; the origin on the ground under the main rotor's hub.

| Node | What it is |
|---|---|
| `Body` | fuselage, cowling, tail, skids, cabin, joined per material |
| `Detail` | antennas, wipers, pitot tubes, handles, bolts, wicks, step treads: hide past 40 m |
| `Rotor` | at (0, 3.20, 0), its y the mast leaning 5 degrees forward: spin about its own y |
| `Blade_1`..`Blade_4` | under `Rotor`, pivot at the root 1.15 m out; the blade along its local +x, its leading edge to its local -z; droop and coning about its local z (negative droops), feathering about its local x |
| `RotorDisc` | the blur disc in its own local XZ plane: a ring 0.6 to 5.2 m, coned up 2.5 degrees; at the rotor's place and tilt, not under `Rotor` (it doesn't spin) |
| `TailRotor` | at **(0, 1.85, 5.95)** (heli.md had (0, 1.95, 6.20)): spin about its own x; ten blades in pairs, tips at 0.495 m |
| `TailDisc` | the tail's blur disc in its own local YZ plane, a ring 0.12 to 0.5 m, at the tail rotor's place |
| `Door_FL`, `Door_FR` | origin on a vertical hinge line at the front edge (0.68 out, y 1.45, z -2.10): turn about local y |
| `Door_RL`, `Door_RR` | origin in the middle (z -0.30): slide along local +z |
| `Stick_Cyclic`, `Stick_Collective` | pivots at the floor (0.37, 0.72, -1.62) and at the lever's back end (0.11, 0.98, -0.95); `Grip_Cyclic`, `Grip_Collective` under them |
| `Far` | the simple copy, four materials |
| `GapLines` | the shut lines as loose edges (one line draw) |
| `Seat_0`..`Seat_5` | hip points at y 1.10, facing their -z: 0 pilot front right (0.37, -1.28), 1 front left, 2 and 3 rear facing forward (z 0.55), 4 and 5 middle facing aft (z -0.50) |
| `Eye_Pilot` | (0.37, 1.86, -1.30): a seated eye 0.76 m over the hip (recommended for the cockpit camera) |
| `Pedal_L`, `Pedal_R`, `Step_L`, `Step_R` | the pilot's feet; where a figure stands to board (x ±1.30, z -0.40) |

Sizes and boxes as built (the manifest has the measured values):

- Nose z -3.15, tail end z +7.06; 12.26 m long with the rotor turning; rotor head 3.36 m, fin 3.51 m high.
- **Skids**: tubes at x ±0.95 (track 1.90 m; heli.md had ±1.00), flat on the ground from z -2.11 to +0.71 (heli.md had
  contact points at z ±1.30): the real skids sit forward of the hub. Steps end at x ±1.05.
- **Cabin**: half width 0.78 m; floor y 0.72; roof inside at the front seats y 2.13; the shell's top 2.45 m; **the engine
  cowling rises to y 2.85** between z -0.56 and +1.12, over the cabin box's 2.50.
- **Boom and tail**: the boom from z ~1.8 to the shroud, 0.33 to 0.45 m wide; the tail housing within x ±0.21; **the
  horizontal stabiliser spans x ±1.35** at y 1.53, z 4.05 to 4.62, with its end plates from y 1.06 to 2.04.

Materials: `Paint`, `PaintB`, `PaintC` (the livery's three colours), `Glass`, `Trim`, `Metal`, `Rubber`, `Interior`,
`Screen` (its picture is in the vertex colours), `Gap`, `LightRed`, `LightGreen`, `LightWhite`, `LightBeacon`,
`LightLanding`, `RotorBlur`.
