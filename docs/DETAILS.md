# Details

The game in depth: every feature, the controls, hosting, how to rebuild the data from the sources, and the folder layout. The short version is in the [README](../README.md).

_Originally the project README:_

A browser-based, first-person walkthrough of our new house in Briel, built with Three.js. Phase 1 is a grey box: untextured walls, floors, stairs and windows at real scale.

## Run It

You need Node.js (installed) and Chrome or Edge.

```
cd web
npm install
npm run dev
```

Open **http://localhost:5173** in Chrome or Edge. Pick a nickname and choose **Keyboard + mouse** or **Controller**.

| Action | DualSense | Keyboard and mouse |
|---|---|---|
| Move | Left stick | W A S D (Z Q S D on AZERTY) |
| Look | Right stick | Mouse |
| Sprint | L3 (click the left stick) | Hold Shift |
| Jump | ✕ | Space |
| Fly up / down | Hold ✕ / ○ | Hold Space / Ctrl or C |
| Stop flying | Double-tap ✕ | Double-tap Space |
| Open or close a door | R2 or △ (△ in Action mode) | Click or E (E in Action mode) |
| Shoot / aim / reload (Action mode) | R2 / L2 / □ | Left click / right click / R |
| Switch weapon | D-pad up / down, L1 | 1 to 4, mouse wheel, Q (A on AZERTY) for the last one |
| Throw a grenade (Action mode) | R1 | G |
| Crouch | Hold ○ | Hold Ctrl or C |
| FPS counter | Create | F |
| Big map | Press the touchpad | M (or click the minimap; on a phone, tap it) |
| Minimap on / off | (keyboard only) | N |
| Scoreboard (multiplayer) | Hold the touchpad | Hold Tab |
| Sound on / off | (Sound button) | Shift+M |
| Chat (multiplayer) | Keyboard only | T or Enter |
| Portal: pick a place (on its pad) | D-pad up / down, △ | 1 to 5, or the mouse wheel and E |
| Menu (open and close) | Options | Esc |

**Portals:** five rings round the map, at the main house, the bungalow, the church, the school and Molenhoek. Step onto a portal's glowing pad (or stop the car on it) and the list of places opens: a number key, the wheel or D-pad and E or △, or a tap on a phone. You come out in front of the other portal, looking at the place; in the car the car comes along, with its passenger. The place you came from is marked "back". The minimap points to the nearest portal. In multiplayer, `/church`, `/house`, `/bungalow`, `/school` or `/molenhoek` in the chat (also `/kerk`, `/huis`, `/location church`) takes you there; the admin can turn the portals and the chat travel off in the settings (Admin: house rules), and the admin can always travel from the chat.

At the start you choose **Explore** (just walking around) or **Action** (hands and a pistol). Walking speed is a slider on the start screen and in the menu (D-pad left/right on the controller).

The DualSense works over Bluetooth once it is paired with Windows. Chrome only reports a controller after you press one of its buttons while the page is open.

## Hosting (Railway)

The Railway project has two services: `briel-GTA` (builds from the `web` folder of `main` and runs `web/server.mjs`) and `Postgres` (accounts and the login log). Anyone with the URL can walk around alone. Multiplayer needs the PIN (or an account). Search engines are asked not to index the site.

| Variable on `briel-GTA` | Value |
|---|---|
| `ADMIN_PASSWORD` | Your admin password (set it yourself in Railway). Username: `admin` |
| `MULTIPLAYER_PIN` | Optional: the PIN to start with (without it `0473`). Once the admin sets a PIN in the game's settings, that one counts (kept in the database) |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (already set) |
| `TRUST_CLOUDFLARE` | `1` (already set): log the real visitor IP behind Cloudflare, and only answer requests that came through Cloudflare (Railway also answers for the domain when someone connects to it directly) |

