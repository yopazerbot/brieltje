// Cuts the Zombies trailer from what record.mjs and extras.mjs filmed, titles.mjs drew and music.mjs made: the intro,
// eighteen short cuts on the beat (each with the game's own sound from that moment, some with a caption), the outro, and the
// music under it all. Needs ffmpeg (not in the repository: give its path).
//
//   node tools/dev/trailer/edit.mjs --take <record's folder> --titles <titles' folder> --music music.wav
//       --ffmpeg <ffmpeg.exe> --out trailer.mp4 [--work <folder for the pieces>]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { options } from '../cdp.mjs';

const o = options({ take: '', titles: '', music: '', ffmpeg: 'ffmpeg', out: 'trailer.mp4', work: '' });
if (!o.take || !o.titles || !o.music) throw new Error('--take, --titles and --music are needed');
const work = resolve(o.work || join(o.take, 'edit'));
mkdirSync(work, { recursive: true });
const scenes = JSON.parse(readFileSync(join(o.take, 'scenes.json'), 'utf8'));
const ff = (...args) => execFileSync(o.ffmpeg, ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

// The cuts: scene, camera, where it starts in that camera's take (seconds), how long (the music's beat is 0.4 s),
// and a caption's number (titles.mjs --captions, from 1). 35.2 s in all: 22 bars.
const CUTS = [
  ['drop', 'eyes', 9.5, 2.0, 1], // the jump over the village
  ['drop', 'eyes', 12.6, 1.2], // the parachute opens over the church
  ['car', 'eyes', 6.0, 1.6, 2], // flat out up the road into Smetlede
  ['runners', 'watch', 18.5, 2.4, 3], // the church square, a zombie in front
  ['runners', 'watch', 10, 2.0], // over the players' shoulders
  ['wood', 'eyes', 15.2, 2.4, 4], // through the sniper's scope
  ['wood', 'watch', 26, 2.0], // from among the zombies, the cafe behind
  ['wood', 'eyes', 24.2, 2.0],
  ['rain', 'watch', 10.5, 2.0, 5], // the players' faces in the rain
  ['rain', 'eyes', 12.2, 2.0], // the shotgun, two teammates ahead
  ['rain', 'watch', 18.2, 1.6],
  ['wood', 'watch', 31, 2.0], // from above
  ['snow', 'watch', 2, 2.0, 6],
  ['snow', 'watch', 17, 1.6],
  ['snow', 'watch', 22, 2.4],
  ['dusk', 'watch', 29, 2.0], // the four of them at dusk, the church behind
  ['dusk', 'watch', 22, 2.0], // from the side, a zombie coming in
  ['wood', 'eyes', 28, 2.0, 7],
];
const VIDEO = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '30'];
const AUDIO = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const parts = [];

// The intro and the outro: their frames, silent.
for (const t of ['intro', 'outro']) {
  const file = join(work, `${t}.mp4`);
  ff('-framerate', '30', '-start_number', '1', '-i', join(o.titles, t, 'frame-%06d.jpg'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', ...VIDEO, ...AUDIO, file);
  if (t === 'intro') parts.push(file);
}
for (const [i, [name, cam, start, dur, caption]] of CUTS.entries()) {
  const sc = scenes[name];
  if (!sc) throw new Error(`scene ${name} is not in ${o.take}`);
  const dir = join(o.take, name, cam);
  const soundFrom = Math.max(0, sc[cam].t0 + start - sc.soundAt); // the same moment in the sound of the player's own page
  const file = join(work, `cut-${String(i + 1).padStart(2, '0')}.mp4`);
  const fill = 'fps=30,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1';
  const fade = `afade=t=in:d=0.04,afade=t=out:st=${(dur - 0.06).toFixed(2)}:d=0.06`;
  const inputs = ['-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-ss', String(soundFrom), '-t', String(dur), '-i', join(o.take, name, 'sound.webm')];
  if (caption) {
    ff(...inputs, '-loop', '1', '-i', join(o.titles, 'captions', `caption-${caption}.png`),
      '-filter_complex', `[0:v]trim=start=${start}:duration=${dur},setpts=PTS-STARTPTS,${fill}[v];[2:v]format=rgba,fade=t=in:st=0.1:d=0.2:alpha=1,fade=t=out:st=${(dur - 0.45).toFixed(2)}:d=0.3:alpha=1[c];[v][c]overlay=shortest=1[o];[1:a]${fade},apad[a]`,
      '-map', '[o]', '-map', '[a]', '-t', String(dur), ...VIDEO, ...AUDIO, file);
  } else {
    ff(...inputs, '-filter_complex', `[0:v]trim=start=${start}:duration=${dur},setpts=PTS-STARTPTS,${fill}[o];[1:a]${fade},apad[a]`, '-map', '[o]', '-map', '[a]', '-t', String(dur), ...VIDEO, ...AUDIO, file);
  }
  parts.push(file);
  console.log(`cut ${i + 1}: ${name} ${cam} from ${start} s for ${dur} s${caption ? `, caption ${caption}` : ''}`);
}
parts.push(join(work, 'outro.mp4'));

// Joined, then the music under it: the game's sound a little under the music's beat.
const list = join(work, 'parts.txt');
writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n') + '\n');
const joined = join(work, 'joined.mp4');
ff('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined);
ff('-i', joined, '-i', o.music, '-filter_complex', '[0:a]volume=1.5[g];[1:a]volume=0.85[m];[g][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]',
  '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...AUDIO, '-movflags', '+faststart', o.out);
console.log(o.out);
