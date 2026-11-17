// Zombies rooms (Yoshi, 7 Nov 2026): a player with an account opens a room for Zombies at one of the places
// (shared/arenas.mjs). Anyone playing together, guests too, can join it from the list. A room is a game of
// its own on this server (server/game.mjs with `room` set): its own players, doors, panes, zombies and
// chat, so a game in a room never switches the open world to Zombies, and the two never see each other.
//
// - Opening: only an account or the admin (a session of role 'player' or 'admin'); one room per owner
//   (asking again gives their room back), at most MAX_ROOMS at once, ROOM_PLAYERS in each.
// - A room starts without a game: its players stand at its place, inside its edge, and anyone in it can
//   start Zombies (server/game.mjs 'mode'). Starting again after a game over is the same button.
// - Its id is random (ROOM_ID): only the list gives it, and a page can only ever join a room that is in it.
// - Empty for EMPTY_MS: closed (a page that was in it and comes back is told, and goes back to the open world).
// - One name in one place: joining a room ends that name's connection in the open world or another room.
// - Kicks reach every place; the admin's player list shows where each one is.
// - Host rooms (hostRoom): the Zombies duel's two (server/duel.mjs), opened by the host only. Not in the list, not
//   joinable by their id, not counted in MAX_ROOMS, up to DUEL_PLAYERS each; the server alone puts a page in one (upgrade).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ARENAS, arenaEdge } from '../shared/arenas.mjs';
import { loadBounds } from '../shared/bounds.mjs';
import { Duel } from './duel.mjs';

export const ROOM_PLAYERS = 8;
export const MAX_ROOMS = 4;
const EMPTY_MS = 90_000;
const ROOM_ID = /^[A-Za-z0-9_-]{12}$/;
const BOUNDS = loadBounds(JSON.parse(readFileSync(new URL('../shared/bounds.json', import.meta.url), 'utf8')));

export class Rooms {
  /** `main`: the open world (a Game); `make(room)`: a new Game for a room. */
  constructor(main, make) {
    this.main = main;
    this.make = make;
    this.rooms = new Map(); // id -> { id, owner, arena, game, created, emptySince }
    this.onScore = null; // server.mjs: the board changed (its cache goes)
    main.hub = this;
    this.duel = new Duel(this); // the host's Zombies duel and its two host rooms (server/duel.mjs)
    setInterval(() => this.sweep(), 10_000).unref();
  }

  /** The open world and every room (the duel's host rooms too). */
  games() {
    return [this.main, ...[...this.rooms.values()].map((r) => r.game), ...this.duel.games()];
  }

  /**
   * A host room (server/duel.mjs) for `owner` (its team) at `arena`, for up to `max`: a game of its own as a players'
   * room, never in this.rooms (so not in the list, not joinable by its id, not counted in MAX_ROOMS, not swept).
   */
  hostRoom(owner, arena, max) {
    let id;
    do id = randomBytes(9).toString('base64url');
    while (this.rooms.has(id));
    const room = { id, owner, arena, edge: arenaEdge(arena, BOUNDS), max, duel: owner };
    const game = this.make(room);
    game.hub = this;
    game.copyWorldFrom(this.main);
    this.main.auth.log('room_opened', null, { username: owner, detail: `duel ${arena.id} (${id})` });
    return { id, game };
  }

  /** A host room is done: its players go back to the open world (their pages connect there again). */
  dropHostRoom(id, game) {
    game.close();
    this.main.auth.log('room_closed', null, { username: game.room?.owner ?? '', detail: `duel (${id})` });
  }

  /** Where `name` plays right now, or null. */
  gameOf(name) {
    return this.games().find((g) => g.players.has(name)) ?? null;
  }

  /** Someone plays as `name` right now; with `exceptKey`, someone on another session than that one. */
  online(name, exceptKey) {
    const g = this.gameOf(name);
    return !!g && (exceptKey === undefined || g.players.get(name)?.key !== exceptKey);
  }

  /** Everyone playing together, in the open world and the rooms. */
  count() {
    return this.games().reduce((n, g) => n + g.players.size - (g.flagGuards?.size ?? 0), 0); // not Steal the flag's guards (server/flagGuards.mjs)
  }

  /** `name` connected to `game`: their connection anywhere else ends (another tab, or the place they came from). */
  joined(name, game, session) {
    this.onJoined?.(name, session); // server.mjs: an account's "last seen"
    for (const g of this.games()) {
      if (g === game) continue;
      const p = g.players.get(name);
      if (p) p.ws.close(4000, 'Logged in somewhere else');
    }
    this.duel.joined(name, game);
  }

  /** A better Zombies run was kept (server/game.mjs zombieRun). */
  scored() {
    this.onScore?.();
  }

  /**
   * Open a room at `place` for `session`: an account or the admin. Their room if they have one already.
   * The answer: { room } (its list entry) or an error.
   */
  create(session, place) {
    if (session?.role !== 'player' && session?.role !== 'admin') {
      return { error: 'Make an account or log in to open a room. You can join one as a guest.', code: 'roomAccount', status: 403 };
    }
    const arena = ARENAS.find((a) => a.id === place);
    if (!arena) return { error: 'Pick a place for the room.', code: 'roomPlace', status: 400 };
    const mine = [...this.rooms.values()].find((r) => r.owner === session.username);
    if (mine) return { room: this.entry(mine, session) };
    if (this.rooms.size >= MAX_ROOMS) return { error: `All ${MAX_ROOMS} rooms are in use. Join one, or try again later.`, code: 'roomsFull', args: { n: MAX_ROOMS }, status: 503 };
    let id;
    do id = randomBytes(9).toString('base64url');
    while (this.rooms.has(id));
    const room = { id, owner: session.username, arena, edge: arenaEdge(arena, BOUNDS), max: ROOM_PLAYERS };
    const game = this.make(room);
    game.hub = this;
    game.copyWorldFrom(this.main);
    const r = { id, owner: session.username, arena, game, created: Date.now(), emptySince: Date.now() };
    this.rooms.set(id, r);
    this.main.auth.log('room_opened', null, { username: session.username, detail: `${arena.id} (${id})` });
    return { room: this.entry(r, session) };
  }

