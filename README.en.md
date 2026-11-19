# @local/dsh-provider-effort

[简体中文](README.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | English

Automatically injects reasoning effort into DSH's third-party providers (`@deepseek-ai/dsh-llm-pi-ai` routes): capability (selectable levels per model) and a default level (carried automatically on every request).

## Install

**Option 1: Clone from GitHub** (`WilliamLi0623/dsh-provider-effort`)

```sh
git clone https://github.com/WilliamLi0623/dsh-provider-effort.git
```

Then in DSH open **Plugins > Add plugin** and select the cloned directory (`dsh-provider-effort/`).

**Option 2: Install from a local directory**

Select this directory (`provider-effort/`), or in a session that has the `plugin_manager` tool run:

```text
plugin_manager action: install_bundle, target: <absolute path to this directory>
```

Once installed it applies to every session and survives restarts (writes persist through the profile patch).

### Local development note

`dsh plugin --profile <name> add <local directory>` installs via a pnpm `link:` dependency: **the plugin's transitive dependencies are not installed** (such as `@deepseek-ai/schemastery`), and Node resolves imports through the symlink's real path, so the plugin fails to load. For local development install from a tarball instead (identical to GitHub/registry installs):

```sh
npm pack   # run inside the plugin directory; produces local-dsh-provider-effort-1.0.0.tgz
dsh plugin --profile <name> add <path to the .tgz>
```

## What it does

- **Capability injection**: model entries in the stored `models` list of hand-declared gateway routes that lack `reasoningEfforts` receive an injected level map (`off` plus the configured levels). From then on the model offers an effort choice, the UI shows the levels, and validation passes. Narrowed catalog routes keep their models' installed-catalog capability, because a declared map would replace the catalog's wire spellings; their route default still applies once runtime verification confirms every model supports the level.
- **Route default**: when every model of a route supports the selected level, the route-level `reasoning` default is written. From then on every request that omits an effort carries it automatically (materialized by the runtime's `requested ?? reasoning.defaultEffort`); OpenAI-compatible gateways see `reasoning_effort` on the wire.
- **Safety**: mixed-capability routes (where some models cannot take the level) get no route default, so non-reasoning models never fail with `UNSUPPORTED_REASONING_EFFORT`. Force it with `routes.<route>.force: true`. DeepSeek's first-party routes are never touched.
- **Idempotent self-healing**: only missing fields are filled. Deleting an injected field on the Models page brings it back automatically, and no model request is ever intercepted or rewritten.

## Configuration (Settings > Plugins > provider-effort, live)

| Field | Default | Meaning |
|---|---|---|
| `effort` | `medium` | The injected default level: `off/minimal/low/medium/high/xhigh/max` |
| `levels` | `off, minimal, low, medium, high` | The `reasoningEfforts` level map injected into models |
| `namespace` | `llm-pi-ai` | The target adapter's settings namespace |
| `skip` | `[]` | Route names to leave completely untouched |
| `routes` | `{}` | Per-route overrides: `effort` / `levels` / `skip` / `force` / `routeDefault: false` / `effortByModel` |

**Per-model default efforts** (`routes.<route>.effortByModel`): a map from model id to that model's own default level — e.g. on the openai route, `gpt-5.1 → high`, `gpt-5-mini → low`. The plugin teaches DSH's LLM runtime to advertise the level as the model's `defaultEffort` in its model metadata, so requests that omit an effort materialize it on every resolution path (prepared calls, direct streams, standalone resolution), model pickers show it, and it is marked adapter-supplied (session selections re-resolve it instead of pinning it). **Precedence: explicit request effort > per-model > route-level `reasoning` > provider native.** The configured level must be among the model's selectable efforts (hand-declared routes get it through the injected capability map; a level missing from the `levels` list logs a warning).

## Verify

1. **Settings > Models**: third-party routes show the `reasoning` default, and models of hand-declared routes show `reasoningEfforts`.
2. Send one request through a third-party provider: the turn's call header shows `reasoningEffort` (an adapter default), and the gateway-side request body contains `reasoning_effort`.
3. Delete an injected field on the Models page → it comes back automatically after a moment.

## Limitations

- Requires a profiled boot (the settings service must exist); it idles in headless compositions without a profile.
- Catalog routes without a configured key skip the route default until their models can be enumerated (hand-declared gateway routes are unaffected).
