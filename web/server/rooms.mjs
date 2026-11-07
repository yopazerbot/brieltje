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

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ARENAS, arenaEdge } from '../shared/arenas.mjs';
import { loadBounds } from '../shared/bounds.mjs';

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
    setInterval(() => this.sweep(), 10_000).unref();
  }

  /** The open world and every room. */
  games() {
    return [this.main, ...[...this.rooms.values()].map((r) => r.game)];
  }

  /** Where `name` plays right now, or null. */
  gameOf(name) {
    return this.games().find((g) => g.players.has(name)) ?? null;
  }

  online(name) {
    return !!this.gameOf(name);
  }

  /** Everyone playing together, in the open world and the rooms. */
  count() {
    return this.games().reduce((n, g) => n + g.players.size, 0);
  }

  /** `name` connected to `game`: their connection anywhere else ends (another tab, or the place they came from). */
  joined(name, game, session) {
    this.onJoined?.(name, session); // server.mjs: an account's "last seen"
    for (const g of this.games()) {
      if (g === game) continue;
      const p = g.players.get(name);
      if (p) p.ws.close(4000, 'Logged in somewhere else');
    }
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
    if (mine) return { room: this.entry(mine) };
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
    return { room: this.entry(r) };
  }

  /** A room as the list shows it: who opened it, where, how many play, and the game in it. */
  entry(r) {
    const z = r.game.modes.zombies;
    return { id: r.id, owner: r.owner, place: r.arena.id, players: r.game.players.size, max: ROOM_PLAYERS, wave: z ? z.horde.wave : 0, playing: !!z };
  }

  list() {
    return { rooms: [...this.rooms.values()].sort((a, b) => a.created - b.created).map((r) => this.entry(r)), max: MAX_ROOMS };
  }

  /** The WebSocket: `room` in the address picks a room; without it, the open world. */
  upgrade(req, socket, head) {
    const id = new URL(req.url, 'http://local').searchParams.get('room');
    if (id === null) return this.main.upgrade(req, socket, head);
    const room = ROOM_ID.test(id) ? this.rooms.get(id) : null;
    if (!room) return this.main.upgrade(req, socket, head, true); // told it is gone (after the same checks)
    room.game.upgrade(req, socket, head);
  }

  /** The admin removes `name`, wherever they play. */
  kick(name, by) {
    return (this.gameOf(name) ?? this.main).kick(name, by);
  }

  /** Who plays where, for the admin. */
  roster() {
    const list = this.main.roster().map((p) => ({ ...p, room: null }));
    for (const r of this.rooms.values()) list.push(...r.game.roster().map((p) => ({ ...p, room: `${r.owner} · ${r.arena.id}` })));
    return list;
  }

  /** The admin changed the open world's rules: every room takes them (its own limit kept) and its players hear it. */
  rulesChanged(rules, notice) {
    for (const r of this.rooms.values()) {
      r.game.rules = { ...rules, maxPlayers: ROOM_PLAYERS };
      r.game.broadcast({ t: 'rules', rules: r.game.rules });
      r.game.broadcast(notice);
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
    return this.main.board(now);
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