**Loading:** the build leaves a brotli copy next to the big files that compress well (the sky photo, the models, the scripts), and the server sends those to browsers that accept brotli. Only these static files are compressed: the API answers carry `no-transform` so Cloudflare leaves them alone too, and the WebSocket has compression off. Every file has an ETag, so a revisit only downloads what changed. The baked lighting is only downloaded once it is switched on.

**Logins:** a wrong password counts against the address (10 in 15 minutes; a whole IPv6 /64 counts as one address) and against the account (20 in an hour). A browser that logged into an account in the last 90 days keeps a signed device cookie and can still log in while someone else is guessing that account. At most two password checks run at a time; more are answered "busy". The login log keeps 90 days and at most 20,000 entries, because it holds IP addresses. On the live site the cookies carry the `__Host-` prefix, so no other subdomain can set them.

**Multiplayer:** 4 players at once to start with; the admin can allow up to 16 in the settings (Admin: players at once), kept across restarts. On the start screen you choose **Solo** or **Multiplayer**; for multiplayer you type your name and the PIN and press Join (no password). A name that belongs to an account (the admin's too) can't be taken, nor a name another player joined with today (it stays theirs for 12 hours, or until they log out). The admin changes the PIN in the settings (Admin: multiplayer PIN, 4 to 12 digits; a new PIN logs out everyone who joined with the old one) and can switch joining with the PIN off there; kicking a guest also keeps their address from joining with the PIN for the 10 minutes. The admin and up to 3 accounts the admin creates in the in-game menu (Admin section) log in with their password instead ("Have an account? Log in with its password"). Wrong PINs count against the address like wrong passwords, and at most 30 wrong PINs an hour are accepted from everyone together; browsers that joined before are never held back by that. The PIN is only checked on the server. The admin can kick players (they are kept out for 10 minutes), reset passwords and see the login log with IP addresses and Belgian time. Chat with T or Enter.

**Phones and tablets:** the start screen advises a laptop or desktop, and offers **Touch screen**: a stick appears where your left thumb touches, drag on the right to look (also while holding Fire). The buttons follow what you do. Walking: Jump in the corner, Use (doors, the Tesla, the horses) above it, Down beside it, Run on the left. In Action mode: Fire in the corner with Aim, Jump, Use, Reload, Nade, next weapon (⇄) and Down round it. In a car: Brake and Use. In the furniture planner (from the menu): Place, Move, Next, Turn, Remove, Use, and Done to stop. ☰ (the menu), sound and full screen are icons top left. In the Tesla the stick drives, brakes and steers. Hold the device sideways; the game asks for full screen where the browser allows it.

**Menu (Esc, or Options):** opens and closes with the same key. Three columns: play (mode, walking speed, graphics) and the house tools, the controls grouped by moving, weapons, house, the Tesla and other, and the settings with multiplayer. After closing it with Esc, click once to capture the mouse again (browsers want a click for that).

**Settings (pause menu):** mouse sensitivity, controller look speed, field of view, volume, invert look and controller vibration, remembered in the browser.

**Sound:** other players' shots and footsteps come from where they are (3D sound, quieter with distance). Footsteps sound different on wood, tiles, stone, grass and metal.

**Weapons (Action mode):** you start with the pistol. A rifle (automatic) lies in the carport and on the garden terrace, a shotgun in the playroom upstairs, a sniper rifle on the 1st floor terrace. Walk over one to take it; it comes back after 20 seconds. You lose them when you die. Crouching steadies your aim; running and jumping make it worse. The sniper rifle is only accurate through the scope. Shots leave a hole that matches the surface (chipped brick, splintered wood, dented metal, cracked tiles), with dust, sparks or chips; spent casings fly out and tinkle on the floor. The gun lags a little when you turn, tilts when you step sideways, dips when you land and is carried low while you sprint.

**Other players** are animated SWAT characters (by Quaternius, CC0), each in their own colours, holding the gun they picked up with both hands (rifles in the shoulder). They flinch when your shot hits them.

**Old bungalow down the lane** (`tools/old_house.py`): built from photos of old hand-drawn plans plus an upper-floor sketch, at its real place about 190 m from the plot; walk-in, upstairs too. Checked again against new photos of the sheets on 30 Oct 2026: 9.30 m wide, eaves 2.95 m and ridge 5.9 m above the floor (the roof was too steep), the front windows 2.15 m high down to the floor, the side windows from 0.70 m, the window positions from the dimension chains, the chimney and gable windows to the elevations, and the gables in brick.

**Doors and glass:** the playroom has a floor-to-ceiling oak sliding door to the sitting area, and a glass double door in bronze frames opens from the hall into the living area (both from the renders). The kitchen's glass door to the roof terrace opens. Toilet doors start shut. The glass in doors (the sliding doors, the glass doors, the back door) breaks when shot, like the windows; "Repair windows" puts it back.

**Fittings:** a coffee machine in piano black in its niche in the kitchen units, wall-hung toilets in both WCs, a 75 inch TV with a white soundbar on the wall above a white lowboard, pendant lights from the renders. The coffee machine, soundbar, toilet and the office chair are our own Blender models (`tools/coffee_machine.py`, `tools/soundbar.py`, `tools/toilet.py`, `tools/aeron.py`), made from published sizes and photos, so they need no licence.

**Office (2nd floor, Bureau 2):** an oak desk with an ultrawide and a portrait screen, keyboard and mouse on a felt mat, a drawer unit and the small things of a desk in use, a graphite mesh office chair, floating shelves with warm light strips, oak slats behind the indoor bike, a framed print, a round jute rug and plants. The bike's screen shows a ride that moves (power, riders around you, the climb ahead), drawn in code.

**Bazooka (5):** the admin's weapon in multiplayer (anyone's when playing alone). The server decides the blast damage.

