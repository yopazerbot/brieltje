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
| Fly up / down | Hold ✕ / ○ | Hold Space / Ctrl |
| Stop flying | Double-tap ✕ | Double-tap Space |
| Open or close a door | R2 or △ (△ in Action mode) | Click or E (E in Action mode) |
| Shoot / aim / reload (Action mode) | R2 / L2 / □ | Left click / right click / R |
| Switch weapon | D-pad up / down, L1 | 1 to 4, mouse wheel, Q (A on AZERTY) for the last one |
| Throw a grenade (Action mode) | R1 | G |
| Place a claymore (Zombies, once you carry one) | Hold R1 | Hold G |
| Plant a row of stakes (Zombies, blocks players on foot until it breaks) | Hold □ | Hold R |
| Set up a turret (Zombies, once you carry one; nothing else to use near you) | Hold △ | Hold E |
| Help a teammate up (Zombies) | Hold △ for 3 s next to them | Hold E for 3 s next to them |
| Crouch | Hold ○ | Hold Ctrl (C also works) |
| FPS counter (also in Settings) | Create | F |
| Map (the menu's first tab; again to play on) | Press the touchpad | M (or click the minimap; on a phone, tap it) |
| Minimap on / off | Settings | N, or Settings |
| Scoreboard (multiplayer) | Hold the touchpad | Hold Tab |
| Sound on / off | 🔊 in the menu | Shift+M, or 🔊 in the menu |
| Chat (alone: commands only) | Keyboard only | T or Enter |
| Portal: pick a place (on its pad) | D-pad up / down, △ | 1 to 7, or the mouse wheel and E |
| Menu (open and close) | Options (○ closes it too) | Esc |
| Menu tabs | L1 / R1 | ↑ / ↓ on the tab rail |

**Portals:** seven rings round the map: at the main house, the bungalow, the church, the school, and at the start, the middle and the end of Molenhoek. Step onto a portal's glowing pad (or stop the car on it) and the list of places opens: a number key from 1 to 7 (top row or numpad), the wheel or D-pad and E or △, or a tap on a phone. You come out in front of the other portal, looking at the place; in the car the car comes along, with its passenger. The place you came from is marked "back". The minimap points to the nearest portal. In the chat, alone too, `/location` and a name takes you to a portal or a street: `/location church`, `/location Kapellenhoek` (also `/locatie`, `/tp`, `/ga naar`, and the short `/church`, `/kerk`, `/huis`). Capitals, accents, spaces and hyphens don't matter. The start of a name is enough when only one place starts that way. `/location` alone lists every place. Each of the 26 streets has a spot near the middle of its longest stretch, on the pavement or the road's edge (`tools/places.py`, `web/shared/places.json`); a car you drive comes along to its lane. Without a keyboard, the menu's Play tab lists the same places (a tap, or the D-pad and △). In multiplayer the admin can turn the portals and the chat travel off in the settings (Admin: house rules), and the admin can always travel from the chat.

At the start you choose **Explore** (just walking around), **Paintball** (paint guns, for everyone; the paint sticks where it lands) or **Action** (hands and a pistol). In multiplayer the admin can make Action child-friendly with a house rule. Walking speed is a slider on the start screen and in the menu (D-pad left/right on the controller).

The DualSense works over Bluetooth once it is paired with Windows. Chrome only reports a controller after you press one of its buttons while the page is open.

In team games, V calls teammates; it is listed in the keyboard Controls tab without a permanent HUD button. Touch players have a Come here button. It marks the sender's current game position for eight seconds, once every three seconds. Teammate markers show direction and distance. Holding a Zombies equipment action for 0.8 seconds places it, with a preview while held. Multiplayer previews use the server's placement rules, including inventory and the available space.

During a wave break, the top bar prompts reloading and preparation, counts rewards and highlights the final three seconds. Rewards within 45 metres have distance labels. Outdoors, runners approach from alternate sides while they have a clear route. Big zombies pause to pound planted pike rails.

Moving with a rifle adds 10 percent to its spread. Aiming a shotgun tightens its pellet spread by 25 percent. A scoped sniper is accurate while stationary and gains spread while moving.

## Hosting (Railway)

The Railway project has two services: `briel-GTA` (builds from the `web` folder of `main` and runs `web/server.mjs`) and `Postgres` (accounts and the login log). Anyone with the URL can walk around alone. Multiplayer needs the PIN (or an account). Search engines are asked not to index the site.

| Variable on `briel-GTA` | Value |
|---|---|
| `ADMIN_PASSWORD` | Your admin password (set it yourself in Railway). Username: `admin` |
| `PRIVATE_DATA_KEY` | 32 random bytes, base64; set by the merger with the Railway command line, never shown |
| Multiplayer PIN | Set by the admin in the game's settings and kept in the database. No default or environment-variable fallback; guest joining stays closed until a PIN is saved. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (already set) |
| `TRUST_CLOUDFLARE` | `1` (already set): log the real visitor IP behind Cloudflare, and only answer requests that came through Cloudflare (Railway also answers for the domain when someone connects to it directly) |

**Loading:** the build leaves a brotli copy next to the big files that compress well (the sky photo, the models, the scripts), and the server sends those to browsers that accept brotli. Only these static files are compressed: the API answers carry `no-transform` so Cloudflare leaves them alone too, and the WebSocket has compression off. Every file has an ETag, so a revisit only downloads what changed. The baked lighting is only downloaded once it is switched on.

**Logins:** a wrong password counts against the address (10 in 15 minutes; a whole IPv6 /64 counts as one address) and against the account (20 in an hour). A browser that logged into an account in the last 90 days keeps a signed device cookie and can still log in while someone else is guessing that account. At most two password checks run at a time; more are answered "busy". The login log keeps 90 days and at most 20,000 entries, because it holds IP addresses. On the live site the cookies carry the `__Host-` prefix, so no other subdomain can set them.

**Multiplayer:** 16 players at once to start with; the admin can lower that in the settings (Admin: players at once), kept across restarts. On the start screen you choose **Solo** or **Multiplayer**; for multiplayer you type your name and the PIN and press Join (no password). A name that belongs to an account (the admin's too) can't be taken, nor a name another player joined with today (it stays theirs for 12 hours, or until they log out). The admin changes the PIN in the settings (Admin: multiplayer PIN, 4 to 12 digits; a new PIN logs out everyone who joined with the old one) and can switch joining with the PIN off there; kicking a guest also keeps their address from joining with the PIN for the 10 minutes. The admin and up to 3 accounts the admin creates in the in-game menu (Admin section) log in with their password instead ("Have an account? Log in with its password"). Wrong PINs count against the address like wrong passwords, and at most 30 wrong PINs an hour are accepted from everyone together; browsers that joined before are never held back by that. The PIN is only checked on the server. The admin can kick players (they are kept out for 10 minutes), reset passwords and see the login log with IP addresses and Belgian time. Chat with T or Enter. Each page sends its position 20 times a second while it moves, and a few times a second standing still. The server sends every page what moved, 20 times a second, and the page draws the others about a tenth of a second in the past, between two positions (`web/shared/wire.mjs`, `web/src/net/track.ts`). They move at an even pace, stop where they stopped and jump through a portal instead of sliding across the map. The FPS line (F) shows the ping to the server; `?diag` also shows how far behind the others are drawn and the bytes a second. The admin page lists each player's ping.

**Phones and tablets:** the start screen advises a laptop or desktop, and offers **Touch screen**: a stick appears where your left thumb touches, drag on the right to look (also while holding Fire). The buttons follow what you do. Walking: Jump in the corner, Use (doors, the Tesla, the horses) above it, Down beside it, Run on the left. In Action mode: Fire in the corner with Aim, Jump, Use, Reload, Nade, next weapon (⇄) and Down round it. In a car: Brake and Use. ☰ (the menu) and full screen are icons top left; the sound is in the menu's header. In the Tesla the stick drives, brakes and steers. Hold the device sideways; the game asks for full screen where the browser allows it.

**Menu (Esc, or Options):** opens and closes with the same key, on the tab you left it on. A header with your name and how you play, the sound (and full screen on a phone or tablet) and Resume. On the left a rail of tabs: Map, Play (the mode, walking speed, switching controls, and the house tools), Together (joining with the PIN, or who is online, your team, the scores and Leave), Settings (picture and sound, looking around, language and keyboard, a folded Advanced part), Controls (cards grouped by what you do, for the way you play) and Admin for the admin. The arrow keys move along the rail, L1 and R1 on the controller; on a phone the rail shows icons only. Under the page: the terms, privacy, credits, GitHub and the meetup sign-up. M opens the menu on the Map tab and M again goes back to the game. After closing it with Esc, click once to capture the mouse again (browsers want a click for that).

**Map (the menu's first tab):** the whole area, north up: drag, W A S D (Z Q S D) or the left stick to move it, the wheel, + and −, a pinch or R2/L2 to zoom, buttons for where you are and the whole map. A click (or tap) on a place gives its card with Directions; anywhere else sets a waypoint. With the controller ✕ sets one at the cross in the middle. The way along the roads shows on the minimap once you play on. No travelling from the map: the portals are for that. The world isn't drawn while the map shows.

**Settings (pause menu):** graphics, volume, the minimap (N) and the FPS counter (F), mouse sensitivity, controller look speed, field of view, invert look, controller vibration, language and keyboard layout, remembered in the browser. The baked-lighting test is under Advanced.

**Sound:** other players' shots and footsteps come from where they are (3D sound, quieter with distance). Footsteps sound different on wood, tiles, stone, grass and metal.

**Weapons (Action mode):** you start with the pistol. A rifle (automatic) lies in the carport and on the garden terrace, a sniper rifle on the 1st floor terrace. Walk over one to take it; it comes back after 20 seconds. You lose them when you die. Crouching steadies your aim; running and jumping make it worse. The sniper rifle is only accurate through the scope. Shots leave a hole that matches the surface (chipped brick, splintered wood, dented metal, cracked tiles), with dust, sparks or chips; spent casings fly out and tinkle on the floor. The gun lags a little when you turn, tilts when you step sideways, dips when you land and is carried low while you sprint.

**Other players** are animated SWAT characters (by Quaternius, CC0), each in their own colours, holding the gun they picked up with both hands (rifles in the shoulder). Their helmet is in their player colour, so you know who is who from afar. Their feet keep step with how fast they move. They look up and down with their aim. Standing, they turn their upper body first and then step round. They crouch, tuck their legs in a jump and sit in the saddle on a horse. A soft shadow lies under each. Two players on one spot are drawn a little apart, but nobody blocks a door. They flinch when your shot hits them.

**Old bungalow down the lane** (the private tools): built from private source files, at its real place about 190 m from the plot; walk-in with its code.

**Doors and glass:** the glass in doors (the sliding doors, the glass doors, the back door) breaks when shot, like the windows; "Repair windows" puts it back.

**Fittings:** the coffee machine, soundbar, toilet and the office chair are our own Blender models (`tools/coffee_machine.py`, `tools/soundbar.py`, `tools/toilet.py`, `tools/aeron.py`), made from published sizes and photos, so they need no licence.

**Bazooka (5):** the admin's weapon in multiplayer (anyone's when playing alone). The server decides the blast damage.

**Grenades (G, or R1):** everyone carries two; a thrown one is back after 15 seconds. A grenade bounces off walls, floors and doors, rolls to a stop and goes off after 3 seconds; a hard throw breaks a window. Walls and floors shield you from the blast. The thrower is spared, as with the bazooka. Sizes, fuse and damage are in `web/shared/grenade.json` (the server reads the same file).

**The Tesla (E, or Triangle):** a black Model Y on the driveway. Walk up to it and press E (Triangle) to get in; the camera moves behind the car. W/S or R2/L2 to drive, brake and reverse; A/D or the left stick to steer; Space or Cross for the handbrake (the rear slides); the mouse or right stick looks around and the view swings back behind the car as you drive. E (Triangle) again to get out by the driver's door. It stops against the house, hedges, fences, neighbours' walls, tree trunks and other players, and can't hurt anyone. In multiplayer one player drives it at a time, everyone sees it move (with the driver's name above it) and it stays where it was left; it is back on the driveway after a restart. The driver can't be shot, and can't shoot. Sizes and speeds are in `web/shared/car.json` (the server reads the same file). The model is built in Blender from the Model Y's published sizes and photos of it (`blender -b -P tools/model_y.py -- web/public/models/model-y.glb`), so it needs no licence. A second pass (30 Oct) added panel gaps, flush handles, proper mirrors, ten-spoke wheels with brake discs and calipers, and a cabin you can see through the tinted glass. At speed a blur disc fades over the wheels, so the spokes don't seem to stand still or turn backwards.

Both Tesla models, including spawned cars, now reach about **200 km/h**. They keep the same initial
acceleration, gain speed progressively and keep their braking and reverse limits. All four wheels roll
correctly; only the two front axles steer. The compact km/h display stays visible while driving or riding,
bottom right on desktop and below the map on touch. It shows reverse speed as a positive number and hides
on foot or in menus. The arrival announcement moves clear of it. The server reads the same top-speed
settings and applies its car allowance only to players actually seated in one.

Run `node web/src/world/car.test.mjs` for model and physics regressions. With a dev server running, use
`node tools/dev/car.mjs --url http://localhost:5295/ --port 9441 --swiftshader` for the real-model and HUD
check; add `--phone` for touch or `--out view.png` for a screenshot. The browser check uses Low, WebP and
disabled light bakes; its fixed speed readout is a UI fixture, separate from the driving tests.

**Admin switches (settings, multiplayer):** allow flying, whether players can spawn things with /name (off at first; the admin always can), and names above players (they show through walls). They are kept on the server across restarts.

**Windows and outside doors** of the three locked homes are described in the private tools' inputs (the private companion repository), not here.

**Baked light and wear on the building models:** the ten models of our own in `tools/bake/buildings.json` (church, school, town, Molenhoek, Kapellenhoek, the houses at home, the dormer house) draw light baked in Blender with the whole village round them, plus wear (`web/src/world/bakedLight.ts`; `?nobake` in the dev build leaves it out). After a model's own tool has run again, its bake no longer matches (the layout id) and it keeps real-time light until it is baked again:

1. `tools/.venv/Scripts/python.exe tools/bake/lightmap_uv.py` (the light layouts; `--dry` only prints the sizes).
2. On the dev server, once the village is in, run `tools/bake/export_scene.js` in the page: it downloads `bake_scene.glb` and `bake_info.json`.
3. `blender -b -P tools/bake/bake_buildings.py -- <folder with the two files> <work folder> 512` (about 4 minutes on the RTX 5070).
4. `tools/.venv/Scripts/python.exe tools/bake/encode_buildings.py <work folder> web/public/baked` (WebP and KTX2, full size and `half/` for phones).

**Compressed textures (KTX2):** every surface texture also exists as KTX2 (Basis Universal), which stays compressed on the graphics chip: `web/public/textures/ktx2/` for desktops, `ktx2/half/` for phones and tablets (`web/src/world/textureFiles.ts`; `?webp` forces the WebP files). After a texture tool has changed a texture: `tools/.venv/Scripts/python.exe tools/ktx2.py` and `tools/ktx2.py --half`. The encoder (basisu, built for WASI) is fetched into `tools/.bin/` on first use; the transcoder the page uses is in `web/public/basis/` (changed to run without eval, see the top of its script).

**Spawning things (/name in the chat):** type a thing's name to have it appear in front of you: furniture at real sizes (beds, wardrobes, sofas, tables, chairs, desks, bookcase, TV unit, rugs, washing machine, lamp, plants, children's furniture, garden sofa, Zwift bike, weight bench), a Tesla in one of five colours (it drives), a clown or a strongman. English or Dutch: /sofa or /zetel, /tesla red or /tesla rood, /bed 160, /krachtpatser. /spawn lists everything; /remove (or /weg) takes away what you look at. Alone you can always spawn, and it is kept in your browser. Together the admin can always; the others only when the admin turns it on in the settings (it is off at first). The server then checks every spawn: within 8 m of where it has you, inside the game's edge, at most 20 pieces, 2 Teslas and 2 characters each; each player takes away only their own, the admin anything. The furniture is kept in the database (at most 300 pieces; the admin can remove all or put the starting layout back). Furniture shows on the minimap. (The furniture planner, with its pick-up and turn, was taken out on 2 November 2026.)

