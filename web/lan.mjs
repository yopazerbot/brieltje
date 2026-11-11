// A LAN night on this computer (Yoshi, 11 Nov 2026: "I will host locally"): builds the game if needed, asks for an admin
// password for tonight (typed, never shown, never saved), starts the server and says which address the players type.
//
//   npm run lan              (in web/, without Docker; lan.cmd in the repository's folder runs the game in Docker)
//   npm run lan -- --port 8090 --build
//
// The server keeps tonight's players, accounts and rules in web/.data/ on this computer, apart from brieltje.be's.
// Nothing here needs the internet. Players on the same network open the address in their browser; the host opens the
// host screen (/admin/host/) after logging in on /admin/, and the big screen (/admin/scores/) on a TV.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(value('port', process.env.PORT || '8080'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm is a script on Windows: run through the shell, as one fixed line (no input of anyone's in it).
const run = (cmd, list) => spawnSync([cmd, ...list].join(' '), { cwd: here, stdio: 'inherit', shell: true }).status === 0;

/** The newest change under a folder (ms), to tell whether the build is older than the game's files. */
function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

/** A password typed without showing it. */
function secret(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) rl.output.write(question);
      else if (s.includes('\n') || s.includes('\r')) rl.output.write('\n');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

console.log('\nBrieltje: a LAN night on this computer\n');
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.log(`Node ${process.versions.node} is too old: install Node 20 or newer from nodejs.org.`);
  process.exit(1);
}
if (!existsSync(join(here, 'node_modules'))) {
  console.log('First time: installing the game\'s packages (a few minutes)...');
  if (!run(npm, ['ci'])) process.exit(1);
}
const dist = join(here, 'dist', 'index.html');
const stale = existsSync(dist) && ['src', 'public', 'shared'].some((d) => newest(join(here, d)) > statSync(dist).mtimeMs);
if (!existsSync(dist) || flag('build') || stale) {
  console.log(existsSync(dist) ? 'The game changed since the last build: building it again (a few minutes)...' : 'Building the game (a few minutes)...');
  if (!run(npm, ['run', 'build'])) process.exit(1);
}

let password = process.env.ADMIN_PASSWORD ?? '';
while (password.length < 8) {
  password = await secret('An admin password for tonight (at least 8 characters, not shown): ');
  if (password.length < 8) console.log('Too short. Try again.');
}

// This computer's addresses on its networks: the real ones (Wi-Fi, a cable) first; virtual adapters (WSL, VirtualBox,
// Hyper-V, Docker, VMware, VPNs) after, as players can't reach those.
const VIRTUAL = /vethernet|virtualbox|wsl|hyper-v|docker|vmware|vpn|tailscale|zerotier|loopback|bluetooth/i;
const found = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address, virtual: VIRTUAL.test(name) || a.address.startsWith('169.254.') })));
const addresses = found.filter((a) => !a.virtual).map((a) => a.address);
const others = found.filter((a) => a.virtual);
const server = spawn(process.execPath, ['server.mjs'], { cwd: here, env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
let shown = false;
const show = () => {
  if (shown) return;
  shown = true;
  const line = '-'.repeat(60);
  console.log(`\n${line}`);
  if (addresses.length) {
    console.log('Players type this in their browser (same network):\n');
    for (const a of addresses) console.log(`    http://${a}:${port}`);
    if (others.length) console.log(`\n  (not for players: ${others.map((a) => `${a.address} on ${a.name}`).join(', ')})`);
  } else {
    console.log('No network found: only this computer can play (http://localhost:' + port + ').');
  }
  console.log(`\nYou, the host:   http://localhost:${port}/admin/  (log in as admin), then /admin/host/`);
  console.log(`Watch players:   http://localhost:${port}/admin/watch/  (one player or up to four side by side)`);
  console.log(`The big screen:  http://localhost:${port}/admin/scores/  (F for full screen)`);
  console.log(`\nWindows may ask whether Node.js may use the network: allow it on private networks.`);
  console.log(`Stop the server: Ctrl+C in this window.\n${line}\n`);
};
// The server's own lines are JSON; only what matters tonight is shown.
const read = (data) => {
  for (const raw of String(data).split('\n').filter(Boolean)) {
    let m = null;
    try {
      m = JSON.parse(raw);
    } catch {
      console.log(raw);
      continue;
    }
    if (m.event === 'started') show();
    else if (/failed|error/i.test(m.event ?? '') && !/missing/.test(m.event ?? '')) console.log(`  ! ${m.event}${m.error ? `: ${m.error}` : ''}`);
  }
};
server.stdout.on('data', read);
server.stderr.on('data', (d) => {
  const s = String(d);
  if (s.includes('EADDRINUSE')) console.log(`\nPort ${port} is already in use. Start with another: npm run lan -- --port 8090`);
  else read(s);
});
server.on('exit', (code) => {
  console.log(`\nThe server stopped${code ? ` (code ${code})` : ''}.`);
  process.exit(code ?? 0);
});
process.on('SIGINT', () => server.kill('SIGINT'));
