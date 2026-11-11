# IRONVEIL

An original browser real-time strategy game in the classic flow-economy tradition: a commander, streaming metal/energy income, assistable construction, wreck reclaiming and a tiered build ladder from light bots up to an experimental titan. Single-player skirmish against 1–3 AI opponents at four difficulty levels.

Everything is generated in code — terrain, 3D models, textures, particles, icons, sound and music. There are no external art or audio assets.

## Run

```bash
npm install
npm run dev      # local dev server
npm run build    # production build in dist/ (Vercel auto-detects Vite)
npm run sim      # headless AI-vs-AI soak test, e.g. `npm run sim -- 1,3 30 777`
```

## Layout

- `src/sim.ts` – fixed-step simulation (economy, orders, movement, combat, fog of war); no rendering imports
- `src/map.ts` – symmetric procedural terrain, ore placement, A* pathfinding
- `src/defs.ts` – all unit/structure stats and procedural model recipes
- `src/ai.ts` – skirmish AI (economy planner, production, squads, raids, air wing)
- `src/render.ts` – three.js renderer and effects
- `src/ui.ts` – HUD, input, minimap
- `src/audio.ts` – synthesized sound