**Surroundings:** the plot, the lane, the neighbouring houses (each part of a house with its own roof shape fitted to the laser scan: flat, gable either way, hip or lean-to, at its own eaves and ridge height; roofs in the colours of the aerial photo; houses built after the scan from the land registry and the photo; buildings under trees, where the scan saw only the crowns, at usual heights with a gable), the plot lines between gardens (open where a road, a field track, a footpath or a drive crosses them), the canopies and the trees come from Flemish open data (GRB, DHM Vlaanderen II and the most recent orthophoto, source: Digitaal Vlaanderen). To refresh them, see `tools/neighbours.py`. The data has no bricks, windows or hedges, so `tools/facades.py` makes those up in the style of the street, the same every run: brick colours per house, windows, doors and garage doors (the wall facing the road gets the front door), gable windows under high roofs, and a hedge, a green wire fence on concrete posts or nothing between gardens. The road has a concrete edge strip. Shadows of every house, hedge and tree on the ground are worked out once when the game loads; far away everything fades into the haze, with tree lines on the horizon.

**Cats:** four cats wander around the garden, the front lawn and the side path, meowing now and then. You can shoot them (no points); they are back after 15 seconds.

**Leaderboard:** the menu's Together tab shows all-time kills, deaths, headshots and round wins per account. Logins survive a redeploy.

