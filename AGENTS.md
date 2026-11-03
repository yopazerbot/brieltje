# Agents

Rules for AI agents working on Brieltje: Claude Code sessions, their subagents, and any other coding tool. Often several agents work at once on one PC, each in its own git worktree. These rules keep their work aligned and out of each other's way. Read this file in full before you change anything.

Then read:

- [CONTRIBUTING.md](CONTRIBUTING.md). Its rules apply to every contributor, agents included.
- [README.md](README.md) for what the game is.
- [docs/DETAILS.md](docs/DETAILS.md) for running, hosting and the folders.
- [DECISIONS.md](DECISIONS.md) for every choice and why. It has over 200 long rows, so search it for your topic instead of reading it whole. Before you change how something works, find the row that chose it. Don't undo a choice Yoshi made without asking.

## Who does what

- **Yoshi** owns the project. Yoshi is a cybersecurity consultant, not a game developer. Requests come in English or in Dutch (Flemish). Yoshi decides on design, content and everything a player sees.
- **The lead session** is the session Yoshi talks to. It splits the work into tasks, briefs the workers, reviews their work, merges into `main` and pushes.
- **A worker** does one task in its own worktree, on its own branch, and commits there. A worker never pushes. It never checks out, changes or merges `main`.

Only the lead session merges and pushes. If you are not sure which one you are, you are a worker.

## Before you start (workers)

- Check where you are. `git rev-parse --show-toplevel` should be a folder under `.claude/worktrees/`. `git branch --show-current` must not be `main`. If you are in the main checkout, stop and tell the lead session. Two sessions in one checkout overwrite each other's files.
- Check your base. `git merge-base HEAD main` should be the newest commit on `main`. If it isn't, say so in your report.
- `web/node_modules` is not shared between worktrees. If it is missing, run `npm ci` in `web/`. That leaves `package-lock.json` as it is.
- Stay inside your task. Something else broken goes in your report. Don't fix it on the side.

## Files many agents touch

Most merge conflicts come from a few files. These changed most often since 31 October 2026:

| File | What it holds |
|---|---|
| `web/src/main.ts` | The game's main file, about 3300 lines |
| `DECISIONS.md` | One row per choice |
| `web/src/i18n.ts` | Every text a player sees |
| `web/server/game.mjs` | The multiplayer server |
| `web/index.html`, `web/src/style.css` | The page and its styles |
| `web/src/net/client.ts` | The page's side of multiplayer |
| `web/public/legal/privacy.html` | The privacy policy |

In these files:

- Make the smallest change that works. Put new logic in a module of its own and call it from `main.ts`.
- Don't reformat, reorder, rename or move code you aren't changing. Never run a formatter over a whole file.
- Put new i18n keys next to related keys. Write the English and the Dutch at once.
- In `DECISIONS.md`, only add rows at the bottom. Never edit or move another row.
- Leave `README.md`, `PROGRESS.md` and `docs/DETAILS.md` alone. The lead session updates them after a merge.

**Generated files.** `web/src/data/*.json`, `web/public/models/*.glb` and parts of `web/shared/` come out of the tools in `tools/`. Only change them by running their tool, and only when your task needs it. Two branches that both regenerate a file can't be merged by hand. Name the tool and its arguments in your report so the lead can run it again on the merged result.

**Dependencies.** No new npm or Python packages without Yoshi's yes. Ask the lead session. Most things here are made in code on purpose, sounds included.

## One PC, shared

All agents run on the same Windows PC. It has one graphics chip.

