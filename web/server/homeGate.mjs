// The game server's side of the three homes that open only with a code (shared/homes.mjs, server/homes.mjs).
// A player may open a home's doors, break its panes and stand inside its footprint only with the grant of the code
// (typed in this session, 8 hours) or as the admin. Everything here is decided by the server from the messages' numbers
// and the player's position; the page's own lock (src/world/homeLocks.ts) only spares an honest player the refusals.
//
// Guarded against:
// - door and glass messages for a home from somebody without the right: not applied and not broadcast (forgery);
// - walking in through a door somebody else opened: a position inside a home's footprint is never taken for a player
//   without the right; they stay where they were (or, when they were inside already, such as after a revoked code,
//   they are put out in front of it, where its portal brings you out: the page does the same, so both agree);
// - the server's own moves (respawn, joining) never put such a player inside (mayStand).
import { homeAt, homeOfDoor } from '../shared/homes.mjs';
import { PORTALS } from '../shared/portals.mjs';

// A home's inside is its bands: a ring for each floor, for that floor's heights (shared/homes.mjs).

/** ms between two `homelock` messages to one player */
const TELL_MS = 1500;

export class HomeGate {
  /** `homes`: () => the Homes (server/homes.mjs) or null; `paneHome`: (index) => home id or null (shared makePaneHomes). */
  constructor({ homes, paneHome }) {
    this.homes = homes;
    this.paneHome = paneHome;
  }

  /** May this player use home `id` (open its doors, break its panes, be inside)? */
  may(player, id) {
    return player.role === 'admin' || !!this.homes()?.granted(player.key, id);
  }

  /** May this player toggle door `id`? Doors that belong to no home: always. */
  door(player, doorId) {
    const home = homeOfDoor(doorId);
    return !home || this.may(player, home);
  }

  /** May this player break pane `i`? Panes that belong to no home: always. */
  glass(player, i) {
    const home = this.paneHome(i);
    return !home || this.may(player, home);
  }

  /** May this player stand at (x, z), as a spawn point or a last position? */
  mayStand(player, x, y, z) {
    const home = homeAt(x, z, y);
    return !home || this.may(player, home);
  }

  /**
   * A player's new position `next` (their old one `prev`), changed in place when it lies inside a home they have no
   * right to. Returns { home, put } (to tell the page, see tell; `put`: they were put out, a jump) or null. Cheap: a
   * box test per home, then the ring.
   */
  keepOut(player, prev, next) {
    const home = homeAt(next.x, next.z, next.y);
    if (!home || this.may(player, home)) return null;
    if (homeAt(prev.x, prev.z, prev.y) === home) {
      return { home, put: true }; // inside already (the code was revoked, the grant ended): out, see Game.putOut
    }
    next.x = prev.x;
    next.z = prev.z;
    next.y = prev.y;
    return { home, put: false };
  }

  /** Where the home's portal brings you out: in front of it, outside every band. */
  outOf(home) {
    return PORTALS.find((p) => p.id === home).out;
  }

  /** True when the page may be told again that home `id` is shut to it (at most every TELL_MS). */
  tell(player, now) {
    if (now < (player.nextHomeTell || 0)) return false;
    player.nextHomeTell = now + TELL_MS;
    return true;
  }
}