**Fighting (multiplayer, Action mode):** everyone starts with 100 health. Three body hits or one headshot kill. You respawn after 3 seconds at a spawn point away from the others, protected for 2 seconds (until you shoot). A kill is worth 100 points, a headshot kill 150. The first to 10 kills wins the round; 8 seconds later the scores go back to zero. The admin can start a new round from the menu. Players in Explore mode can't be hurt. The server keeps the score and checks each reported hit (both players fighting and alive, fire rate, range).

**Zombies (party game):** everyone who fights (Action or Paintball) is one team round the main house and the bungalow. Alone, start it from the menu's Play tab; together, the admin starts it for everyone (Admin: party games). Both pick where (the last pick is kept): at home round the main house and the bungalow (starting at the bungalow is the same game from its side), or by a portal in Smetlede: the church square, Molenhoek, the middle of Molenhoek or its end. In Smetlede the game's edge is a circle of about 48 m round the place, kept inside the map, and the village's walls, hedges and fences are the zombies' walls. The church tower and roof walk stay open to zombies; the other village buildings stay shut. Not at the school, where nobody shoots. Everyone is gathered by the portal, facing it, and comes back there after a wave. The best wave is kept per place. The first wave comes after 8 seconds, the next one 15 seconds after a wave is beaten. Each wave is bigger, a little faster and a little tougher, and they never end; alone, your best wave is kept in the browser. The zombies come from every side, always out of sight, most of them 15 to 28 m away. They go for the nearest player who fights, round walls, fences, hedges and parked cars, and swipe when they are next to you (a wind-up you can step away from), never through a wall or a floor. There are five, our own Blender models (`tools/zombies.py`): a thin one in a torn shirt, a teen in a red hoodie, an old mechanic in overalls, a farmer in wellies, and a big one in a white vest. From wave 3 some of them run: always the hoodie, nearly as fast as you, with half the health. Every fifth wave brings big ones, slow and tough, who pound the ground round them. Together the houses are open: the zombies follow you in, up the stairs and the outside stair onto the roof terrace, shove a shut door open after a moment, and climb through a pane that was shot out. Alone the houses stay shut. Whoever stands where no zombie can reach for 2 seconds is warned, and out of the wave 10 seconds later. Who is down waits for the end of the wave, unless a teammate holds Use next to them for 3 seconds: they get up with half their health. When every fighter is down at once, the game is over. A beaten zombie sometimes leaves a reward, which glows where it fell for 45 seconds: a bigger ammo pack (magazines half as big again for the rest of the game), a scope for the rifle and the pistol, or a claymore (carry two; hold the grenade key to place one in front of you; it goes off when a zombie walks into its arc and never hurts a player). A big one also leaves a bundle of wooden stakes: four rows, eight carried at most. Hold reload to plant a row across where you look, a long step ahead. It is up to 1.8 m wide, as far as the floor goes on (a doorway takes fewer stakes). A zombie in a row wades through at about a third of its pace, a big one at 60%. Every zombie that comes into a row wears it: its stakes tip over one by one, and after ten zombies (a big one counts as four) it bursts in splinters. The zombies don't walk round a row, so it works best in a gate, a doorway or on a stair. A big one leaves a turret as well: carry one, hold Use where there is nothing else to use, and it goes up a step in front of you (one up per player, eight in all). After a second it turns to the nearest zombie it can see within 16 m and shoots it, 12 health every 0.3 s, about a sixth of a rifle. Its hits don't make a zombie flinch, so it never holds one still. It keeps to its zombie unless another comes much nearer. Its eye goes from green to amber to blinking red as its 100 rounds run out, and then it is gone. It never hurts a player. A sniper bullet goes on through the first zombie to a second one behind it ("Double!" in the kill feed). The zombies groan more often and louder the closer they are, from where they stand. In multiplayer the server runs the horde (`web/server/zombies.mjs`, `web/shared/zombies.mjs`): a grid of the ground and the houses' floors, a distance field from the players that the zombies walk down, and every hit, swipe, pickup and help decided there.