- **Ports.** Leave 5173 and 8080 free for Yoshi and the lead. Pick your own: Vite in 5200 to 5999 (`npx vite --port <n> --strictPort`), the server in 8100 to 8999 (`PORT=<n> node server.mjs`). The dev server's proxy always points at 8080. Test multiplayer against a build on your own port instead: `npm run build`, then start `server.mjs`.
- **Processes.** Write down the process ID of every server, browser and Blender you start. Stop them all before you report. Never stop a process you didn't start. Other agents' servers look just like yours, so never kill by name (`taskkill /IM node.exe`, `pkill node`).
- **The graphics chip.** Other agents' browsers and Blender renders use it too, so frame times wander. To measure a change, run with and without it in one session, alternating A, B, A, B. Run a warm-up `briel.bench()` first: the first run includes shader compiles. Report the numbers and say the chip was shared. Numbers from different sessions can't be compared.
- **Heavy jobs.** Blender renders and long bakes slow everyone down. Run them only when the task needs them. Keep preview renders small.
- **Test data.** Each worktree has its own `web/.data/` (git-ignored). Use a throwaway `ADMIN_PASSWORD`, generated in the shell, never printed or written down. Delete your test users afterwards. Never use `DATABASE_URL` or any other Railway variable on this PC.
- **Scratch files** go in your session's scratchpad or temp folder, never in the repo.

## Windows and the shell

- Files use LF line endings (`.gitattributes`). Write and edit code with the editor tools. Don't patch code through a shell heredoc or `node -e "..."`. The shell turns `\uXXXX` into real characters and runs backticks as commands, and the command still exits 0.
- Python on Windows writes CRLF in text mode. Open files with `newline=''`.
- After a scripted edit, run `node --check` on each JS file and look for `\r\n`.
- PowerShell sets a variable with `$env:NAME='value'`. Git Bash takes `NAME=value command`.
- The Python tools run from `tools/.venv` (see docs/DETAILS.md). Blender scripts run headless: `blender -b -P tools/<script>.py -- <args>`.

## Firm rules

These come from CONTRIBUTING.md, plus a few that only agents need. A change that breaks one can't be merged.

**Privacy.** The repository is public. Smetlede and Briel are real places, and real neighbours live there.

- No house numbers, addresses or names of people. No personal data, and no photos of people. A house's overrides are keyed by model coordinates, never by address.
- Nothing from `source/` or `images/` goes into a commit. Both folders are private and git-ignored. That covers the files, their names and anything copied out of them. Only data built by the tools goes in.
- Never say where the main house's layout comes from. That holds for code, comments, commit messages, docs, file names and text in the game. Write "the main house", "the starting layout", "the reference images" or "private source files". The lead session checks every merge for words that give the source away.
- Keep git's author settings as they are. Commits use a GitHub noreply address.
- Push only `main`, only to `origin`. Never push another branch.

**Content.** Families and children play this game. Keep everything suitable for them. The school grounds stay free of shooting.

**Assets.**

- Self-made or CC0 only. When a licence asks for credit, add it to `docs/CREDITS.md` and `web/public/legal/credits.html`.
- Maps, Street View and other map imagery are a reference only. Never copy them, trace them or download them into the repository.
- No brand logos on models or textures.
- A real object (a car, a product) gets built in Blender from its published sizes. Photos are only for comparing.
- Fetch downloads yourself, from sources without a login. Never ask Yoshi to download something. In your report, give each file's name, source, licence and size.

**Security.** Yoshi works in security and reads every change with that eye.

- The server trusts no message from a page. A new message type gets its own check on the server: types, ranges, rate, and who may send it. Never weaken an existing check. In multiplayer the server decides every hit, pickup and trip.
- Text from players or from the dictionaries goes into the page with `textContent` only.
- No secrets in commits, logs or reports.
- A change to HTTP headers, compression, caching, cookies, logins, sessions, uploads, the WebSocket or a new endpoint names its attack class (for example BREACH, cache poisoning, CSRF, hit forgery). Say why the change is safe. Put that in the DECISIONS row and in your report, without being asked.
- Anything new that the game or the server collects or logs goes into `web/public/legal/privacy.html`, in English and in Dutch.

**Text a player sees.** It lives in `web/src/i18n.ts`, in English and in Dutch. The Dutch is Flemish usage with the informal "je". `tsc` fails when the Dutch misses a key or a placeholder. A server message carries a `code` that the page translates. Key hints follow the way the player plays: AZERTY or QWERTY, controller, or touch.

