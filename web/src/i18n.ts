/**
 * The game's two languages: English and Dutch (Belgian Dutch, Flemish usage, informal "je").
 *
 * Every text a player sees comes from here: `t(key, params)` for code, `data-i18n` attributes for
 * the static HTML (applied by `applyStatic`). The Dutch dictionary must have every English key with
 * the same {placeholders}, or `tsc` fails. Switching (`setLang`) takes effect at once: the static
 * HTML is filled again and every module that registered with `onLang` redraws its text, so
 * multiplayer keeps its connection.
 *
 * Messages from the server carry a code and its parameters next to their English text
 * (`serverText`): the page formats them in its own language, and falls back to the text for a code
 * it doesn't know (an older or newer server during a deploy).
 *
 * Names from the data (rooms, surfaces, doors, furniture, cars) have Dutch names in maps keyed by
 * their English name or id, with the data's own name as the fallback, so new data never breaks.
 *
 * Security (XSS): translated text is only ever put in the page as text (textContent, text nodes);
 * the few bold words in static strings (**...**) are built as elements. Player names and chat go in
 * as parameters and stay text.
 */

export type Lang = 'en' | 'nl';

const en = {
  // ---- The page, the HUD's fixed parts
  'page.title': 'Brieltje: Smetlede and Briel in 3D',
  'brand.wip': 'Work in progress',
  'hud.menu': 'Menu',
  'hud.captureHint': 'Click to look around',
  'score.title': 'Scoreboard',
  'credit.made': 'Made by Yoshi Parlevliet',
  'credit.source': 'The source code on GitHub',
  'chat.placeholder': 'Say something, Enter to send',
  'btn.map': 'Map (M)',
  'btn.mapAria': 'Open the map',
  'btn.soundTitle': 'Sound on or off (Shift+M)',
  'btn.sound': 'Sound',
  'btn.noSound': 'No sound',
  'btn.fullTitle': 'Fill the whole screen',
  'btn.full': 'Full screen',
  'btn.exitFull': 'Exit full screen',
  'full.hint': "On an iPhone a page can't fill the screen from Safari. Tap **Share**, then **Add to Home Screen**, and start Brieltje from your home screen: it opens without Safari's bars.",
  'rotate.hint': 'Turn your device sideways to play',
  'ctx.lost': 'This device ran out of graphics memory and the 3D view stopped. Reload the page to try again, with other apps and tabs closed, or have a look on a laptop.',
  // Short: it shares a start button with the percentage, and the house isn't all that loads.
  'load.house': 'Loading the world…',
  'load.progress': 'Loading the world…',
  'load.gfx': 'Testing your graphics',
  'load.failed': "The game didn't load. Reload the page to try again.",
  // The legal pages (web/public/legal/): the line under the start screen, and the short links
  'legal.accept': 'By playing you accept the',
  'legal.terms': 'terms of use',
  'legal.and': 'and the',
  'legal.privacy': 'privacy policy',
  'legal.credits': 'Credits',
  'legal.termsShort': 'Terms',
  'legal.privacyShort': 'Privacy',

  // ---- Language
  'lang.label': 'Language',
  // The keyboard's layout (src/keys.ts): the key names in the hints
  'kbd.label': 'Keyboard',
  'kbd.auto': 'Automatic',

  // ---- Start screen
  'start.sub': 'Work in progress',
  // The start screen's welcome, under the wordmark
  'start.intro': 'Welcome to Smetlede and Briel.',
  // The sign-up link under the start buttons (brieltje.be/interested): three short lines
  'start.invite': 'Play together in person?',
  'start.inviteHouse': 'Your own house can be in the game too.',
  'start.inviteGo': 'Sign up',
  'start.mobileNote': 'Best on a laptop or desktop. Hold your device sideways to play by touch.',
  'start.name': 'Your name',
  'start.namePh': 'Name',
  'start.alone': 'Alone',
  'start.aloneSub': 'Just you',
  'start.together': 'Together',
  'start.togetherSub': 'With the PIN',
  'start.pinPh': 'PIN',
  'start.join': 'Join',
  'start.pinHint': 'The organiser gives you the PIN.',
  'start.age13': "I'm 13 or older",
  'start.passPh': 'Admin password',
  'start.login': 'Log in',
  'start.playingAs': 'Playing together as',
  'start.leave': 'Play alone',
  'start.mode': 'Game mode',
  'start.with': 'Play with',
  'start.at': 'Start at',
  'start.admin': 'Admin',
  'mode.explore': 'Explore',
  'mode.exploreSub': 'Walk around',
  'mode.exploreSub2': 'No weapon',
  'mode.action': 'Action',
  'mode.actionSub': 'With a pistol · 12+',
  'mode.actionSub2': 'Hands and pistol · 12+',
  'mode.paintball': 'Paintball',
  'mode.paintballSub': 'With paint guns · for everyone',
  'mode.paintballSub2': 'Paint guns · for everyone',
  'mode.actionOff': 'Off · child-friendly for everyone',
  'mode.actionOffTitle': 'The admin has made the game child-friendly for everyone: Action plays as Paintball.',
  'choose.kbm': 'Keyboard and mouse',
  'choose.kbmSub': '{wasd} to walk, mouse to look',
  'choose.pad': 'Controller',
  'choose.touch': 'Touch screen',
  'choose.touchSub': 'A stick under your left thumb, buttons on the right',
  'pad.connect': 'DualSense: press any button to connect',
  'pad.connected': 'Connected: {name}',
  'guest': 'Guest',

  // ---- Graphics
  'gfx.label': 'Graphics',
  'gfx.title': 'Change the graphics (cycles through the settings)',
  'gfx.auto': 'Auto · {preset}',
  'gfx.testing': 'Auto · testing…',
  // Auto before the world has loaded: it tests the graphics as the last part of loading.
  'gfx.autoPlain': 'Auto',
  'gfx.chip': 'Graphics chip: {gpu}',
  'gfx.testFrame': ' · test frame {ms} ms',
  'gfx.fixed': ' · fixed choice',
  'gfx.low': 'Low',
  'gfx.medium': 'Medium',
  'gfx.high': 'High',
  'gfx.ultra': 'Ultra',

  // ---- The menu
  'menu.title': 'Menu',
  'menu.resume': 'Resume',
  'menu.meetup': 'Meet up in person',
  'menu.switchToKbm': 'Keyboard and mouse instead',
  'menu.switchToPad': 'Controller instead',
  'menu.who': '{name} · {control}',
  'tab.map': 'Map',
  'tab.play': 'Play',
  'tab.settings': 'Settings',
  'tab.controls': 'Controls',
  'tab.together': 'Together',
  'tab.admin': 'Admin',
  'play.speed': 'Walking speed',
  'play.switchSub': 'Change how you play',
  'play.house': 'House',
  'play.planner': 'Furniture planner',
  'play.plannerSub': 'Place, turn and move furniture',
  'play.repair': 'Repair windows',
  'play.repairSub': 'Every broken pane back in',
  'play.resetFurn': 'Reset furniture',
  'play.resetFurnSub': 'Back to the original layout',
  'set.picture': 'Picture and sound',
  'set.mousePad': 'Mouse and controller',
  'set.mouse': 'Mouse sensitivity',
  'set.stick': 'Controller look speed',
  'set.fov': 'Field of view',
  'set.invert': 'Invert look up / down',
  'set.vibration': 'Controller vibration',
  'set.minimap': 'Minimap',
  'set.fps': 'FPS counter',
  'set.volume': 'Volume',
  'set.langKbd': 'Language and keyboard',
  'set.advanced': 'Advanced',
  'set.baked': 'Baked lighting (test: light bounced between walls, faster on weak graphics)',
  'set.reset': 'Back to defaults',
  'tog.title': 'Playing together',
  'tog.team': 'Your team',
  'tog.leave': 'Leave, play alone',
  'tog.scores': 'Scores',
  'tog.noteTogether': 'You play together as {name}.',
  'tog.chatHow': '{key} to chat',
  'tog.scoresHow': '{key} for the scores',
  'tog.noteAlone': 'You are playing alone. Together you play in the same world as the others: you see each other, chat and play party games. Type your name and the PIN you were given.',
  'team.house': 'House',
  'team.bungalow': 'Bungalow',
  'lb.button': 'Leaderboard',
  'lb.sub': 'All-time totals',
  'lb.hide': 'Hide leaderboard',
  'lb.player': 'Player',
  'lb.kills': 'Kills',
  'lb.deaths': 'Deaths',
  'lb.kd': 'K/D',
  'lb.headshots': 'Headshots',
  'lb.wins': 'Rounds won',
  'lb.note': 'All rounds played so far, per account.',
  'lb.empty': 'No fights yet. Play a round in Action mode.',

  // ---- The admin's tab
  'adm.you': 'You',
  'adm.turbo': 'Move extremely fast (15 times, walking and flying)',
  'adm.rules': 'House rules',
  'adm.flying': 'Flying allowed',
  'adm.furniture': 'Players can use the furniture planner',
  'adm.names': 'Names above players (they show through walls)',
  'adm.portals': 'Portals take players from place to place',
  'adm.travel': 'Players can travel from the chat (/church, /house …)',
  'adm.paintball': 'Child-friendly for everyone: Action plays as Paintball',
  'adm.max': 'Players at once',
  'adm.joining': 'Joining',
  'adm.pin': 'New players can join with the PIN',
  'adm.pinLabel': 'PIN',
  'adm.show': 'Show',
  'adm.hide': 'Hide',
  'adm.save': 'Save',
  'adm.pinNote': '4 to 12 digits; longer is harder to guess. Saving logs out everyone who joined with the old PIN.',
  'adm.games': 'Party games',
  'adm.newRound': 'New round',
  'adm.newRoundSub': 'Fighting scores back to zero',
  'adm.clearFurn': 'Remove all furniture',
  'adm.clearFurnSure': 'Sure? Click again to remove it all',
  'adm.clearFurnSub': 'For everyone',
  'adm.people': 'People',
  'adm.unavailable': 'Admin data unavailable: {msg}',
  'adm.online': 'Online now: {n} of {max}',
  'adm.kick': 'Kick',
  'adm.kicked': '{name} removed for 10 minutes',
  'adm.showLog': 'Show login log',
  'adm.hideLog': 'Hide login log',
  'pin.saved': 'New PIN saved.',
  'pin.loggedOut.one': '1 player who joined with the old PIN was logged out.',
  'pin.loggedOut.other': '{n} players who joined with the old PIN were logged out.',
  'game.hide': 'Hide and seek',
  'game.hideSub': 'One seeks, the others hide; found players seek too',
  'game.tag': 'Tag',
  'game.tagSub': 'Whoever is "it" tags someone else; least time as "it" wins',
  'game.treasure': 'Treasure hunt',
  'game.treasureSub': '15 coins in and around the house; most coins wins',
  'game.teams': 'House against bungalow',
  'game.teamsSub': 'Two teams fight, each starts at its own house; first to 25 kills',
  'game.stop': 'Stop the game',
  'game.stopSub': 'Back to playing freely',

  // ---- Controls (the menu's Controls tab)
  'ctl.moving': 'Moving',
  'ctl.weapons': 'Weapons',
  'ctl.house': 'House',
  'ctl.planner': 'Furniture planner',
  'ctl.inPlanner': 'In the planner',
  'ctl.cars': 'Cars',
  'ctl.horses': 'Horses',
  'ctl.portals': 'Portals',
  'ctl.other': 'Other',
  'ctl.move': 'Move',
  'ctl.look': 'Look',
  'ctl.sprint': 'Sprint',
  'ctl.jump': 'Jump',
  'ctl.crouch': 'Crouch',
  'ctl.flyUp': 'Fly up (hold)',
  'ctl.flyDown': 'Fly down / land',
  'ctl.stopFlying': 'Stop flying',
  'ctl.shoot': 'Shoot (hold for the rifle)',
  'ctl.aim': 'Aim / sniper scope',
  'ctl.reload': 'Reload',
  'ctl.switchWeapon': 'Switch weapon',
  'ctl.grenade': 'Throw a grenade (two, each back after 15 s)',
  'ctl.pickUp': 'Pick up a weapon',
  'ctl.pickUpHow': 'Walk over it (rifle, shotgun, sniper rifle around the house)',
  'ctl.door': 'Open / close door',
  'ctl.getIn': 'Get in / out',
  'ctl.drive': 'Drive, brake, reverse',
  'ctl.steer': 'Steer',
  'ctl.handbrake': 'Handbrake',
  'ctl.pickPlace': 'Pick a place (standing on a portal)',
  'ctl.withCar': 'With the car',
  'ctl.withCarHow': 'Stop on the portal, then pick',
  'ctl.fromChat': 'From the chat (together)',
  'ctl.fromChatHow': '/church, /house, /bungalow, /school, /molenhoek',
  'ctl.getOn': 'Get on / off',
  'ctl.faster': 'Faster, slower',
  'ctl.gallop': 'Gallop',
  'ctl.menu': 'Menu (open / close)',
  'ctl.fps': 'FPS counter',
  'ctl.bigMap': 'Map (places, portals, waypoint)',
  'ctl.menuTabs': 'Menu tabs',
  'ctl.minimap': 'Minimap on / off',
  'ctl.walkSpeed': 'Walking speed',
  'ctl.graphics': 'Graphics',
  'ctl.chat': 'Chat (multiplayer)',
  'ctl.scoreboard': 'Scoreboard (multiplayer)',
  'ctl.sound': 'Sound on / off',
  'key.mouse': 'Mouse',
  'key.leftStick': 'Left stick',
  'key.rightStick': 'Right stick',
  'key.l3': '{key} (click the left stick)',
  'key.space': 'Space',
  'key.ctrlC': 'C',
  'key.leftClick': 'Left click',
  'key.rightClick': 'Right click',
  'key.weaponKeys': '1 to 4, mouse wheel, {q} for the last one',
  'key.weaponPad': 'D-pad up / down, L1',
  'key.bigMapKbm': '{key}, or click the minimap',
  'key.bigMapPad': 'Press the touchpad',
  'key.keyboardOnly': 'Keyboard only',
  'key.menuPlay': 'Menu, Play',
  'key.speedPad': 'D-pad left / right in the menu',
  'key.menuSettings': 'Menu, Settings',
  'key.squareInMenu': '□ in the menu',
  'key.hold': 'Hold {key}',
  'key.double': 'Double-tap {key}',
  'key.or': '{a} or {b}',
  'key.orSetting': '{key}, or in Settings',
  'key.holdTouchpad': 'Hold the touchpad',
  'key.soundKbm': '{key}, or 🔊 in the menu',
  'key.soundPad': '🔊 in the menu',
  'key.click': 'Click',
  // The touch controls' list
  'tctl.move': 'Left thumb: a stick appears where you touch',
  'tctl.look': 'Drag on the right side',
  'tctl.run': 'Run',
  'tctl.runHow': 'Run (tap again to walk)',
  'tctl.jump': 'Jump, fly up (hold)',
  'tctl.crouch': 'Crouch, fly down',
  'tctl.shoot': 'Shoot (drag to aim while holding)',
  'tctl.aimHow': 'Aim (on and off)',
  'tctl.grenade': 'Grenade',
  'tctl.nextWeapon': 'Next weapon',
  'tctl.start': 'Start',
  'tctl.startHow': 'Menu: Furniture planner',
  'tctl.place': 'Place, next piece, turn',
  'tctl.placeHow': 'Place, Next, Turn',
  'tctl.movePiece': 'Move or remove a piece',
  'tctl.movePieceHow': 'Move, Remove',
  'tctl.stop': 'Stop',
  'tctl.stopHow': 'Done (top left)',
  'tctl.thumbUpDown': 'Left thumb up / down',
  'tctl.thumbLeftRight': 'Left thumb left / right',
  'tctl.goElsewhere': 'Go somewhere else',
  'tctl.goElsewhereHow': 'Walk onto a portal, tap a place',
  'tctl.withCarHow': 'Stop on the portal, tap a place',
  'tctl.bigMap': 'Map',
  'tctl.bigMapHow': 'Tap the minimap',
  'tctl.soundFull': 'Sound, full screen',
  'tctl.soundFullHow': '🔊 in the menu, ⤢ top left',
  'tctl.best': 'Best experience',
  'tctl.bestHow': 'A laptop or desktop: bigger screen, keyboard and mouse or a controller',

  // ---- Touch buttons
  'touch.fire': 'Fire',
  'touch.place': 'Place',
  'touch.aim': 'Aim',
  'touch.move': 'Move',
  'touch.reload': 'Reload',
  'touch.turn': 'Turn',
  'touch.nade': 'Nade',
  'touch.next': 'Next',
  'touch.remove': 'Remove',
  'touch.done': 'Done',
  'touch.jump': 'Jump',
  'touch.brake': 'Brake',
  'touch.use': 'Use',
  'touch.down': 'Down',
  'touch.run': 'Run',

  // ---- HUD while playing
  'hud.pad': 'Controller: {name}',
  'hud.noPad': 'No controller found. Press a button on the DualSense to connect.',
  'hud.fps': '{fps} fps · {calls} draw calls · {quality} · {scale}% resolution',
  'hud.ping': ' · ping {ms} ms',
  'online.count': '{n} of {max} online',
  'online.you': '{name} (you)',
  'role.admin': '{name} (admin)',
  'place.outside': 'Outside',
  'prompt.open': '{key}  Open {door}',
  'prompt.close': '{key}  Close {door}',
  'prompt.driving': '{speed} km/h  ·  {use}  Get out',
  'prompt.tag': '{use}  Tag {name}',
  'prompt.riding': 'Riding with {name}  ·  {speed} km/h  ·  {use}  Get out',
  'prompt.nobody': 'nobody',
  'prompt.drive': '{use}  Drive {car}',
  'prompt.rideAlong': '{use}  Ride along with {name}',
  'prompt.carFull': '{a} and {b} are in {car}',
  'prompt.horse': '{speed} km/h  ·  {gallop} gallop (breath {breath}%)  ·  {jump} jump  ·  {use}  Get off',
  'prompt.mount': '{use}  Ride the horse',
  'prompt.horsePortal': 'Get off the horse to use the portal',
  'prompt.portalsOff': 'The admin has turned the portals off',
  'prompt.fly': 'Flying · hold {up} up, {down} down',
  'prompt.noShoot': 'School grounds · no shooting here',
  'prompt.locked': 'Only accessible in multiplayer.\nWant to look around solo? Contact Yoshi at yoshi@olive-security.be',
  'fb.title': 'Enjoying Brieltje?',
  'fb.sub': 'A quick rating helps Yoshi. Everything here is optional.',
  'fb.stars': 'Your rating',
  'fb.star.one': '{n} star',
  'fb.star.other': '{n} stars',
  'fb.comment': 'Anything you want to say? (optional)',
  'fb.commentAria': 'Comment',
  'fb.later': 'No thanks',
  'fb.send': 'Send',
  'fb.privacy': 'Privacy',
  'fb.thanks': 'Thank you!',
  'fb.error': "Sending didn't work. Try again, or close this.",
  'fb.close': 'Close',
  'fb.tooMany': "Thanks! That's enough for now. Try again in an hour.",
  'menu.feedback': 'Feedback',
  'menu.feedbackTitle': 'Tell Yoshi what you think',
  'weapon.pistol': 'Pistol',
  'weapon.rifle': 'Rifle',
  'weapon.shotgun': 'Shotgun',
  'weapon.sniper': 'Sniper',
  'weapon.bazooka': 'Bazooka',
  'weapon.grenade': 'Grenade',
  'weapon.reloading': 'Reloading…',
  'char.you': 'You',
  'char.cat': 'a cat',
  'char.clown': 'a clown',
  'char.strongman': 'a strongman',
  'combat.killedBy': 'Killed by {name}',
  'combat.headshot': 'Headshot · ',
  'combat.headshotTag': 'HEADSHOT',
  'combat.youWin': 'You win the round!',
  'combat.wins': '{name} wins the round',
  'combat.nextRound': 'Back at the start of the next round',
  'combat.backIn': 'Back in {n}',
  'combat.respawning': 'Respawning…',
  'combat.newRoundIn': 'New round in {n}',
  'combat.goal': 'First to {n} kills wins the round · kill 100 · headshot +50',
  'combat.player': 'Player',
  'combat.kills': 'Kills',
  'combat.deaths': 'Deaths',
  'combat.points': 'Points',
  'combat.exploring': 'exploring',
  'combat.dead': 'dead',
  // Paintball (src/paintball.ts): the same fight in friendly words
  'paint.pistol': 'Paint pistol',
  'paint.rifle': 'Paint rifle',
  'paint.shotgun': 'Splat gun',
  'paint.sniper': 'Paint sniper',
  'paint.bazooka': 'Paint cannon',
  'paint.grenade': 'Paint balloon',
  'paint.refilling': 'Refilling paint…',
  'paint.taggedBy': 'You got tagged by {name}!',
  'paint.backIn': 'Back in {n}…',
  'paint.bullseye': 'Bullseye · ',
  'paint.bullseyeTag': 'BULLSEYE',
  'paint.tagged': 'tagged',
  'paint.splattered': 'splattered',
  'paint.you': 'you',
  'paint.goal': 'First to tag {n} times wins the round · tag 100 · bullseye +50',
  'paint.tags': 'Tags',
  'paint.taggedCol': 'Tagged',
  'paint.out': 'tagged',
  'paint.ratio': 'Ratio',
  'paint.bullseyes': 'Bullseyes',
  'paint.lbEmpty': 'No rounds yet. Play a round of paintball.',
  'games.teamCount.one': '1 playing, start at {place}',
  'games.teamCount.other': '{n} playing, start at {place}',
  'games.atHouse': 'the house',
  'games.atBungalow': 'the bungalow',
  'games.blind': 'You seek. Eyes shut while the others hide… {n}',
  'games.youSeekHide': 'You seek: count with your eyes shut',
  'games.hide.one': 'Hide! {names} will seek',
  'games.hide.other': 'Hide! {names} will seek',
  'games.youSeek': 'You seek: find the others and tag them (E)',
  'games.stayHidden': 'Stay hidden',
  'games.teamsLine': 'House {h} – {b} Bungalow · first to {goal} · you: {team}',
  'games.youreIt': "You're it! Tag someone (E) · your time {n} s",
  'games.isIt': '{name} is it · your time {n} s',
  'games.coins': '{n} coins left · you {mine}',
  'games.best': ' · best {name} {n}',

  // ---- Chat lines made here
  'chat.furnOff': 'The admin has turned the furniture planner off.',
  'chat.travelHelp': 'Travel with {list}, or walk onto a portal.',
  'chat.notDown': 'Not while you are down.',
  'chat.joinedAs': 'Joined the house as {name}. {n} of {max} online.',
  'chat.joined': '{name} joined',
  'chat.left': '{name} left',
  'chat.repaired': '{name} repaired the windows',
  'chat.furnReset': '{name} put the furniture back in its original layout',
  'chat.furnCleared': '{name} removed all furniture',

  // ---- Joining, logging in, the connection
  'err.nameFirst': 'Type your name first.',
  'err.password': 'Type the admin password.',
  'err.pin': 'Type the PIN.',
  'err.age': "Tick that you're 13 or older to play together.",
  'err.status': 'Error {n}',
  'net.connecting': 'Connecting…',
  'net.lost': 'Connection lost, reconnecting…',
  'net.elsewhere': 'Logged in somewhere else.',
  'net.removed': 'You were removed by the admin.',
  'net.ended': 'Your session ended. Log in again.',
  'net.reload': 'The game has been updated. Reload the page to keep playing together.',

  // ---- Portals and travelling
  'portal.house': "Yoshi & Liesl's home",
  'portal.bungalow': 'Bungalow',
  'portal.church': 'Church',
  'portal.school': 'School',
  'portal.molenhoek': 'Molenhoek',
  'travel.portal': 'Portal',
  'travel.here': 'you are here',
  'travel.back': 'back',
  'travel.pickPad': 'D-pad ↑↓ and {use}',
  'travel.pickTouch': 'Tap a place',
  'travel.pickKbm': '1–{n}, or the wheel and {use}',
  'travel.walkOff': '{pick} · walk off to stay',
  'travel.driveOn': '{pick} · drive on to stay · the car comes along',
  'travel.village': 'loading the village',

  // ---- The map (the menu's first tab)
  'map.zoomIn': 'Zoom in',
  'map.zoomOut': 'Zoom out',
  'map.where': 'Where you are',
  'map.whole': 'The whole map',
  'map.you': 'You',
  'map.portal': 'Portal',
  'map.players': 'Players',
  'map.waypoint': 'Waypoint',
  'map.helpTouch': 'Drag to move · pinch to zoom · tap a place, or tap anywhere for a waypoint',
  'map.helpKbm': 'Drag or {move} to move · wheel to zoom · click a place, or anywhere for a waypoint · {map} or {menu}: back to the game',
  'map.helpPad': 'Left stick to move · R2/L2 to zoom · ✕ sets a waypoint at the cross · {tabs} for the other tabs · {menu} or ○: back to the game',
  'map.byRoad': '{d} by road · the minimap shows the way',
  'map.fromYouWay': '{d} from you · the minimap shows the way',
  'map.placeSub': '{sub} · {d} from you',
  'map.remove': 'Remove',
  'map.directions': 'Directions',
  'map.portalNote': 'A portal stands here: walk onto any portal to come straight here.',
  'map.pond': 'Pond',
  'map.north': 'N',
  'place.house': "Yoshi & Liesl's home",
  'place.bungalow': 'Bungalow',
  'place.church': 'Sint-Pharaïldis church',
  'place.school': 'Primary school',
  'place.molenhoek': 'Molenhoek',
  'place.square': 'Church square',
  'place.horses': 'Horses',
  'place.horsesSub': 'the meadow across the road',

  // ---- The furniture planner
  'plan.moving': 'Moving: {name}',
  'plan.size': '{w} × {d} cm, {h} cm high · {i} of {n}',
  'plan.keys': 'Click place · wheel change · {turn} turn · right click pick up · {remove} remove · {stop} stop',
  'plan.keysPad': 'R2 place · L1/R1 change · {turn} turn · L2 pick up · {remove} remove',
  'plan.clown': 'Clown (walks around, can be shot)',
  'plan.strongman': 'Strongman, a giant (walks around, can be shot)',

  // ---- Messages from the server, by code (the server sends the same English text along)
  'srv.kicked': '{name} was removed by the admin',
  'srv.rules': '{name} turned {list}',
  'srv.newRoundBy': '{name} started a new round',
  'srv.newRound': 'New round: first to {n} kills',
  'srv.travelChatOff': 'The admin has turned travelling from the chat off. Walk to a portal.',
  'srv.travelPortalsOff': 'The admin has turned the portals off.',
  'srv.travelDriverOnly': 'Only the driver can take the car through.',
  'srv.travelHorse': 'Get off the horse first.',
  'srv.teamWait': 'Switch teams at full health (at most every 15 seconds), or while you wait to come back',
  'srv.teamJoined': '{name} joined team {team}',
  'srv.teamWon': 'Team {team} wins, {house} to {bungalow}',
  'srv.gameStopped': '{name} stopped the game',
  'srv.needTwo': '{kind} needs at least two players',
  'srv.hideStarted': '{name} started hide and seek: {seeker} seeks. Hide! (30 seconds)',
  'srv.teamsStarted': '{name} started House against bungalow: first team to {n} kills. Switch teams in the menu (Together).',
  'srv.tagStarted': '{name} started tag: {it} is it. The least time as "it" wins.',
  'srv.huntStarted': '{name} started a treasure hunt: {n} coins in and around the house',
  'srv.found': '{name} found {target}',
  'srv.foundLeft': '{name} found {target} ({n} still hidden)',
  'srv.foundAll': 'The seekers found everyone!',
  'srv.tagged': '{name} tagged {target}: {target} is it',
  'srv.huntWon.one': '{names} found the most coins ({n})',
  'srv.huntWon.other': '{names} found the most coins ({n})',
  'srv.huntNone': 'Nobody found a coin',
  'srv.seekerLeft': 'The seeker left: the hiders win',
  'srv.notEnough': 'Not enough players',
  'srv.itLeft': '{name} left: {it} is it',
  'srv.teamsDraw': "Time's up: a draw, {house} to {bungalow}",
  'srv.teamsTime': "Time's up: team {team} wins, {house} to {bungalow}",
  'srv.ready': 'Ready or not, here {name} comes!',
  'srv.hiddenWin.one': "Time's up: {names} stayed hidden and wins",
  'srv.hiddenWin.other': "Time's up: {names} stayed hidden and win",
  'srv.tagWon': '{name} wins: only {n} s as "it"',
  'srv.nobodyPlayed': 'Nobody played',
  'srv.tooMany': 'Too many attempts. Try again in 15 minutes.',
  'srv.nameFormat': 'Your name: 2 to 20 characters, letters, digits, - or _.',
  'srv.wrongPassword': 'Wrong password.',
  'srv.removed': 'You were removed by the admin. Try again later.',
  'srv.nameInUse': '{name} is in use by a player. Pick another name.',
  'srv.pinOff': 'Joining with the PIN is switched off right now.',
  'srv.age': "Tick that you're 13 or older to play together.",
  'srv.pinTooMany': 'Too many wrong PINs lately. Try again in an hour.',
  'srv.wrongPin': 'Wrong PIN.',
  'srv.nameTaken': 'That name is taken. Pick another name.',
  'srv.nameOnline': 'Someone is playing as {name} right now. Pick another name.',
  'srv.nameToday': '{name} is taken today (a name stays with whoever joined with it). Pick another name.',
  'srv.pinChanged': 'The PIN has just been changed. Ask for the new one.',
  'srv.pinFormat': 'The PIN: 4 to 12 digits.',
  'srv.notLoggedIn': 'Not logged in',
  'srv.adminOnly': 'Admin only',
  'srv.pickAnother': 'Pick another player',
  'srv.notFound': 'Not found',
  // The house rules, for 'srv.rules'
  'rule.flying': 'flying',
  'rule.furniture': 'moving furniture',
  'rule.names': 'names above players',
  'rule.pin': 'joining with the PIN',
  'rule.portals': 'the portals',
  'rule.travel': 'travelling from the chat',
  'rule.paintball': 'child-friendly for everyone',
  'rule.on': '{rule} on',
  'rule.off': '{rule} off',
  'rule.max': 'the limit to {n} players',
  'list.and': '{a} and {b}',
} as const;