**Admin: choose a Zombies wave:** during an active multiplayer Zombies game, open Admin → Party games. Enter a wave from 1 to 9999 and choose **Switch now** (or press Enter). It immediately replaces the current zombies and queued spawns at the selected difficulty, higher or lower, without the usual break. Choosing the same number restarts that wave. Downed teammates come back through the usual revive flow; living players keep their health, and everyone keeps equipment and earned kills. The game continues to the next wave normally once it is beaten. The bar marks the run as custom: it does not replace the normal best-wave record. Start a new Zombies game to play for records again. The picker is available only to the connected admin while the game is active.

**Endless Zombies and reconnecting:** there is no wave limit, including at wave 16. The game continues while at least one fighter is standing. If both connections drop, the server keeps the game for 15 seconds so the players can reconnect. If the connected teammate is down while a live fighter is reconnecting, the bar says it is waiting for that teammate rather than ending the game immediately. The grace is tied to the existing sign-in, includes the first armed-state message after reconnecting, and does not revive a downed player. Abandoned empty games are cleaned up after the grace. The match lives in server memory; restarting or redeploying the server still resets it.

**Run the server locally:** `cd web`, `npm run build`, then start it with `ADMIN_PASSWORD` set and run `npm start`. Without `DATABASE_URL` it keeps users in `web/.data/` (not in git). During `npm run dev`, the login and multiplayer calls are forwarded to that server on port 8080.