**Grenades (G, or R1):** everyone carries two; a thrown one is back after 15 seconds. A grenade bounces off walls, floors and doors, rolls to a stop and goes off after 3 seconds; a hard throw breaks a window. Walls and floors shield you from the blast. The thrower is spared, as with the bazooka. Sizes, fuse and damage are in `web/shared/grenade.json` (the server reads the same file).

**The Tesla (E, or Triangle):** a black Model Y on the driveway. Walk up to it and press E (Triangle) to get in; the camera moves behind the car. W/S or R2/L2 to drive, brake and reverse; A/D or the left stick to steer; Space or Cross for the handbrake (the rear slides); the mouse or right stick looks around and the view swings back behind the car as you drive. E (Triangle) again to get out by the driver's door. It stops against the house, hedges, fences, neighbours' walls, tree trunks and other players, and can't hurt anyone. In multiplayer one player drives it at a time, everyone sees it move (with the driver's name above it) and it stays where it was left; it is back on the driveway after a restart. The driver can't be shot, and can't shoot. Sizes and speeds are in `web/shared/car.json` (the server reads the same file). The model is built in Blender from the Model Y's published sizes and photos of it (`blender -b -P tools/model_y.py -- web/public/models/model-y.glb`), so it needs no licence. A second pass (30 Oct) added panel gaps, flush handles, proper mirrors, ten-spoke wheels with brake discs and calipers, and a cabin you can see through the tinted glass. At speed a blur disc fades over the wheels, so the spokes don't seem to stand still or turn backwards.

**Admin switches (settings, multiplayer):** allow flying, whether players can move furniture (the admin always can), and names above players (they show through walls). They are kept on the server across restarts.

**Windows and outside doors** follow the window maker's quote (private, not in the repo): in `data/house.manual.json` each window has `panes` as the quote draws them (seen from inside, left to right, width in mm and fixed, turn, tilt-turn or slide), and optionally `matte` (frosted glass). A glass wall has one pane list per segment and `"corner": "glass"` for a corner without a post. After editing, run `extract_plan.py` and `build_house.py`.