export type Key = keyof typeof en;

const nl = {
  // ---- The page, the HUD's fixed parts
  'page.title': 'Brieltje: Smetlede en Briel in 3D',
  'brand.wip': 'In aanbouw',
  'hud.menu': 'Menu',
  'hud.captureHint': 'Klik om rond te kijken',
  'score.title': 'Scorebord',
  'credit.made': 'Gemaakt door Yoshi Parlevliet',
  'credit.source': 'De broncode op GitHub',
  'chat.placeholder': 'Zeg iets, Enter om te versturen',
  'btn.map': 'Kaart (M)',
  'btn.mapAria': 'Open de kaart',
  'btn.soundTitle': 'Geluid aan of uit (Shift+M)',
  'btn.sound': 'Geluid',
  'btn.noSound': 'Geen geluid',
  'btn.fullTitle': 'Vul het hele scherm',
  'btn.full': 'Volledig scherm',
  'btn.exitFull': 'Volledig scherm uit',
  'full.hint': 'Op een iPhone kan een pagina in Safari niet het hele scherm vullen. Tik op **Deel**, dan op **Zet op beginscherm**, en start Brieltje vanaf je beginscherm: zo opent het zonder de balken van Safari.',
  'rotate.hint': 'Draai je toestel een kwartslag om te spelen',
  'ctx.lost': 'Dit toestel heeft geen grafisch geheugen meer en het 3D-beeld is gestopt. Herlaad de pagina om het opnieuw te proberen, met andere apps en tabbladen dicht, of kijk eens op een laptop.',
  'load.house': 'Wereld laden…',
  'load.progress': 'Wereld laden…',
  'load.gfx': 'Je grafische kaart wordt getest',
  'load.failed': 'Het spel is niet geladen. Herlaad de pagina om het opnieuw te proberen.',
  'legal.accept': 'Door te spelen aanvaard je de',
  'legal.terms': 'gebruiksvoorwaarden',
  'legal.and': 'en het',
  'legal.privacy': 'privacybeleid',
  'legal.credits': 'Credits',
  'legal.termsShort': 'Voorwaarden',
  'legal.privacyShort': 'Privacy',

  // ---- Language
  'lang.label': 'Taal',
  'kbd.label': 'Toetsenbord',
  'kbd.auto': 'Automatisch',

  // ---- Start screen
  'start.sub': 'In aanbouw',
  'start.intro': 'Welkom in Smetlede en Briel.',
  'start.invite': 'Samen spelen in het echt?',
  'start.inviteHouse': 'Ook je eigen huis kan in het spel.',
  'start.inviteGo': 'Schrijf je in',
  'start.mobileNote': 'Het best op een laptop of computer. Houd je toestel liggend om met aanraakbediening te spelen.',
  'start.name': 'Je naam',
  'start.namePh': 'Naam',
  'start.alone': 'Alleen',
  'start.aloneSub': 'Enkel jij',
  'start.together': 'Samen',
  'start.togetherSub': 'Met de pincode',
  'start.pinPh': 'Pincode',
  'start.join': 'Meedoen',
  'start.pinHint': 'De pincode krijg je van de organisator.',
  'start.age13': 'Ik ben 13 jaar of ouder',
  'start.passPh': 'Wachtwoord beheerder',
  'start.login': 'Aanmelden',
  'start.playingAs': 'Je speelt samen als',
  'start.leave': 'Alleen spelen',
  'start.mode': 'Spelmodus',
  'start.with': 'Speel met',
  'start.at': 'Begin bij',
  'start.admin': 'Beheer',
  'mode.explore': 'Verkennen',
  'mode.exploreSub': 'Rondwandelen',
  'mode.exploreSub2': 'Zonder wapen',
  'mode.action': 'Actie',
  'mode.actionSub': 'Met een pistool · 12+',
  'mode.actionSub2': 'Handen en pistool · 12+',
  'mode.paintball': 'Verfballen',
  'mode.paintballSub': 'Met verfpistolen · voor iedereen',
  'mode.paintballSub2': 'Verfpistolen · voor iedereen',
  'mode.actionOff': 'Uit · kindvriendelijk voor iedereen',
  'mode.actionOffTitle': 'De beheerder heeft het spel kindvriendelijk gemaakt voor iedereen: Actie speelt als Verfballen.',
  'choose.kbm': 'Toetsenbord en muis',
  'choose.kbmSub': '{wasd} om te lopen, de muis om rond te kijken',
  'choose.pad': 'Controller',
  'choose.touch': 'Aanraakscherm',
  'choose.touchSub': 'Een stick onder je linkerduim, knoppen rechts',
  'pad.connect': 'DualSense: druk op een knop om te verbinden',
  'pad.connected': 'Verbonden: {name}',
  'guest': 'Gast',

  // ---- Graphics
  'gfx.label': 'Beeldkwaliteit',
  'gfx.title': 'Beeldkwaliteit wijzigen (telkens de volgende instelling)',
  'gfx.auto': 'Auto · {preset}',
  'gfx.testing': 'Auto · aan het testen…',
  'gfx.autoPlain': 'Auto',
  'gfx.chip': 'Grafische chip: {gpu}',
  'gfx.testFrame': ' · testbeeld {ms} ms',
  'gfx.fixed': ' · vaste keuze',
  'gfx.low': 'Laag',
  'gfx.medium': 'Gemiddeld',
  'gfx.high': 'Hoog',
  'gfx.ultra': 'Ultra',

  // ---- The menu
  'menu.title': 'Menu',
  'menu.resume': 'Verder spelen',
  'menu.meetup': 'Samen spelen in het echt',
  'menu.switchToKbm': 'Liever toetsenbord en muis',
  'menu.switchToPad': 'Liever een controller',
  'menu.who': '{name} · {control}',
  'tab.map': 'Kaart',
  'tab.play': 'Spelen',
  'tab.settings': 'Instellingen',
  'tab.controls': 'Besturing',
  'tab.together': 'Samen',
  'tab.admin': 'Beheer',
  'play.speed': 'Wandelsnelheid',
  'play.switchSub': 'Kies hoe je speelt',
  'play.house': 'Huis',
  'play.planner': 'Meubelplanner',
  'play.plannerSub': 'Meubels plaatsen, draaien en verzetten',
  'play.repair': 'Ramen herstellen',
  'play.repairSub': 'Elke gebroken ruit terug op zijn plaats',
  'play.resetFurn': 'Meubels terugzetten',
  'play.resetFurnSub': 'Terug naar de oorspronkelijke opstelling',
  'set.picture': 'Beeld en geluid',
  'set.mousePad': 'Muis en controller',
  'set.mouse': 'Muisgevoeligheid',
  'set.stick': 'Kijksnelheid controller',
  'set.fov': 'Gezichtsveld',
  'set.invert': 'Omhoog en omlaag kijken omkeren',
  'set.vibration': 'Controller laten trillen',
  'set.minimap': 'Minikaart',
  'set.fps': 'FPS-teller',
  'set.volume': 'Volume',
  'set.langKbd': 'Taal en toetsenbord',
  'set.advanced': 'Geavanceerd',
  'set.baked': 'Vooraf berekend licht (test: licht dat tussen de muren weerkaatst, sneller op een zwakke grafische kaart)',
  'set.reset': 'Terug naar de standaardwaarden',
  'tog.title': 'Samen spelen',
  'tog.team': 'Jouw team',
  'tog.leave': 'Stoppen en alleen spelen',
  'tog.scores': 'Scores',
  'tog.noteTogether': 'Je speelt samen als {name}.',
  'tog.chatHow': '{key} om te chatten',
  'tog.scoresHow': '{key} voor de scores',
  'tog.noteAlone': 'Je speelt alleen. Samen speel je in dezelfde wereld als de anderen: je ziet elkaar, je kunt chatten en partyspelletjes spelen. Typ je naam en de pincode die je kreeg.',
  'team.house': 'Huis',
  'team.bungalow': 'Bungalow',
  'lb.button': 'Klassement',
  'lb.sub': 'Alle rondes ooit samengeteld',
  'lb.hide': 'Klassement verbergen',
  'lb.player': 'Speler',
  'lb.kills': 'Kills',
  'lb.deaths': 'Gestorven',
  'lb.kd': 'K/D',
  'lb.headshots': 'Headshots',
  'lb.wins': 'Rondes gewonnen',
  'lb.note': 'Alle rondes tot nu toe, per account.',
  'lb.empty': 'Nog geen gevechten. Speel een ronde in Actie.',

  // ---- The admin's tab
  'adm.you': 'Jij',
  'adm.turbo': 'Extreem snel bewegen (15 keer zo snel, wandelen en vliegen)',
  'adm.rules': 'Huisregels',
  'adm.flying': 'Vliegen toegestaan',
  'adm.furniture': 'Spelers mogen de meubelplanner gebruiken',
  'adm.names': 'Namen boven spelers (zichtbaar door muren heen)',
  'adm.portals': 'Portalen brengen spelers van plaats naar plaats',
  'adm.travel': 'Spelers mogen reizen via de chat (/kerk, /huis …)',
  'adm.paintball': 'Kindvriendelijk voor iedereen: Actie speelt als Verfballen',
  'adm.max': 'Spelers tegelijk',
  'adm.joining': 'Meedoen',
  'adm.pin': 'Nieuwe spelers mogen meedoen met de pincode',
  'adm.pinLabel': 'Pincode',
  'adm.show': 'Toon',
  'adm.hide': 'Verberg',
  'adm.save': 'Bewaar',
  'adm.pinNote': '4 tot 12 cijfers; hoe langer, hoe moeilijker te raden. Bewaren meldt iedereen af die met de oude pincode meedeed.',
  'adm.games': 'Groepsspelletjes',
  'adm.newRound': 'Nieuwe ronde',
  'adm.newRoundSub': 'Gevechtsscores terug op nul',
  'adm.clearFurn': 'Alle meubels weghalen',
  'adm.clearFurnSure': 'Zeker? Klik nog eens om alles weg te halen',
  'adm.clearFurnSub': 'Voor iedereen',
  'adm.people': 'Spelers',
  'adm.unavailable': 'Beheergegevens niet beschikbaar: {msg}',
  'adm.online': 'Nu online: {n} van {max}',
  'adm.kick': 'Verwijder',
  'adm.kicked': '{name} is voor 10 minuten verwijderd',
  'adm.showLog': 'Aanmeldingen tonen',
  'adm.hideLog': 'Aanmeldingen verbergen',
  'pin.saved': 'Nieuwe pincode bewaard.',
  'pin.loggedOut.one': '1 speler die met de oude pincode meedeed, is afgemeld.',
  'pin.loggedOut.other': '{n} spelers die met de oude pincode meededen, zijn afgemeld.',
  'game.hide': 'Verstoppertje',
  'game.hideSub': 'Eén zoekt, de anderen verstoppen zich; wie gevonden is, zoekt mee',
  'game.tag': 'Tikkertje',
  'game.tagSub': 'De tikker tikt iemand anders; wie het kortst tikker was, wint',
  'game.treasure': 'Schattenjacht',
  'game.treasureSub': '15 munten in en rond het huis; wie de meeste vindt, wint',
  'game.teams': 'Huis tegen bungalow',
  'game.teamsSub': 'Twee teams vechten, elk start bij zijn eigen huis; het eerste team aan 25 kills wint',
  'game.stop': 'Spel stoppen',
  'game.stopSub': 'Terug naar vrij spelen',

  // ---- Controls (the menu's Controls tab)
  'ctl.moving': 'Bewegen',
  'ctl.weapons': 'Wapens',
  'ctl.house': 'Huis',
  'ctl.planner': 'Meubelplanner',
  'ctl.inPlanner': 'In de planner',
  'ctl.cars': "Auto's",
  'ctl.horses': 'Paarden',
  'ctl.portals': 'Portalen',
  'ctl.other': 'Overig',
  'ctl.move': 'Lopen',
  'ctl.look': 'Rondkijken',
  'ctl.sprint': 'Sprinten',
  'ctl.jump': 'Springen',
  'ctl.crouch': 'Bukken',
  'ctl.flyUp': 'Opstijgen (ingedrukt houden)',
  'ctl.flyDown': 'Dalen / landen',
  'ctl.stopFlying': 'Stoppen met vliegen',
  'ctl.shoot': 'Schieten (ingedrukt houden bij het geweer)',
  'ctl.aim': 'Richten / vizier van de sniper',
  'ctl.reload': 'Herladen',
  'ctl.switchWeapon': 'Ander wapen',
  'ctl.grenade': 'Granaat gooien (twee, elk na 15 s terug)',
  'ctl.pickUp': 'Wapen oprapen',
  'ctl.pickUpHow': 'Loop erover (geweer, jachtgeweer en sniper rond het huis)',
  'ctl.door': 'Deur openen / sluiten',
  'ctl.getIn': 'Instappen / uitstappen',
  'ctl.drive': 'Rijden, remmen, achteruit',
  'ctl.steer': 'Sturen',
  'ctl.handbrake': 'Handrem',
  'ctl.pickPlace': 'Kies een plaats (op een portaal)',
  'ctl.withCar': 'Met de auto',
  'ctl.withCarHow': 'Stop op het portaal en kies',
  'ctl.fromChat': 'Via de chat (samen)',
  'ctl.fromChatHow': '/kerk, /huis, /bungalow, /school, /molenhoek',
  'ctl.getOn': 'Opstappen / afstappen',
  'ctl.faster': 'Sneller, trager',
  'ctl.gallop': 'Galopperen',
  'ctl.menu': 'Menu (openen / sluiten)',
  'ctl.fps': 'FPS-teller',
  'ctl.bigMap': 'Kaart (plaatsen, portalen, bestemming)',
  'ctl.menuTabs': 'Tabbladen in het menu',
  'ctl.minimap': 'Minikaart aan / uit',
  'ctl.walkSpeed': 'Wandelsnelheid',
  'ctl.graphics': 'Beeldkwaliteit',
  'ctl.chat': 'Chat (samen)',
  'ctl.scoreboard': 'Scorebord (samen)',
  'ctl.sound': 'Geluid aan / uit',
  'key.mouse': 'Muis',
  'key.leftStick': 'Linkerstick',
  'key.rightStick': 'Rechterstick',
  'key.l3': '{key} (druk de linkerstick in)',
  'key.space': 'Spatie',
  'key.ctrlC': 'C',
  'key.leftClick': 'Linkermuisknop',
  'key.rightClick': 'Rechtermuisknop',
  'key.weaponKeys': '1 tot 4, scrollwiel, {q} voor het vorige',
  'key.weaponPad': 'D-pad omhoog / omlaag, L1',
  'key.bigMapKbm': '{key}, of klik op de minikaart',
  'key.bigMapPad': 'Druk op de touchpad',
  'key.keyboardOnly': 'Enkel met het toetsenbord',
  'key.menuPlay': 'Menu, Spelen',
  'key.speedPad': 'D-pad links / rechts in het menu',
  'key.menuSettings': 'Menu, Instellingen',
  'key.squareInMenu': '□ in het menu',
  'key.hold': '{key} ingedrukt houden',
  'key.double': 'Twee keer kort op {key}',
  'key.or': '{a} of {b}',
  'key.orSetting': '{key}, of in Instellingen',
  'key.holdTouchpad': 'De touchpad ingedrukt houden',
  'key.soundKbm': '{key}, of 🔊 in het menu',
  'key.soundPad': '🔊 in het menu',
  'key.click': 'Klik',
  // The touch controls' list
  'tctl.move': 'Linkerduim: er verschijnt een stick waar je het scherm raakt',
  'tctl.look': 'Sleep aan de rechterkant',
  'tctl.run': 'Rennen',
  'tctl.runHow': 'Ren (tik nog eens om te wandelen)',
  'tctl.jump': 'Springen, opstijgen (ingedrukt houden)',
  'tctl.crouch': 'Bukken, dalen',
  'tctl.shoot': 'Schieten (houd vast en sleep om te richten)',
  'tctl.aimHow': 'Richt (aan en uit)',
  'tctl.grenade': 'Granaat gooien',
  'tctl.nextWeapon': 'Volgend wapen',
  'tctl.start': 'Starten',
  'tctl.startHow': 'Menu: Meubelplanner',
  'tctl.place': 'Neerzetten, ander stuk, draaien',
  'tctl.placeHow': 'Zet, Wissel, Draai',
  'tctl.movePiece': 'Een stuk verzetten of weghalen',
  'tctl.movePieceHow': 'Verzet, Weg',
  'tctl.stop': 'Stoppen',
  'tctl.stopHow': 'Klaar (linksboven)',
  'tctl.thumbUpDown': 'Linkerduim omhoog / omlaag',
  'tctl.thumbLeftRight': 'Linkerduim links / rechts',
  'tctl.goElsewhere': 'Naar een andere plaats',
  'tctl.goElsewhereHow': 'Stap op een portaal, tik op een plaats',
  'tctl.withCarHow': 'Stop op het portaal, tik op een plaats',
  'tctl.bigMap': 'Kaart',
  'tctl.bigMapHow': 'Tik op de minikaart',
  'tctl.soundFull': 'Geluid, volledig scherm',
  'tctl.soundFullHow': '🔊 in het menu, ⤢ linksboven',
  'tctl.best': 'Beste ervaring',
  'tctl.bestHow': 'Een laptop of desktop: groter scherm, toetsenbord en muis of een controller',

  // ---- Touch buttons
  'touch.fire': 'Vuur',
  'touch.place': 'Zet',
  'touch.aim': 'Richt',
  'touch.move': 'Verzet',
  'touch.reload': 'Herlaad',
  'touch.turn': 'Draai',
  'touch.nade': 'Granaat',
  'touch.next': 'Wissel',
  'touch.remove': 'Weg',
  'touch.done': 'Klaar',
  'touch.jump': 'Spring',
  'touch.brake': 'Rem',
  'touch.use': 'Gebruik',
  'touch.down': 'Omlaag',
  'touch.run': 'Ren',

  // ---- HUD while playing
  'hud.pad': 'Controller: {name}',
  'hud.noPad': 'Geen controller gevonden. Druk op een knop van de DualSense om te verbinden.',
  'hud.fps': '{fps} fps · {calls} draw calls · {quality} · resolutie {scale}%',
  'hud.ping': ' · ping {ms} ms',
  'online.count': '{n} van {max} online',
  'online.you': '{name} (jij)',
  'role.admin': '{name} (beheerder)',
  'place.outside': 'Buiten',
  // A colon after the key or button: "Gebruik: uitstappen" reads as Dutch, where "Gebruik Uitstappen" doesn't.
  'prompt.open': '{key}: {door} openen',
  'prompt.close': '{key}: {door} sluiten',
  'prompt.driving': '{speed} km/u  ·  {use}: uitstappen',
  'prompt.tag': '{use}: {name} tikken',
  'prompt.riding': 'Je rijdt mee met {name}  ·  {speed} km/u  ·  {use}: uitstappen',
  'prompt.nobody': 'niemand',
  'prompt.drive': '{use}: met {car} rijden',
  'prompt.rideAlong': '{use}: meerijden met {name}',
  'prompt.carFull': '{a} en {b} zitten in {car}',
  'prompt.horse': '{speed} km/u  ·  {gallop}: galopperen (adem {breath}%)  ·  {jump}: springen  ·  {use}: afstappen',
  'prompt.mount': '{use}: op het paard stappen',
  'prompt.horsePortal': 'Stap van het paard om het portaal te gebruiken',
  'prompt.portalsOff': 'De beheerder heeft de portalen uitgezet',
  'prompt.fly': 'Vliegen · houd {up} ingedrukt om te stijgen, {down} om te dalen',
  'prompt.noShoot': 'Schoolterrein · hier wordt niet geschoten',
  'prompt.locked': 'Alleen toegankelijk in multiplayer.\nWil je solo rondkijken? Contacteer Yoshi via yoshi@olive-security.be',
  'fb.title': 'Vind je Brieltje leuk?',
  'fb.sub': 'Een snelle score helpt Yoshi. Alles hier is vrijblijvend.',
  'fb.stars': 'Jouw score',
  'fb.star.one': '{n} ster',
  'fb.star.other': '{n} sterren',
  'fb.comment': 'Wil je nog iets kwijt? (niet verplicht)',
  'fb.commentAria': 'Opmerking',
  'fb.later': 'Nee, bedankt',
  'fb.send': 'Versturen',
  'fb.privacy': 'Privacy',
  'fb.thanks': 'Bedankt!',
  'fb.error': 'Versturen lukte niet. Probeer opnieuw, of sluit dit venster.',
  'fb.close': 'Sluiten',
  'fb.tooMany': 'Bedankt! Dat is genoeg voor nu. Probeer het over een uur opnieuw.',
  'menu.feedback': 'Feedback',
  'menu.feedbackTitle': 'Laat Yoshi weten wat je ervan vindt',
  'weapon.pistol': 'Pistool',
  'weapon.rifle': 'Geweer',
  'weapon.shotgun': 'Jachtgeweer',
  'weapon.sniper': 'Sniper',
  'weapon.bazooka': 'Bazooka',
  'weapon.grenade': 'Granaat',
  'weapon.reloading': 'Herladen…',
  'char.you': 'Jij',
  'char.cat': 'een kat',
  'char.clown': 'een clown',
  'char.strongman': 'een krachtpatser',
  'combat.killedBy': 'Gedood door {name}',
  'combat.headshot': 'Headshot · ',
  'combat.headshotTag': 'HEADSHOT',
  'combat.youWin': 'Jij wint de ronde!',
  'combat.wins': '{name} wint de ronde',
  'combat.nextRound': 'Terug bij de start van de volgende ronde',
  'combat.backIn': 'Terug over {n}',
  'combat.respawning': 'Je komt terug…',
  'combat.newRoundIn': 'Nieuwe ronde over {n}',
  'combat.goal': 'Wie eerst aan {n} kills is, wint de ronde · kill 100 · headshot +50',
  'combat.player': 'Speler',
  'combat.kills': 'Kills',
  'combat.deaths': 'Gestorven',
  'combat.points': 'Punten',
  'combat.exploring': 'verkent',
  'combat.dead': 'dood',
  'paint.pistol': 'Verfpistool',
  'paint.rifle': 'Verfgeweer',
  'paint.shotgun': 'Spatgeweer',
  'paint.sniper': 'Verfsniper',
  'paint.bazooka': 'Verfkanon',
  'paint.grenade': 'Verfballon',
  'paint.refilling': 'Verf bijvullen…',
  'paint.taggedBy': 'Je bent geraakt door {name}!',
  'paint.backIn': 'Terug in {n}…',
  'paint.bullseye': 'Voltreffer · ',
  'paint.bullseyeTag': 'VOLTREFFER',
  'paint.tagged': 'raakte',
  'paint.splattered': 'bespatte',
  'paint.you': 'jou',
  'paint.goal': 'Wie eerst {n} keer raak schiet, wint de ronde · raak 100 · voltreffer +50',
  'paint.tags': 'Raak',
  'paint.taggedCol': 'Geraakt',
  'paint.out': 'geraakt',
  'paint.ratio': 'Verhouding',
  'paint.bullseyes': 'Voltreffers',
  'paint.lbEmpty': 'Nog geen rondes. Speel een ronde verfballen.',
  'games.teamCount.one': '1 speler, start bij {place}',
  'games.teamCount.other': '{n} spelers, start bij {place}',
  'games.atHouse': 'het huis',
  'games.atBungalow': 'de bungalow',
  'games.blind': 'Jij zoekt. Ogen dicht terwijl de anderen zich verstoppen… {n}',
  'games.youSeekHide': 'Jij zoekt: tel met je ogen dicht',
  'games.hide.one': 'Verstop je! {names} komt zoeken',
  'games.hide.other': 'Verstop je! {names} komen zoeken',
  'games.youSeek': 'Jij zoekt: vind de anderen en tik ze aan (E)',
  'games.stayHidden': 'Blijf verstopt',
  'games.teamsLine': 'Huis {h} – {b} Bungalow · eerst aan {goal} · jij: {team}',
  'games.youreIt': 'Jij bent de tikker! Tik iemand (E) · jouw tijd {n} s',
  'games.isIt': '{name} is de tikker · jouw tijd {n} s',
  'games.coins': 'nog {n} munten · jij {mine}',
  'games.best': ' · beste: {name} {n}',

  // ---- Chat lines made here
  'chat.furnOff': 'De beheerder heeft de meubelplanner uitgezet.',
  'chat.travelHelp': 'Reis met {list}, of stap op een portaal.',
  'chat.notDown': 'Niet zolang je dood bent.',
  'chat.joinedAs': 'Je doet mee als {name}. {n} van {max} online.',
  'chat.joined': '{name} doet mee',
  'chat.left': '{name} is vertrokken',
  'chat.repaired': '{name} heeft de ramen hersteld',
  'chat.furnReset': '{name} heeft de meubels teruggezet in de oorspronkelijke opstelling',
  'chat.furnCleared': '{name} heeft alle meubels weggehaald',

  // ---- Joining, logging in, the connection
  'err.nameFirst': 'Typ eerst je naam.',
  'err.password': 'Typ het wachtwoord van de beheerder.',
  'err.pin': 'Typ de pincode.',
  'err.age': 'Vink aan dat je 13 jaar of ouder bent om samen te spelen.',
  'err.status': 'Fout {n}',
  'net.connecting': 'Verbinden…',
  'net.lost': 'Verbinding verbroken, opnieuw verbinden…',
  'net.elsewhere': 'Je bent ergens anders aangemeld.',
  'net.removed': 'De beheerder heeft je verwijderd.',
  'net.ended': 'Je sessie is afgelopen. Meld je opnieuw aan.',
  'net.reload': 'Het spel is bijgewerkt. Laad de pagina opnieuw om samen te blijven spelen.',

  // ---- Portals and travelling
  'portal.house': 'Woning Yoshi & Liesl',
  'portal.bungalow': 'Bungalow',
  'portal.church': 'Kerk',
  'portal.school': 'School',
  'portal.molenhoek': 'Molenhoek',
  'travel.portal': 'Portaal',
  'travel.here': 'je bent hier',
  'travel.back': 'terug',
  'travel.pickPad': 'D-pad ↑↓ en {use}',
  'travel.pickTouch': 'Tik op een plaats',
  'travel.pickKbm': '1–{n}, of het wiel en {use}',
  'travel.walkOff': '{pick} · stap eraf om te blijven',
  'travel.driveOn': '{pick} · rij door om te blijven · de auto gaat mee',
  'travel.village': 'het dorp wordt geladen',

  // ---- The big map
  'map.zoomIn': 'Inzoomen',
  'map.zoomOut': 'Uitzoomen',
  'map.where': 'Waar je bent',
  'map.whole': 'De hele kaart',
  'map.you': 'Jij',
  'map.portal': 'Portaal',
  'map.players': 'Spelers',
  'map.waypoint': 'Bestemming',
  'map.helpTouch': 'Sleep om te verschuiven · knijp om te zoomen · tik op een plaats, of ergens anders voor een bestemming',
  'map.helpKbm': 'Sleep of {move} om te verschuiven · wiel om te zoomen · klik op een plaats, of ergens anders voor een bestemming · {map} of {menu}: terug naar het spel',
  'map.helpPad': 'Linkerstick om te verschuiven · R2/L2 om te zoomen · ✕ zet een bestemming op het kruis · {tabs} voor de andere tabbladen · {menu} of ○: terug naar het spel',
  'map.byRoad': '{d} via de weg · de minikaart wijst de weg',
  'map.fromYouWay': 'Op {d} van jou · de minikaart wijst de weg',
  'map.placeSub': '{sub} · op {d} van jou',
  'map.remove': 'Wissen',
  'map.directions': 'Route',
  'map.portalNote': 'Hier staat een portaal: stap op eender welk portaal om meteen hier te komen.',
  'map.pond': 'Vijver',
  'map.north': 'N',
  'place.house': 'Woning Yoshi & Liesl',
  'place.bungalow': 'Bungalow',
  'place.church': 'Sint-Pharaïldiskerk',
  'place.school': 'Basisschool',
  'place.molenhoek': 'Molenhoek',
  'place.square': 'Kerkplein',
  'place.horses': 'Paarden',
  'place.horsesSub': 'de weide aan de overkant van de straat',

  // ---- The furniture planner
  'plan.moving': 'Verzetten: {name}',
  'plan.size': '{w} × {d} cm, {h} cm hoog · {i} van {n}',
  'plan.keys': 'Klik: neerzetten · wiel: ander stuk · {turn}: draaien · rechtsklik: verzetten · {remove}: weghalen · {stop}: stoppen',
  'plan.keysPad': 'R2: neerzetten · L1/R1: ander stuk · {turn}: draaien · L2: verzetten · {remove}: weghalen',
  'plan.clown': 'Clown (wandelt rond, je kunt erop schieten)',
  'plan.strongman': 'Krachtpatser, een reus (wandelt rond, je kunt erop schieten)',

  // ---- Messages from the server, by code
  'srv.kicked': 'De beheerder heeft {name} verwijderd',
  'srv.rules': '{name} heeft de huisregels aangepast: {list}',
  'srv.newRoundBy': '{name} is een nieuwe ronde begonnen',
  'srv.newRound': 'Nieuwe ronde: wie eerst aan {n} kills is, wint',
  'srv.travelChatOff': 'De beheerder heeft reizen via de chat uitgezet. Wandel naar een portaal.',
  'srv.travelPortalsOff': 'De beheerder heeft de portalen uitgezet.',
  'srv.travelDriverOnly': 'Alleen wie rijdt, kan de auto meenemen.',
  'srv.travelHorse': 'Stap eerst van het paard.',
  'srv.teamWait': 'Wissel van team met volle gezondheid (hoogstens om de 15 seconden), of terwijl je wacht om terug te komen',
  'srv.teamJoined': '{name} zit nu in team {team}',
  'srv.teamWon': 'Team {team} wint, {house}–{bungalow}',
  'srv.gameStopped': '{name} heeft het spel gestopt',
  'srv.needTwo': 'Voor {kind} zijn minstens twee spelers nodig',
  'srv.hideStarted': '{name} is verstoppertje begonnen: {seeker} zoekt. Verstop je! (30 seconden)',
  'srv.teamsStarted': '{name} is Huis tegen bungalow begonnen: het eerste team aan {n} kills wint. Wissel van team in het menu (Samen).',
  'srv.tagStarted': '{name} is tikkertje begonnen: {it} is de tikker. Wie het kortst tikker is, wint.',
  'srv.huntStarted': '{name} is een schattenjacht begonnen: {n} munten in en rond het huis',
  'srv.found': '{name} heeft {target} gevonden',
  'srv.foundLeft': '{name} heeft {target} gevonden (nog {n} verstopt)',
  'srv.foundAll': 'De zoekers hebben iedereen gevonden!',
  'srv.tagged': '{name} heeft {target} getikt: {target} is de tikker',
  'srv.huntWon.one': '{names} vond de meeste munten ({n})',
  'srv.huntWon.other': '{names} vonden de meeste munten ({n})',
  'srv.huntNone': 'Niemand heeft een munt gevonden',
  'srv.seekerLeft': 'De zoeker is vertrokken: de verstoppers winnen',
  'srv.notEnough': 'Niet genoeg spelers',
  'srv.itLeft': '{name} is vertrokken: {it} is de tikker',
  'srv.teamsDraw': 'De tijd is om: gelijkspel, {house}–{bungalow}',
  'srv.teamsTime': 'De tijd is om: team {team} wint, {house}–{bungalow}',
  'srv.ready': 'Wie niet weg is, is gezien! {name} komt eraan!',
  'srv.hiddenWin.one': 'De tijd is om: {names} bleef verstopt en wint',
  'srv.hiddenWin.other': 'De tijd is om: {names} bleven verstopt en winnen',
  'srv.tagWon': '{name} wint: amper {n} s tikker geweest',
  'srv.nobodyPlayed': 'Niemand heeft gespeeld',
  'srv.tooMany': 'Te veel pogingen. Probeer het over 15 minuten opnieuw.',
  'srv.nameFormat': 'Je naam: 2 tot 20 tekens, letters, cijfers, - of _.',
  'srv.wrongPassword': 'Verkeerd wachtwoord.',
  'srv.removed': 'De beheerder heeft je verwijderd. Probeer het later opnieuw.',
  'srv.nameInUse': 'Een speler gebruikt de naam {name}. Kies een andere naam.',
  'srv.pinOff': 'Meedoen met de pincode staat nu uit.',
  'srv.age': 'Vink aan dat je 13 jaar of ouder bent om samen te spelen.',
  'srv.pinTooMany': 'De laatste tijd te veel verkeerde pincodes. Probeer het over een uur opnieuw.',
  'srv.wrongPin': 'Verkeerde pincode.',
  'srv.nameTaken': 'Die naam is al bezet. Kies een andere naam.',
  'srv.nameOnline': 'Iemand speelt nu als {name}. Kies een andere naam.',
  'srv.nameToday': '{name} is vandaag al bezet (een naam blijft bij wie ermee meedeed). Kies een andere naam.',
  'srv.pinChanged': 'De pincode is net veranderd. Vraag naar de nieuwe.',
  'srv.pinFormat': 'De pincode: 4 tot 12 cijfers.',
  'srv.notLoggedIn': 'Niet aangemeld',
  'srv.adminOnly': 'Alleen voor de beheerder',
  'srv.pickAnother': 'Kies een andere speler',
  'srv.notFound': 'Niet gevonden',
  'rule.flying': 'vliegen',
  'rule.furniture': 'meubels verzetten',
  'rule.names': 'namen boven spelers',
  'rule.pin': 'meedoen met de pincode',
  'rule.portals': 'portalen',
  'rule.travel': 'reizen via de chat',
  'rule.paintball': 'kindvriendelijk voor iedereen',
  'rule.on': '{rule} aan',
  'rule.off': '{rule} uit',
  'rule.max': 'maximaal {n} spelers tegelijk',
  'list.and': '{a} en {b}',
} as const satisfies Record<Key, string>;