## Rebuild the House Data

The square's grey paving follows the terrain grid and its diagonals in `world/houseMeshes.ts`. This keeps the thin layer of clinkers above the underlying lawn.

The village building models also carry their collision geometry. After changing a residential street footprint, rebuild it with `blender -b -P tools/molenhoek.py -- web/public/models/<street>.glb <street>`, using the same street identifier for both arguments.

For the school frontage, run `blender -b -P tools/school.py -- web/public/models/school.glb`. The bus shelter belongs to the square and rebuilds with `blender -b -P tools/town/town.py -- web/public/models/town.glb`. If the town builder reports a footprint mismatch after a village-data update, match the old polygon to its exact current outline before updating its index.

The village dormer house is a separate exterior. From the repository root, run `blender -b -P tools/dormer_house.py -- web/public/models/dormer_house.glb`. An optional second output path saves an editable Blender file.

The 3D blocks of the three locked homes are built by tools in the private companion repository (`yopazerbot/brieltje-private`, checked out at `private-src/`, git-ignored here). They write the public shell (`web/src/data/house_shell.json`, `molenhoek_end_shell.json`) and the private insides (`web/.private/`, sealed into `web/private/` by `tools/private_data.mjs`). To regenerate them:

```
tools/.venv/Scripts/python private-src/tools/<the private tool for the main house>.py   # see private-src/README.md
tools/.venv/Scripts/python private-src/tools/build_house.py
tools/.venv/Scripts/python private-src/tools/molenhoek_end_inside.py
node private-src/tools/private_extras.mjs
node tools/private_data.mjs seal
```

