# IRONVEIL

An original browser real-time strategy game in the classic flow-economy tradition: a commander, streaming metal/energy income, assistable construction, wreck reclaiming and a tiered build ladder from light bots up to an experimental titan. Single-player skirmish against 1–3 AI opponents at four difficulty levels.

Everything is generated in code — terrain, 3D models, textures, particles, icons, sound and music. There are no external art or audio assets.

## Economy and tech ladder

Two resources, both paid gradually while something is under construction:

- **Metal** – Extractors on ore veins (Deep Extractors yield 4×), reclaiming wreckage, Transmuters (70 energy → 1 metal)
- **Energy** – Solar Arrays, Wind Turbines (variable), Tidal Turbines (water), Fusion Cores (tier 2)

| Stage | Built by | Unlocks |
| --- | --- | --- |
| Prime (commander) | – | Extractor, Solar, Wind, Tidal, storage, Bot Foundry, Vehicle Works, Aerodrome, Shipyard, Sentry, Flak Spire, Radar |
| Bot Foundry | Prime / constructors | Wright (constructor), Jackal, Brawler, Lancer, Skewer (AA) |
| Vehicle Works | Prime / constructors | Hauler (constructor), Dart (scout), Maul (tank), Howl (artillery) |
| Aerodrome | Prime / constructors | Kestrel (scout), Talon (fighter), Anvil (bomber), Vulture (gunship) |
| Shipyard (on water) | Prime / constructors | Skiff, Corsair (destroyer), Leviathan (battleship) |
| Wright / Hauler | T1 factories | everything above plus Transmuter, Bastion, **Advanced Forge** |
| Advanced Forge | constructors | Archwright (T2 constructor), Reaver, Goliath, Tempest |
| Archwright | Advanced Forge | Deep Extractor, Fusion Core, Sunlance, Thunderhead (strategic artillery), **Colossus** (experimental) |

Explosions start fires that spread through vegetation and across buildings (wind-driven), leave permanent craters, scorch marks and reclaimable wreckage.

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
- `src/scenery.ts` – water shader, vegetation, procedural textures
- `src/ui.ts` – HUD, input, minimap
- `src/audio.ts` – synthesized sound effects and the generative orchestral score