**Baked lighting (test):** a setting that draws the house with light baked in Blender (light bouncing between walls, cheaper on weak graphics). To rebake after changing the house: export from the dev page, then `blender -b -P tools/bake/bake_lightmap.py -- <glb> <sun.json> <out> 2048 512` and `python tools/bake/encode_lightmap.py <out> web/public/baked`.

**Furniture planner (P, or the menu button):** place furniture at real sizes (beds, wardrobes, sofas, tables, chairs, desks, bookcase, TV unit, rugs, washing machine, lamp, plants, children's furniture, garden sofa, Zwift bike, weight bench). A see-through copy shows where it goes; click to place, mouse wheel to change the piece, R to turn it 45 degrees, right click to pick a piece up and move it, X to remove. Logged in, everyone sees and edits the same furniture (kept in the database, at most 300 pieces; the admin can remove all). Without logging in it is kept in your browser. Furniture shows on the minimap.

**Surroundings:** the plot, the lane, the neighbouring houses (each part of a house with its own roof shape fitted to the laser scan: flat, gable either way, hip or lean-to, at its own eaves and ridge height; roofs in the colours of the aerial photo; houses built after the scan from the land registry and the photo), the plot lines between gardens, the canopies and the trees come from Flemish open data (GRB, DHM Vlaanderen II and the most recent orthophoto, source: Digitaal Vlaanderen). To refresh them, see `tools/neighbours.py`. The data has no bricks, windows or hedges, so `tools/facades.py` makes those up in the style of the street, the same every run: brick colours per house, windows, doors and garage doors (the wall facing the road gets the front door), gable windows under high roofs, and a hedge, a green wire fence on concrete posts or nothing between gardens. The road has a concrete edge strip. Shadows of every house, hedge and tree on the ground are worked out once when the game loads; far away everything fades into the haze, with tree lines on the horizon.

**Cats:** four cats wander around the garden, the front lawn and the side path, meowing now and then. You can shoot them (no points); they are back after 15 seconds.

**Leaderboard:** the pause menu shows all-time kills, deaths, headshots and round wins per account. Logins survive a redeploy.

**Fighting (multiplayer, Action mode):** everyone starts with 100 health. Three body hits or one headshot kill. You respawn after 3 seconds at a spawn point away from the others, protected for 2 seconds (until you shoot). A kill is worth 100 points, a headshot kill 150. The first to 10 kills wins the round; 8 seconds later the scores go back to zero. The admin can start a new round from the menu. Players in Explore mode can't be hurt. The server keeps the score and checks each reported hit (both players fighting and alive, fire rate, range).

**Run the server locally:** `cd web`, `npm run build`, then start it with `ADMIN_PASSWORD` set and run `npm start`. Without `DATABASE_URL` it keeps users in `web/.data/` (not in git). During `npm run dev`, the login and multiplayer calls are forwarded to that server on port 8080.

## Rebuild the House Data

The 3D blocks are built from private source drawings (not in the repo; the built result is in `web/src/data/house.json`). To regenerate them after changing the extraction or `data/house.manual.json`:

```
tools/.venv/Scripts/python tools/extract_plan.py
tools/.venv/Scripts/python tools/build_house.py
```

First time only, create the Python environment:

```
python -m venv tools/.venv
tools/.venv\Scripts\pip install -r tools/requirements.txt
```

Private source files are not in the repo; the tools that read them expect them in `source\` (git-ignored). Everything the game needs is already built into `web/src/data/` and `web/public/`.

## Folder Layout

| Folder | Contents |
|---|---|
| `docs\` | Inventory of the source material and the original handover brief |
| `source\` | Private source files (not in git) |
| `tools\` | Python scripts that read the plans and build the 3D data |
| `data\` | Extracted walls (`extracted.json`) and hand-measured additions (`house.manual.json`) |
| `web\` | The Vite + Three.js app, its generated house data (`src\data\house.json`) and the production server |

See `DECISIONS.md` for what we chose and why, and `PROGRESS.md` for status.