The page and the server run on the shell. A home's inside reaches a page only with the home's code (`POST /api/home/unlock`, then `GET /api/home/:id/inside`), see `web/src/world/insides.ts` and `web/server/insides.mjs`.

First time only, create the Python environment:

```
python -m venv tools/.venv
tools/.venv\Scripts\pip install -r tools/requirements.txt
```

Private source files are not in the repo; the tools that read them expect them in `source\` (git-ignored). Everything the game needs is already built into `web/src/data/` and `web/public/`.

### Rebuilding the eastward extension

The map follows roads, houses and alleys up to about 400 m geographically east of the original
ring and village. The game's axes are rotated: east is decreasing model x and z. The extension
keeps 55 m beside streets, 25 m beside footpaths and earth tracks, and gardens round their houses.
Only areas joined to the original map are built. It adds no crop fields; the existing field
detail stays in the original area. Relief supports the streets and buildings as elsewhere.

Install `tools/requirements.txt`, then run from the repository root (on Windows,
use `tools/.venv/Scripts/python` instead of `tools/.venv/bin/python`):

```
tools/.venv/bin/python tools/geodata.py           # first time only: the original open data
tools/.venv/bin/python tools/geodata.py --strip w # first time only: keep Molenhoek's western end
tools/.venv/bin/python tools/geodata.py --strip e # the additional 400 m by 2 km source strip
tools/.venv/bin/python tools/crops.py
tools/.venv/bin/python tools/neighbours.py
tools/.venv/bin/python tools/terrain.py
tools/.venv/bin/python tools/street.py
tools/.venv/bin/python private-src/tools/build_house.py
tools/.venv/bin/python tools/streets.py
tools/.venv/bin/python tools/roads.py
tools/.venv/bin/python tools/road_detail.py
tools/.venv/bin/python tools/bounds.py
tools/.venv/bin/python tools/places.py
```

The source downloads stay in the ignored `source/geo/` folder; commit the generated JSON
with the code so a fresh checkout can play the extension. The existing extracted house
data is enough: rebuilding the map does not need the private source files or Blender.
Only complete strips are stitched into the height rasters and orthophoto, by their geographic
position, with north at the top. Existing features win when a building or road crosses a download edge.
The eastern fields and tree budget are generated separately from the original area and
Molenhoek's band. `bounds.py` checks that every building, portal and spawn fits inside the
playable boundary; `places.py` chooses safe destinations on the expanded road network.

Run the strip and geographic direction checks with:

```
tools/.venv/bin/python -m unittest discover -s tools -p 'test_*.py'
```

### Southern homes and detailed house

The southern extension follows connecting streets and lanes to Oordegemkouter, with 80 additional
buildings and measured terrain. The pale-brick house's exterior and clipped front garden are a separate
Blender model, with shared garden collision for the browser and server. The house stays closed; unseen
side and rear details are interpretations. Use `/location Oordegemkouter` to reach the street.

The complete download and regeneration order is in [kouter-extension.md](kouter-extension.md). It adds
`geodata.py --strip w2` and `--strip s`. After `terrain.py` and before `build_house.py`, build the house:

```
blender -b -P tools/kouter_house.py -- web/public/models/kouter_house.glb data/kouter_house.json
```

The southern row activates only when all supporting strips are complete. Existing terrain heights stay
unchanged; no extra crop fields are generated. Check the Low preset and touch controls after rebuilding.

### Church roof access

The church's front doors open into the tower. An 84-step spiral stair hidden inside it reaches
the roof walk, 12.7 m above the church ground. The walk has three wider firing bays, low solid
cover and open upper rails. A steel rail follows the stair's exposed edge and guards the wider
upper landing. The belfry louvres on the exit face are removed so the doorway is clear. You can
walk up and back down without jumping or flying. It stays
open in solo play, multiplayer and Zombies at the church. Regular and big zombies use the same
stairs; standing above the route where they cannot reach still triggers the existing penalty.
This is a fictional maintenance route for the game, not a surveyed church interior.

`web/shared/church.json` holds the shared steps, rails, floor, cover and wall geometry. The browser,
server and zombie navigation use `web/shared/church.mjs` to place it on the church's ground.
The tower void cuts both brick and the visible slate roof, keeping the nave roof out of the stairs.
The church tests check the exported roof triangles as well as navigation.
The round zombie arena also clips its indoor grid, keeping its corners inside the boundary.
Rebuild the data and visible model from the repository root:

```
tools/.venv/bin/python tools/church_access.py
blender -b -P tools/church.py -- web/public/models/church.glb
```

Run the route, attack and zombie checks from `web/`:

```
node --test --test-isolation=none shared/church.test.mjs
```

## Street-house ground levels and outdoor finishes

`tools/building_ground.py` places ordinary house floors 5 cm above entrance terrain, rather than at the underground foot of a collision block. Explicit raised floors remain unchanged; shared-row threshold rules still run afterwards. Foundations sample the terrain along each wall. Regenerate with:

```
tools/.venv/Scripts/python.exe tools/molenhoek_survey.py
tools/.venv/Scripts/python.exe tools/molenhoek_end_survey.py
tools/.venv/Scripts/python.exe tools/kapellenhoek_survey.py
tools/.venv/Scripts/python.exe tools/molenhoek_end_inside.py
blender -b -t 2 -P tools/molenhoek.py -- web/public/models/molenhoek.glb molenhoek
blender -b -t 2 -P tools/molenhoek.py -- web/public/models/molenhoek_end1.glb molenhoek_end1
blender -b -t 2 -P tools/molenhoek.py -- web/public/models/molenhoek_end2.glb molenhoek_end2
blender -b -t 2 -P tools/molenhoek.py -- web/public/models/molenhoek_end3.glb molenhoek_end3
blender -b -t 2 -P tools/molenhoek.py -- web/public/models/kapellenhoek.glb kapellenhoek
```

Run `tools/.venv/Scripts/python.exe -m unittest discover -s tools -p 'test_*.py'` to check entrance levels and the terrain tools. Shared texture bump defaults live in `web/src/world/surfaceFinish.ts`; explicit material strengths override them. Road and paving margins reuse the path channel of the ground-shading bake at reduced strength, so no extra texture reads are added during play.

## Security regression checks

`server/constant-time-text.mjs` compares padded UTF-8 buffers using `timingSafeEqual`, then checks their original byte lengths. It replaces temporary SHA-256 text-comparison digests; the stored scrypt startup fingerprint and cookie formats are unchanged. `server/auth-security.test.mjs` checks login, tampered device signatures, restored sessions and rate limits with a random in-memory credential and store.

`src/world/network-state.test.mjs` exercises the actual state-update methods with prototype names and malformed indices, followed by normal valid updates. From `web/`, run:

```
node --test server/*.test.mjs shared/*.test.mjs src/world/network-state.test.mjs src/world/vegetation.test.mjs
```

## Vegetation and recent geometry repairs

Brieltje's public contact address is `yoshi@brieltje.be`, including both game translations and public-page mail links. The privacy regulator's complaint address is a separate third-party contact.

Shared tree shapes live in `web/src/world/vegetation.ts`: a connected canopy in full and simplified forms, and a tapered forked trunk. The existing instance batches, leaf texture, wind and seasonal shader are used. Near canopies have 980 triangles, far canopies 180 and the shared bark mesh 54. The separate lower-crown batch is gone. `surroundings.ts` places the trees and the smaller hedge clumps. Run `node --test src/world/vegetation.test.mjs` from `web/` to check seams, lighting normals and geometry budgets.

The detailed brick house's corrected plot is set by `CUBE_F`, `CUBE_T` and `CUBE_N` in `tools/molenhoek_end_survey.py`; its site work is confined to that plot. The misplaced model and its clearing overrides are removed. Regenerate the branch survey and `molenhoek_end2` and `molenhoek_end3` with the commands above.

The walk-in house's corner posts are generated by `corner_frame_parts()` in `tools/molenhoek_end_inside.py`, joining both adjacent frame end caps. Rerun that tool after changing the openings. `tools/test_house_location.py` checks the plot and restored old-site metadata; `tools/test_window_corners.py` checks full coverage of the generated corner join.

## Weapon timing

`web/src/world/shotRaycast.ts` builds spatial trees for static map meshes during village loading, yielding between meshes. Searches keep Three.js's exact triangle intersections and original face IDs, including current tile draw ranges. Vertex attributes are shared; the tree adds CPU bounds and triangle indices without extra draw calls. Animated, instanced, multi-material and custom-raycast meshes retain their own implementations. Run `node --test src/world/shotRaycast.test.mjs` in `web/` to compare hits, normals, texture coordinates, transforms and changing ranges.

Third-person hand posing lives in `web/src/net/grip.ts`, called after body animation in `swat.ts`. Each weapon defines wrist anchors in metres. Fingers use a sampled closed-hand shooting pose, wrists align with the gun's aiming frame, and placement is kept within both arms' reach. The corrections are restored before the next animation update so they never accumulate.

The frame advances the firing cooldown before checking the trigger. Held automatic fire retains at most 30 percent of the weapon's interval as timing credit, with at most one shot per frame. Releasing the trigger discards that credit. Extra spread is stored per weapon and decays while holstered; respawning clears it.

## Private data

The insides of the three locked homes live in the public repository as sealed files (`web/private/*.enc`). Only the production server can open them: its key is the Railway variable `PRIVATE_DATA_KEY`, not the admin password (see the DECISIONS row of 6 November 2026 and `web/server/privateCrypto.mjs` for the file format). Sealing needs no secret.

- Put the plain file in `web/.private/` (git-ignored), then `node tools/private_data.mjs seal` writes `web/private/<name>.enc` and updates `web/private/manifest.json`. Commit both. Unchanged files are skipped.
- After `PRIVATE_DATA_KEY` changes (the admin's Homes tab says "the insides can't be opened"), and after the first deploy: `node tools/private_data.mjs reseal --from https://brieltje.be`. It fetches the public key, stores it in `web/shared/private-key.json` and seals every file again. All plain files must be in `web/.private/`.
- `node tools/private_data.mjs status` shows what is sealed and whether the live key matches.
- On the server, `privateData.get(name)` returns a file's Buffer or null.

### Locking a new home

Every home that is in the game is private by default. For a new one:

1. Register it in `web/shared/homes.mjs` (`BANDS`: one ring for each floor and height range; its doors are found by their id prefix, and the inside's doors are registered from its pack). The registry is code, not admin data. `web/shared/homes.test.mjs` checks the ids.
2. Build its outside as a public shell and its inside as a private pack with the tools in the private repository (`private-src/`). The inside is written to `web/.private/`.
3. Seal it: `node tools/private_data.mjs seal`. Commit `web/private/<name>.enc` and `manifest.json`. Never commit the plain file. `web/shared/publicClean.test.mjs` fails on an inside in a public file.
4. After the deploy, open the admin's Homes tab and make a code for the home. It is shown once. Give it to the owner. The server keeps a scrypt hash only. Revoke it or make a new one there at any time.

### A sign-up's inside choice

A sign-up on the interest page that wants a house in the game carries `inside: 'private' | 'public'`. Missing means private. The admin's Interest tab shows it on each card ("Inside: private (locked with a code)" or "Inside: public (their choice)") and counts the public ones at the top.

- Private (the default): do step 3 and 4 above. The owner gets the code.
- Public: only when the owner ticked the separate confirmation. Then the inside may go into the public data. If the owner switches back to private through their own link (the card then shows private), seal the inside, take it out of the public files and make a code. Old commits keep the public copy.
- The owner changes the choice with `PATCH /api/interest/:id` (`{ inside: 'private' }` or `{ inside: 'public', confirm: true }`) and their own token. The privacy page says the same in English and Dutch ("Your home in the game").

## Folder Layout

`web/public/menu-theme.css` holds the panel, focus and selection styles shared by the game menus, admin and event pages.

| Folder | Contents |
|---|---|
| `docs\` | Inventory of the source material and the original handover brief |
| `source\` | Private source files (not in git) |
| `tools\` | Python scripts that build the 3D data |
| `data\` | Survey data of the streets, the neighbours and the garden |
| `web\` | The Vite + Three.js app, its generated house shell (`src\data\house_shell.json`) and the production server |

See `DECISIONS.md` for what we chose and why, and `PROGRESS.md` for status.
