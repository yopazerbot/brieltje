# Southern homes and detailed house

The map continues along the connecting streets to the southern homes. The extension keeps the roads,
lanes and gardens, with its own tree budget and no extra crop fields. The existing terrain's sampled
heights stay unchanged. Use `/location Oordegemkouter` to reach the street; the detailed pale-brick house
is farther along it, with a tall glazed entrance behind a gravel drive and clipped hedges.

The exterior is made in Blender by `tools/kouter_house.py`, using the building's public model position,
outline and roof heights. The street-visible facade and front garden follow a visual reference.
Unseen side and rear windows and the small rear terrace are interpretations. The house is an exterior;
its doors stay shut. No reference imagery, numbers, addresses or names are shipped.

The model uses existing game textures, 12 merged material meshes and about 10,600 triangles. Its small
download is separate from the initial house data. It is drawn within 350 metres. Estimated paving and
hedges inside its garden give way to the model's surfaces. Its 18 collision blocks go into the village
data used by both the browser and the server. If the model fails to load, the village blocks remain.

## Regenerate

Keep the existing input data and install the existing `tools/requirements.txt` environment. Fetch missing
open-data strips once; nothing from the downloads or the visual references belongs in a commit:

```
tools/.venv/bin/python tools/geodata.py --strip w
tools/.venv/bin/python tools/geodata.py --strip e
tools/.venv/bin/python tools/geodata.py --strip w2
tools/.venv/bin/python tools/geodata.py --strip s
tools/.venv/bin/python tools/neighbours.py
tools/.venv/bin/python tools/terrain.py
tools/.venv/bin/python tools/street.py
blender -b -P tools/kouter_house.py -- web/public/models/kouter_house.glb data/kouter_house.json
tools/.venv/bin/python tools/build_house.py
tools/.venv/bin/python tools/streets.py
tools/.venv/bin/python tools/roads.py
tools/.venv/bin/python tools/road_detail.py
tools/.venv/bin/python tools/bounds.py
tools/.venv/bin/python tools/places.py
```

On Windows, use `tools/.venv/Scripts/python` for the Python commands. Commit the generated data and GLB
with the tools. The southern row activates only after it and the three northern side strips are complete;
the height rasters and reference photo mosaic are joined by geographic position, with north at the top.

Run the map checks with `tools/.venv/bin/python -m unittest discover -s tools -p test_map_extension.py`,
then `npm run build` in `web/`. These checks cover north/south alignment, incomplete downloads, connected
roads, the driveway opening and collision inside the shared boundary. A real phone still needs a play test.
