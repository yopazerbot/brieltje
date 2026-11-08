// An account's lasting access to a code-locked home (server/homes.mjs), against a throwaway game server: one account on
// three devices one after the other, plus a guest. The account types the main house's code once; its other session is let
// in at once, a later login elsewhere has it without the code, and the guest's next session has nothing. Then the admin's
// side: the list, removing one account's access, a new code, a new password and deleting the account.
//
//   ADMIN_PASSWORD=... node tools/dev/homes_account_check.mjs --api http://localhost:8700
//
// Works without the private data: the inside route answers 403 to a session without the right, and 200 (or 404 when
// the server holds no inside) to one with it. Makes one test account and deletes it at the end.
import { randomBytes } from 'node:crypto';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8700' });
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const host = new URL(o.api).host;
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => /_(session|panel)=./.test(c)).join('; ');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Has this session the right to the house? 403: no; 200 or 404 (no inside on this server): yes. */
const inside = async (cookie) => (await call('GET', '/api/home/house/inside', undefined, cookie)).r.status !== 403;
const connect = async (cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=4`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => log.push(JSON.parse(String(d))));
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await wait(800);
  return { ws, log, welcome: () => log.find((m) => m.t === 'welcome') };
};

const admin = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
ok('the admin is logged in', !!admin);
let code = (await call('POST', '/api/admin/homes/house/code', {}, admin)).data?.code;
ok('a code for the house', /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code ?? ''));

const name = `chk${randomBytes(3).toString('hex')}`;
const pass1 = randomBytes(12).toString('base64url');
const pass2 = randomBytes(12).toString('base64url');
const reg = await call('POST', '/api/account/register', { username: name, email: `${name}@example.org`, password: pass1, age: true });
ok('a test account', reg.r.status === 200, `${reg.r.status}`);
const laptop = cookieOf(reg.r);
const tablet = cookieOf((await call('POST', '/api/account/login', { username: name, password: pass1 })).r);
const guestJoin = await call('POST', '/api/join', { name: `g${name}`, age: true });
const guest = cookieOf(guestJoin.r);
ok('a guest', guestJoin.r.status === 200);
const tabletWs = await connect(tablet);
ok('before the code: the tablet is not let in', !(await inside(tablet)) && tabletWs.welcome()?.homes?.length === 0);

// The laptop types the code: the account keeps it; the tablet (already playing) is let in at once.
const unlock = await call('POST', '/api/home/unlock', { id: 'house', code }, laptop);
ok('the right code, logged in: the answer says the account keeps it', unlock.r.status === 200 && unlock.data?.account === true);
await wait(500);
const told = tabletWs.log.find((m) => m.t === 'inside' && m.id === 'house');
ok('the tablet is told at once, as the account\'s', told?.account === true);
ok('the tablet is let in without the code', await inside(tablet));
const g = await call('POST', '/api/home/unlock', { id: 'house', code }, guest);
ok('the guest types it too: no account in the answer', g.r.status === 200 && g.data?.account === undefined);
ok('the guest is in, this session', await inside(guest));

// The laptop logs out; a phone logs in later: in without the code, and its welcome says it is the account's.
await call('POST', '/api/logout', {}, laptop);
ok('the laptop\'s ended session is out', !(await inside(laptop)));
const phone = cookieOf((await call('POST', '/api/account/login', { username: name, password: pass1 })).r);
ok('a later login on another device is in', await inside(phone));
const phoneWs = await connect(phone);
ok('its welcome opens the house, as the account\'s', phoneWs.welcome()?.homes?.includes('house') && phoneWs.welcome()?.accountHomes?.includes('house'));
// The guest's next session has nothing.
await call('POST', '/api/logout', {}, guest);
const guest2 = cookieOf((await call('POST', '/api/join', { name: `h${name}`, age: true })).r);
ok('the guest\'s next session is locked out', !(await inside(guest2)));
const guestWs = await connect(guest2);
ok('and its welcome opens nothing', guestWs.welcome()?.homes?.length === 0 && guestWs.welcome()?.accountHomes?.length === 0);

// The admin's list, and nobody else's.
const list = async () => (await call('GET', '/api/admin/homes', undefined, admin)).data?.rows?.find((r) => r.id === 'house')?.accounts?.map((a) => a.username) ?? null;
ok('the admin sees the account (and only accounts)', JSON.stringify(await list()) === JSON.stringify([name]));
ok('a player can\'t see the list', (await call('GET', '/api/admin/homes', undefined, phone)).r.status === 403);
ok('a player can\'t remove anyone', (await call('DELETE', `/api/admin/homes/house/access/${name}`, undefined, phone)).r.status === 403);
const cross = await fetch(`${o.api}/api/admin/homes/house/access/${name}`, { method: 'DELETE', headers: { Cookie: admin, Origin: 'https://evil.example' } });
ok('a cross-site remove is refused', cross.status === 403 && await inside(phone));

// Removed by the admin: out at once, on every device.
const rm = await call('DELETE', `/api/admin/homes/house/access/${name}`, undefined, admin);
ok('the admin removes it', rm.data?.removed === 1);
ok('the account is out, on the phone and the tablet', !(await inside(phone)) && !(await inside(tablet)));
await call('POST', '/api/home/unlock', { id: 'house', code }, phone);
ok('typing the code again brings it back', await inside(tablet));

// A new code (a leaked one): every account's access made with the old one ends.
code = (await call('POST', '/api/admin/homes/house/code', {}, admin)).data?.code;
ok('a new code: the account is out', !(await inside(phone)) && !(await inside(tablet)) && (await list())?.length === 0);
await call('POST', '/api/home/unlock', { id: 'house', code }, phone);
ok('the new code typed: in again', await inside(tablet));

// A new password ends the other sessions: the tablet is out; the phone's new session keeps the account's access.
const changed = await call('POST', '/api/account/password', { old: pass1, password: pass2 }, phone);
const phone2 = cookieOf(changed.r);
ok('a new password', changed.r.status === 200 && !!phone2);
ok('the sessions from before it are out', !(await inside(tablet)) && !(await inside(phone)));
ok('the session it gave is in', await inside(phone2));

// Deleting the account takes the access with it; a new account under the name starts without it (once its game
// connections are gone: a name someone plays under can't be signed up).
for (const c of [tabletWs, phoneWs]) c.ws.close();
await wait(1500);
const del = await call('POST', '/api/account/delete', { password: pass2 }, phone2);
ok('the account is deleted', del.r.status === 200);
ok('the admin\'s list is empty', (await list())?.length === 0);
const again = await call('POST', '/api/account/register', { username: name, email: `${name}@example.org`, password: pass1, age: true });
const fresh = cookieOf(again.r);
ok('a new account under the name has no access', again.r.status === 200 && !(await inside(fresh)), `${again.r.status} ${again.data?.code ?? ''}`);
await call('POST', '/api/account/delete', { password: pass1 }, fresh);

guestWs.ws.close();
await call('POST', '/api/logout', {}, guest2);
await call('DELETE', '/api/admin/homes/house/code', undefined, admin); // the throwaway code goes too
await call('POST', '/api/logout', {}, admin);
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