/** The {names} in a string. */
type Params<S extends string> = S extends `${string}{${infer P}}${infer R}` ? P | Params<R> : never;
/** The keys whose text has no {params}: `t(key)` alone. */
export type PlainKey = { [K in Key]: [Params<(typeof en)[K]>] extends [never] ? K : never }[Key];
/** A key's parameters: none, or an object with exactly its {names}. */
type Args<K extends Key> = [Params<(typeof en)[K]>] extends [never] ? [] : [Record<Params<(typeof en)[K]>, string | number>];
/** Keys whose Dutch text has other {placeholders} than the English: must be none, or tsc names them here. */
type Mismatched = {
  [K in Key]: [Params<(typeof en)[K]>] extends [Params<(typeof nl)[K]>] ? ([Params<(typeof nl)[K]>] extends [Params<(typeof en)[K]>] ? never : K) : K;
}[Key];
const placeholdersMatch: [Mismatched] extends [never] ? true : Mismatched = true;
void placeholdersMatch;

const DICTS: Record<Lang, Record<Key, string>> = { en, nl };
const STORE = 'briel.lang';
const listeners = new Set<() => void>();

/** The choice made in this browser, else the browser's own language (Dutch for nl, nl-BE ...). */
function initial(): Lang {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved === 'en' || saved === 'nl') return saved;
  } catch {
    // Private windows can block storage: follow the browser.
  }
  return /^nl(-|$)/i.test(navigator.language || '') ? 'nl' : 'en';
}

