# OpenDesigns

Personal, local-first design agent workspace. Prototypes, decks, code-to-video and the rest of the Open Design toolset, driven by free keyless providers (Mercury 3, ChatJimmy, Qwen, K2Horizon, Motif, DeepAI, LongCat, Gemini Web) or any OpenAI / Anthropic compatible endpoint you add.

No accounts, no onboarding, no telemetry, no update feed.

## Develop

```
pnpm install
pnpm tools-dev
```

## Build (Windows)

```
pnpm tools-pack win build --to all --portable
```

CI does the same on every push to `main`; tags `v*` publish a release.

## Layout

- `apps/daemon` local daemon: agent runs, skills, design systems, artifacts, provider adapters under `src/runtimes/zeus`
- `apps/web` Next.js UI
- `apps/desktop`, `apps/packaged` Electron shell
- `skills`, `design-systems`, `design-templates`, `plugins` content
