# Poster images

Images for a Brieltje poster or flyer, rendered from the game's own models. They are our own work and free to use
for anything about Brieltje.

| File | What it is | Size |
|---|---|---|
| `zombies_lineup.png` | The five zombies of the Zombies game side by side, transparent background | 4219 × 1949 |
| `zombie_shirt.png` | The thin one in a torn shirt, shambling, transparent background | 1715 × 3090 |
| `zombie_hoodie.png` | The runner in a red hoodie, sprinting, transparent background | 1467 × 2750 |
| `zombie_overall.png` | The old mechanic in blue overalls, shambling, transparent background | 1854 × 3150 |
| `zombie_farmer.png` | The farmer in a flat cap, dungarees and wellies, shambling, transparent background | 1799 × 3143 |
| `zombie_big.png` | The big one in a white vest, stomping, transparent background | 1931 × 3064 |
| `town.png` | Smetlede: the church, the school and the square, rendered in Blender | 2560 × 1440 |
| `house.png` | The house in Briel, rendered in Blender | 2560 × 1440 |
| `bungalow.png` | The bungalow next to it, rendered in Blender | 2560 × 1440 |

The zombies are rendered by `tools/zombie_poster.py`, which builds them with `tools/zombies.py`:

```
blender -b -P tools/zombie_poster.py -- <repo> <out_dir>
```

The brand colours: dusk slate `#16202a`, lamplight amber `#f2b544`, warm cream `#f5efe4`, soft grey-blue `#bcc5ce`.
The typeface is Alegreya Sans.