  /**
   * A room as the list shows it to `viewer` (a session): where, how many play, and the game in it. Who opened it only for
   * the admin (the game's or the panel's); everyone else learns only whether it is their own (`mine`), so the list gives
   * nobody the names of accounts playing elsewhere. Inside a room its players hear whose it is (server/game.mjs welcome).
   */
  entry(r, viewer = null) {
    const z = r.game.modes.zombies;
    return {
      id: r.id, ...(viewer?.role === 'admin' ? { owner: r.owner } : {}), ...(viewer && viewer.username === r.owner ? { mine: true } : {}),
      place: r.arena.id, players: r.game.players.size, max: ROOM_PLAYERS, wave: z ? z.horde.wave : 0, playing: !!z,
    };
  }

  list(viewer = null) {
    return { rooms: [...this.rooms.values()].sort((a, b) => a.created - b.created).map((r) => this.entry(r, viewer)), max: MAX_ROOMS };
  }

  /**
   * The WebSocket: `room` in the address picks a room; without it, the open world. While the host's Zombies duel is on,
   * a player on one of its teams goes to their team's host room whatever the address says (server/duel.mjs route): a
   * page never picks a duel room. A watch view (the admin's) is never moved. The route runs only after the same-origin
   * check (cross-site WebSocket hijacking: another site's socket is refused by game.upgrade before any session is read).
   */
  upgrade(req, socket, head) {
    const q = new URL(req.url, 'http://local').searchParams;
    const id = q.get('room');
    let from = '';
    try {
      from = new URL(String(req.headers.origin || '')).host;
    } catch {
      // no or invalid Origin header: game.upgrade refuses it
    }
    const same = !!from && from === req.headers.host;
    // A watch view of the admin's hall screen asks for a duel team's room by its side (`duel=blue|red`, never its id):
    // that room's game.upgrade lets in the admin's session only, as the open world's does. No duel on: the open world.
    const side = q.get('watch') === '1' && this.duel.on ? q.get('duel') : null;
    if (side === 'blue' || side === 'red') return this.duel.state.sides[side].game.upgrade(req, socket, head);
    const duel = this.duel.on && same && q.get('watch') !== '1' ? this.duel.route(this.main.auth.session(req)) : null;
    if (duel) return duel.upgrade(req, socket, head); // the same checks of origin and session there
    if (id === null) return this.main.upgrade(req, socket, head);
    const room = ROOM_ID.test(id) ? this.rooms.get(id) : null;
    if (!room) return this.main.upgrade(req, socket, head, true); // told it is gone (after the same checks)
    room.game.upgrade(req, socket, head);
  }

  /** The admin removes `name`, wherever they play. */
  kick(name, by, ms) {
    return (this.gameOf(name) ?? this.main).kick(name, by, ms);
  }

  /** Who plays where, for the admin. */
  roster() {
    const list = this.main.roster().filter((p) => p.role !== 'guard').map((p) => ({ ...p, room: null })); // the people, not Steal the flag's guards
    for (const r of this.rooms.values()) list.push(...r.game.roster().map((p) => ({ ...p, room: `${r.owner} · ${r.arena.id}` })));
    for (const g of this.duel.games()) list.push(...g.roster().map((p) => ({ ...p, room: `duel ${g.room.duel} · ${g.room.arena.id}` })));
    return list;
  }

  /** The admin changed the open world's rules: every room takes them (its own limit kept) and its players hear it. */
  rulesChanged(rules, notice) {
    for (const g of [...[...this.rooms.values()].map((r) => r.game), ...this.duel.games()]) {
      g.rules = { ...rules, maxPlayers: g.room.max };
      g.broadcast({ t: 'rules', rules: g.shownRules() }); // with the look of a duel's game (server/modes.mjs LOOKS)
      g.broadcast(notice);
    }
  }

  /** The admin closes a room (brieltje.be/admin): its players go back to the open world. */
  close(id, by) {
    const r = typeof id === 'string' && ROOM_ID.test(id) ? this.rooms.get(id) : null;
    if (!r) return false;
    this.rooms.delete(id);
    r.game.close();
    this.main.auth.log('room_closed', null, { username: by, detail: `${r.arena.id} (${r.id}) of ${r.owner}, by the admin` });
    return true;
  }

  /** A player's time there and back, wherever they play (the admin's live view, server/stats.mjs). */
  pingOf(name) {
    return this.gameOf(name)?.pingOf(name) ?? null;
  }

  /** The admin's scoreboard (server/stats.mjs): the open world's. */
  board(now) {
    return { ...this.main.board(now), duel: this.duel.view(now) };
  }

  /** A code-locked home opened for session `key` (server/homes.mjs): every place hears of it. */
  homeGranted(key, id) {
    for (const g of this.games()) g.homeGranted(key, id);
  }

  /** Rooms empty for EMPTY_MS are closed. */
  sweep(now = Date.now()) {
    for (const r of [...this.rooms.values()]) {
      if (r.game.players.size) {
        r.emptySince = 0;
        continue;
      }
      r.emptySince ||= now;
      if (now - r.emptySince < EMPTY_MS) continue;
      this.rooms.delete(r.id);
      r.game.close();
      this.main.auth.log('room_closed', null, { username: r.owner, detail: `${r.arena.id} (${r.id})` });
    }
  }
}
