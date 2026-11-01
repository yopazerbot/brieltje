# Contributing to Brieltje

Thank you for wanting to help. Yoshi is happy to accept contributions. These are especially welcome:

- bug reports and fixes
- performance work
- accessibility
- translations (the game is in Dutch and English)
- new details of Smetlede and Briel

## How to contribute

1. For anything big, open an issue first. Describe what you have in mind. Then nobody builds something that can't go in.
2. Fork the repository and make a branch for your change.
3. Open a pull request to `main`.

`main` deploys live to brieltje.be. That is why only Yoshi merges, after a review. Keep each pull request small and about one thing. In the description, say what you tested: the browser, the device and the graphics preset (Auto, Low, Medium, High or Ultra).

## Run it locally

You need Node.js 22 or newer. brieltje.be only opens in Belgium. A local copy works anywhere.

```
cd web
npm install
npm run dev
```

Open http://localhost:5173. This is the game with solo play. It reloads when you save a file.

Multiplayer and login go through the Node server on port 8080. The dev page passes `/api` and `/ws` on to it. Start it in a second terminal, also in `web/`:

```
ADMIN_PASSWORD=pick-your-own MULTIPLAYER_PIN=1234 npm start
```

In PowerShell, set each variable first with `$env:NAME='value'`. Pick a throwaway admin password that you use nowhere else. You only need it to test the admin tools. `MULTIPLAYER_PIN` sets the PIN your local game starts with. The server keeps its data in `web/.data/`. Git ignores that folder.

## Before you open a pull request

- `npm run build` in `web/` must pass. It runs the TypeScript check (`tsc`) before the Vite build. `npm run check` runs the type check alone.
- Play your change in the browser. Try the Low preset too.
- If players see your change, check it on a phone or a tablet. Add `?diag` to the address for a panel that shows what the graphics chip is doing. It helps on a phone without a console.
- On the dev page, `briel.bench()` in the browser console reports the time per frame. Run it twice. The first run includes shader compiles. Compare with and without your change in the same session.

## Code conventions

- The game is TypeScript and Three.js, built with Vite. The server is plain Node (`web/server.mjs` and `web/server/`). Code for both sides lives in `web/shared/`.
- Comments explain why, in plain sentences. Any file in `web/src/` shows the tone.
- Every text a player sees goes in `web/src/i18n.ts`, in English and in Dutch. The Dutch is Flemish usage with the informal "je". `tsc` fails when the Dutch misses a key or a placeholder. Messages from the server carry a `code` that the page translates.
- The game is limited by the pixels the graphics chip shades, above all on laptops. Prefer textures, instancing and work on the CPU over heavy fragment shaders.
- Don't use 32-bit float textures with linear filtering. Older iPads can't filter them. WebGL then reads them as black. Half floats work everywhere.
- Keep HDR values, light intensities and emissive values under 65504, the half-float limit. An iPhone turns a larger value into infinity. Surfaces then go black.
- Phones and iPads must keep working: the touch controls, the layout and the frame rate.
- For a bigger choice, add a row to `DECISIONS.md` with what you chose and why.

## What to respect

These rules are firm. A pull request that breaks one can't be merged.

**Privacy.** Smetlede and Briel are real places. Real neighbours live there.

- No house numbers of neighbours.
- No people's names or other personal data.
- No photos of people.
- No private files in commits.
- Your own commits are public too. GitHub's noreply email address keeps yours out of the history.

**Assets.**

- Only self-made or licence-free assets (CC0 or similar). When a licence asks for credit, add it to `docs/CREDITS.md` and `web/public/legal/credits.html`.
- Google Maps, Street View and other map imagery are a visual reference only. Never copy them or trace them into textures. Never download them into the repository.
- No brand logos on models or textures.

**Security.**

- Never commit secrets, tokens or passwords.
- Report a security problem privately by email (see Contact). Please don't open a public issue for it.
- The server doesn't trust the client. It checks every message a page sends. Don't weaken those checks. A new message needs its own check.
- Text from the dictionaries or from players only goes into the page as text (`textContent`).

**Content.** Families and kids play this game. It even has a child-friendly Paintball mode. Keep everything suitable for them.

**The privacy policy.** `web/public/legal/privacy.html` describes exactly what is logged and kept. Any change to what the game or the server collects must update it. Update the English and the Dutch text.

## Contact

- Questions, ideas and bugs: open a GitHub issue.
- Security problems or anything private: email Yoshi at yoshi@olive-security.be.

## Licence

The project is licensed under [CC BY-NC 4.0](LICENSE). By opening a pull request, you agree that your contribution is published under the same licence.

Thank you for helping.