**Graphics.**

- The graphics chip is the limit, and its cost follows the pixels it shades. Prefer textures, instancing and work on the CPU over heavy fragment shaders. Full-screen effects are for Medium and up.
- No 32-bit float textures with linear filtering. Older iPads read them as black.
- Keep everything that goes into half-float targets under 65504: HDR skies, lights, emissive values. An iPhone stores a larger value as infinity, and surfaces go black.
- Phones and iPads must keep working: the touch controls, the layout and the frame rate.

## Checks before you hand back

1. `npm run build` in `web/` passes. It runs `tsc` first.
2. You saw the change work. Without a screen, use a headless browser: a Playwright Chromium is installed under `%LOCALAPPDATA%\ms-playwright\`. Drive it from a small Node script over the DevTools protocol. The dev build has `window.briel` (teleport, walk, fire, bench and more) once the start screen is clicked through (`#choose-kbm`).
3. You tried the Low preset. If players see the change, you also tried a phone (touch emulation).
4. A change to multiplayer was tested with a local server on your own port and two clients.
5. For "black on iPhone or Mac" bugs, run Chromium with SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader`). It stores half-float overflow as infinity, as Apple's chips do.
6. `git diff main...HEAD --stat` shows only the files of your task. No debug code, test data or CRLF is left in.

## Commits

- One thing per commit.
- The subject says what changes, in plain words, with the area first: `Zombies: a turret from the big ones, a temporary helper that shoots the nearest zombie it sees`.
- The body says what was wrong or what was asked, then what it does now. Wrap it at about 100 characters. End with the trailer your tool adds (`Co-Authored-By: ...`).
- A bigger choice adds one row at the bottom of `DECISIONS.md`:
  `| YYYY-MM-DD | **The choice in a few words** (Yoshi: "their own words") | Why, how it plays, and a **Security** part when it applies. |`
- Never skip hooks (`--no-verify`). Never amend or rebase a commit that is on `main`. Never force-push.

## Your report (workers)

The lead session only sees your report, not your work. Write it in plain words:

- your branch and its commits;
- what changed, as a player sees it;
- the files you touched, with the shared ones marked;
- how you tested, with the numbers, and what you couldn't test (a real iPhone, a real controller, a quiet graphics chip);
- security notes;
- choices you made that may be Yoshi's to make, and open questions;
- anything outside your task you noticed and left alone;
- that your processes are stopped and your test data deleted.

Don't report a check as passed unless you ran it. If it failed, give the output.

## Merging and deploying (lead session)

- Every push to `main` deploys to brieltje.be on Railway, built from `web/`. Yoshi doesn't want to be asked before each push. Push once the work is merged and tested.
- Brief each worker with its task, the files it may touch, what's ruled out, and the exact words that would give the house's source away. That brief is the worker's only context besides this file.
- Bring a worker's branch in by fast-forward or cherry-pick onto the current `main`. A branch that doesn't share history with `main` can only be cherry-picked.
- Where two branches both added rows to `DECISIONS.md`, keep both rows, in commit order.
- On the merged result: run `npm run build`, run again any tool that two branches both used, and test again where two branches meet.
- Check the diff for the words that give the source away, for house numbers, names and secrets, and for CRLF.
- After the push, check that the Railway deploy finished and that brieltje.be answers.
- Once a feature is in, update `README.md`, `PROGRESS.md` and `docs/DETAILS.md` in a commit of its own.
- Remove a worker's worktree once its work is on `main`. Before you remove an older one, check `git log main..<branch>` for commits that never landed. Leave locked worktrees alone.

## Talking to Yoshi (lead session)

- Plain words and short sentences. Explain a technical term the first time.
- Ask before a choice that is Yoshi's: what players see, the rules of a game, content, anything about real people or places. Don't ask what you can find out yourself.
- Say what you tested and what you didn't. If something failed, say so.