let current: Lang = initial();

export function lang(): Lang {
  return current;
}

/** Fill in {params}; a value is put in as it is (never read as a placeholder again). */
function fill(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, p: string) => (Object.hasOwn(params, p) ? String(params[p]) : m));
}

/** The text for `key` in the current language, with its {params}. */
export function t<K extends Key>(key: K, ...args: Args<K>): string {
  return fill(DICTS[current][key] ?? en[key], args[0] as Record<string, string | number> | undefined);
}

/** One or other key by a count (1 or more). */
export function plural<K extends Key>(n: number, one: K, other: K, ...args: Args<K>): string {
  return t(n === 1 ? one : other, ...args);
}

/** A number with `digits` decimals: a decimal comma in Dutch. */
export function num(v: number, digits = 0): string {
  const s = v.toFixed(digits);
  return current === 'nl' ? s.replace('.', ',') : s;
}

/** A distance: tens of metres up to 950 m, then km with one decimal. */
export function dist(m: number): string {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${num(m / 1000, 1)} km`;
}

/** Names as a list: "a, b and c". */
export function listOf(names: string[]): string {
  if (names.length < 2) return names[0] ?? '';
  return t('list.and', { a: names.slice(0, -1).join(', '), b: names[names.length - 1] });
}

/** Call `fn` whenever the language changes (to redraw text that isn't drawn every frame). */
export function onLang(fn: () => void): void {
  listeners.add(fn);
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORE, next);
  } catch {
    // Private window: the choice lasts for this visit.
  }
  applyStatic();
  for (const fn of listeners) fn();
}

/** Text with **bold** parts into `el`, as text nodes and <b> elements (never as HTML). */
export function rich(el: Element, text: string): void {
  el.replaceChildren(
    ...text.split(/\*\*(.+?)\*\*/).map((part, i) => {
      if (i % 2 === 0) return document.createTextNode(part);
      const b = document.createElement('b');
      b.textContent = part;
      return b;
    }),
  );
}

const isKey = (k: string | undefined): k is Key => !!k && Object.hasOwn(en, k);
/** A key from elsewhere (the HTML, a portal's id): its text with any {params} left as they are. */
const any = (key: Key) => DICTS[current][key];

/**
 * The static HTML in the current language: `data-i18n` (the text), `data-i18n-rich` (text with
 * **bold**), `data-i18n-title`, `data-i18n-placeholder` and `data-i18n-aria` (aria-label). Also
 * the page's title, its lang attribute and the language buttons.
 */
export function applyStatic(root: ParentNode = document): void {
  const each = (attr: string, set: (el: HTMLElement, text: string) => void) => {
    root.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
      const key = el.getAttribute(attr) ?? undefined;
      if (isKey(key)) set(el, any(key));
      else if (import.meta.env.DEV) console.error(`i18n: no text for ${attr}="${key}"`);
    });
  };
  each('data-i18n', (el, s) => (el.textContent = s));
  each('data-i18n-rich', (el, s) => rich(el, s));
  each('data-i18n-title', (el, s) => (el.title = s));
  each('data-i18n-placeholder', (el, s) => el.setAttribute('placeholder', s));
  each('data-i18n-aria', (el, s) => el.setAttribute('aria-label', s));
  document.documentElement.lang = current;
  document.title = t('page.title');
  // The legal pages open in the same language (web/public/legal/legal.js reads ?lang=).
  root.querySelectorAll<HTMLAnchorElement>('a[href^="/legal/"]').forEach((a) => {
    const url = new URL(a.getAttribute('href')!, location.origin);
    url.searchParams.set('lang', current);
    a.setAttribute('href', url.pathname + url.search);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) => {
    const on = b.dataset.lang === current;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

// ---- Names from the data: Dutch by their English name or id, the data's own name otherwise.

/** Floors, rooms and surfaces you stand on (the house data). The rooms' own names are Dutch already. */
const PLACES_NL: Record<string, string> = {
  'Ground floor': 'Gelijkvloers', '1st floor': '1e verdieping', '2nd floor': '2e verdieping',
  'ground floor': 'gelijkvloers', 'roof terrace': 'dakterras',
  '1st floor roof, rear': 'dak van de 1e verdieping, achteraan', '1st floor roof, front': 'dak van de 1e verdieping, vooraan',
  '2nd floor roof': 'dak van de 2e verdieping', 'ground to 1st floor': 'trap naar de 1e verdieping', '1st to 2nd floor': 'trap naar de 2e verdieping',
  'outside stair to roof terrace': 'buitentrap naar het dakterras', 'covered terrace': 'overdekt terras', 'garden shed': 'tuinhuis',
  'back terrace (uncovered)': 'terras achteraan (niet overdekt)', 'path along the outbuilding': 'pad langs het bijgebouw',
  'side path (right)': 'zijpad (rechts)', driveway: 'oprit', Driveway: 'Oprit', 'front path': 'tuinpad vooraan', 'stepping slab': 'stapsteen',
  planting: 'beplanting', Garden: 'Tuin', street: 'straat',
};
export function placeName(name: string): string {
  if (current === 'en') return name;
  const old = / \(old house\)$/.exec(name);
  if (old) return `${placeName(name.slice(0, old.index))} (bungalow)`;
  return PLACES_NL[name] ?? name;
}

/** The doors (the house data): "door to Badkamer" and the named ones; after "E: " in the prompt, so lower case. */
const DOORS_NL: Record<string, string> = {
  'sliding door': 'schuifdeur', 'door (storeroom)': 'deur (berging)', 'glass double door': 'glazen dubbele deur', 'outside door': 'buitendeur',
  'glass door': 'glazen deur', 'kitchen door': 'keukendeur', 'front door': 'voordeur', 'door (bedroom 1)': 'deur (slaapkamer 1)',
  'door (kitchen)': 'deur (keuken)', 'door (kitchen to living room)': 'deur (keuken naar woonkamer)', 'door (bedroom 2)': 'deur (slaapkamer 2)',
  'door (bathroom)': 'deur (badkamer)', 'door (WC)': 'deur (wc)', 'door (living room)': 'deur (woonkamer)',
  'door (back room upstairs)': 'deur (achterkamer boven)', 'sliding door (veranda)': 'schuifdeur (veranda)',
};
export function doorName(name: string): string {
  if (current === 'en') return name;
  const to = /^door to (.+)$/.exec(name);
  if (to) return `deur naar ${to[1]}`; // the room's own name, as the house data writes it
  if (import.meta.env.DEV && !DOORS_NL[name]) console.warn(`i18n: no Dutch name for the door "${name}"`);
  return DOORS_NL[name] ?? name;
}

/** The planner's furniture, by item id (shared/furniture.json keeps the English names). */
const FURNITURE_NL: Record<string, string> = {
  bed180: 'Bed 180 x 200', bed160: 'Bed 160 x 200', bed140: 'Bed 140 x 200', bed90: 'Eenpersoonsbed 90 x 200', nightstand: 'Nachtkastje',
  wardrobe200: 'Kleerkast 200 cm', wardrobe100: 'Kleerkast 100 cm', sofa3: 'Driezitszetel', sofa2: 'Tweezitszetel', cornersofa: 'Hoekzetel',
  armchair: 'Fauteuil', coffeetable: 'Salontafel', dining200: 'Eettafel 200 x 100', dining160: 'Eettafel 160 x 90', roundtable: 'Ronde tafel 120',
  chair: 'Eetkamerstoel (kuip in bouclé)', terracechair: 'Terrasstoel (grijs, zwart frame)', desk: 'Bureau 140 x 70',
  officechair: 'Bureaustoel (mesh, grafiet)', desksetup: 'Bureau 180 met twee schermen (eik)', shelves: 'Zwevende planken met lichtstrips',
  slatwall: 'Wandpaneel met houten latten', print: 'Ingelijste print', rugjute: 'Rond jute tapijt 200', pendants: 'Vijf hanglampen in eikelvorm',
  globes: 'Drie bolvormige hanglampen', rattandome: 'Koepelvormige hanglamp in rotan', tracklight: 'Plafondrail met drie spots (zwart)',
  bookcase: 'Boekenkast', bookwall: 'Boekenwand (van vloer tot plafond)', jacuzzi: 'Jacuzzi',
  tvunit: 'Lowboard met een tv van 75 inch en een soundbar aan de muur', rug200: 'Tapijt 200 x 300', rug160: 'Tapijt 160 x 230',
  washer: 'Wasmachine', floorlamp: 'Staanlamp', plant: 'Kentiapalm', oval220: 'Ovale eettafel 220 x 110', dresser: 'Ladekast (wit)',
  lowdresser: 'Lage ladekast (notelaar)', kidsdesk: 'Laag bureau met rek (speelruimte)', kidstable: 'Kindertafeltje', kidschair: 'Kinderstoeltje',
  pouf: 'Poef', bench: 'Zitbank aan het raam', lsofa: 'Zetel met chaise longue (crème)', roundcoffee: 'Ronde salontafel (marmer)',
  ruground: 'Rond tapijt 120', weightbench: 'Halterbank', smartbike: 'Fietstrainer voor Zwift, met scherm', gymball: 'Fitnessbal',
  loungesofa: 'Tuinzetel (rond, gevlochten)',
};
export function furnitureName(id: string, fallback: string): string {
  if (current === 'en') return fallback;
  if (import.meta.env.DEV && !FURNITURE_NL[id]) console.warn(`i18n: no Dutch name for furniture "${id}"`);
  return FURNITURE_NL[id] ?? fallback;
}

/** The cars (shared/car.json), with their article: "the Tesla". */
const CARS_NL: Record<string, string> = { tesla: 'de Tesla', model3: 'de Model 3', churchY: 'de witte Model Y', church3: 'de rode Model 3' };
export function carName(id: string, fallback: string): string {
  return current === 'en' ? fallback : CARS_NL[id] ?? fallback;
}

/** A portal's name (shared/portals.mjs keeps the English one), by its id. */
export function portalName(p: { id: string; name: string }): string {
  const key = `portal.${p.id}`;
  return isKey(key) ? any(key) : p.name;
}

/** Who did it, for the kill feed and the death screen: a player's name, or one of the game's own ("a strongman"). */
export function whoName(name: string): string {
  // Player names are 2 to 20 letters, digits, - or _ (server/auth.mjs): never one of these.
  const own: Record<string, PlainKey> = { 'a strongman': 'char.strongman', 'a clown': 'char.clown', 'a cat': 'char.cat' };
  return Object.hasOwn(own, name) ? t(own[name]) : name;
}

// ---- Messages from the server

/** Parameters the server may send: short text, finite numbers, true or false, and short lists of names. */
type ServerArgs = Record<string, string | number | boolean | string[]>;
function validArgs(a: unknown): ServerArgs | null {
  if (a === undefined) return {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const out: ServerArgs = {};
  for (const [k, v] of Object.entries(a)) {
    if (!/^\w{1,20}$/.test(k)) return null;
    if (typeof v === 'string' && v.length <= 200) out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.length <= 32 && v.every((s) => typeof s === 'string' && s.length <= 40)) out[k] = v as string[];
    else return null;
  }
  return out;
}

const RULES = ['flying', 'furniture', 'names', 'pin', 'portals', 'travel', 'paintball'] as const;
const TEAMS: Partial<Record<string, PlainKey>> = { house: 'team.house', bungalow: 'team.bungalow' };
const GAMES: Partial<Record<string, PlainKey>> = { hide: 'game.hide', tag: 'game.tag', treasure: 'game.treasure', teams: 'game.teams' };

/**
 * A message from the server in the current language: its `code` (a 'srv.' key) with its `args`, or
 * the English `fallback` it came with when the code or its parameters are unknown or malformed.
 * The result is text: the caller puts it in the page with textContent.
 */
export function serverText(code: unknown, args: unknown, fallback: string): string {
  const a = validArgs(args);
  if (typeof code !== 'string' || !a) return fallback;
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(a)) {
    const team = k === 'team' && typeof v === 'string' ? TEAMS[v] : undefined;
    const game = k === 'kind' && typeof v === 'string' ? GAMES[v] : undefined;
    if (Array.isArray(v)) params[k] = listOf(v);
    else if (team) params[k] = t(team);
    else if (game) params[k] = t(game);
    else params[k] = typeof v === 'boolean' ? String(v) : v;
  }
  if (code === 'rules') {
    // The rules that changed, each on or off, and the number of players.
    const parts = RULES.filter((r) => typeof a[r] === 'boolean').map((r) => t(a[r] ? 'rule.on' : 'rule.off', { rule: t(`rule.${r}`) }));
    if (typeof a.maxPlayers === 'number') parts.push(t('rule.max', { n: a.maxPlayers }));
    if (!parts.length) return fallback;
    params.list = parts.join(', ');
  }
  // Counted messages: '.one' or '.other' by the length of their list of names.
  let key = `srv.${code}`;
  const names = a.names;
  if (Array.isArray(names) && Object.hasOwn(en, `${key}.one`)) key = `${key}.${names.length === 1 ? 'one' : 'other'}`;
  if (!isKey(key)) return fallback;
  const text = DICTS[current][key];
  // Every placeholder must be filled; a server that sent too little gets its own text shown.
  for (const m of text.matchAll(/\{(\w+)\}/g)) if (!Object.hasOwn(params, m[1])) return fallback;
  return fill(text, params);
}

document.documentElement.lang = current;
