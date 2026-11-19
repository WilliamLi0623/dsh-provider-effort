# Provider effort injector

Automatically gives every third-party (pi-ai) provider route in DSH a reasoning-effort capability and a default effort level, so models behind OpenAI-compatible gateways, Anthropic, Gemini, and other non-DeepSeek routes can think without hand-editing each provider.

## How it works

DSH's pi-ai adapter already owns the effort pipeline: a route profile field `reasoning` becomes each model's advertised `defaultEffort`, and the LLM runtime materializes that default into every request that omits an effort. What is usually missing on third-party routes is the configuration itself — hand-declared gateway models declare no `reasoningEfforts`, so no level can be selected and no effort travels on the wire.

This plugin closes that gap at configuration level. On startup and on every relevant configuration change it reconciles the `llm-pi-ai` settings namespace:

1. **Capability injection** — on hand-declared gateway routes, any `models` entry without `reasoningEfforts` gets one injected (`off` plus the configured levels). Declared maps (including `false`) are never rewritten. Narrowed catalog routes keep their models' installed-catalog capability, because a declared map would replace the catalog's wire spellings; their route default still applies once runtime verification confirms every model supports the level.
2. **Route default** — when every model of a route supports the configured effort level, the plugin writes the route-level `reasoning` default. From then on, every request that omits an effort automatically carries the level; the wire parameter follows the protocol (`reasoning_effort` on OpenAI-compatible endpoints, thinking budgets on Anthropic, thinking config on Gemini).
3. **Per-model defaults** — `routes.<route>.effortByModel` names a level per model id. The plugin teaches DSH's LLM runtime to advertise that level as the model's `defaultEffort` in its model metadata, so requests that omit an effort materialize it on every resolution path (prepared calls, direct streams, standalone resolution), the effort is marked adapter-supplied (session selections re-resolve it instead of pinning it), and model pickers show it. An explicit request effort always wins; the configured level must be among the model's selectable efforts.
3. **Safety first** — routes where some models cannot take the level (for example a mixed OpenAI catalog with `gpt-5`-style and `gpt-4.1`-style models) keep no route default, so non-reasoning models never fail with `UNSUPPORTED_REASONING_EFFORT`. Per-route overrides can force the default when you know every model on the route thinks.

All writes go through DSH's settings service into the active profile patch: they survive restarts, stay visible in **Settings > Models**, and are fenced by revision to never clobber concurrent edits.

## Configuration

Plugin settings (editable live in **Settings > Plugins**, section `provider-effort`):

| Field | Default | Meaning |
|---|---|---|
| `effort` | `medium` | The effort level injected as the route default. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `levels` | `off, minimal, low, medium, high` | Levels offered by injected `reasoningEfforts` maps. |
| `namespace` | `llm-pi-ai` | The adapter's settings namespace the plugin reconciles. |
| `skip` | `[]` | Route names the plugin must leave alone entirely. |
| `routes` | `{}` | Per-route overrides keyed by route name: `effort`, `levels`, `skip`, `force` (set the route default even when not every model verified), `routeDefault: false` (never set the route default for this route). |

## Behavior details

- **Idempotent and self-healing**: the plugin only writes missing fields; removing an injected field from the Models page brings it back on the next reconciliation, and its own writes never loop.
- **No request interception**: the plugin never touches model requests; it only adjusts provider configuration through DSH's supported settings path, so the "model-visible ⟺ logged" guarantee of the LLM runtime is preserved and the turn's call-config header still shows the effort as an adapter-supplied default.
- **Keyless catalog routes** are skipped for the route default until their model list can be enumerated (store an API key on the route); hand-declared gateway routes work without credentials because their models come from the stored profile.
- **DeepSeek routes are untouched**: `deepseek-official` belongs to the first-party adapter and is never modified.

## Limitations

- Requires a profiled boot (the settings service must be active); in a headless composition without it the plugin idles.
- A route whose profile carries a configuration error gets no route default until it is repaired (its model entries still receive capability injection when present).
- The plugin does not invent wire spellings: injected level maps use each level's own name as the wire value, which is correct for standard OpenAI-compatible gateways; gateways needing custom spellings should keep their hand-written `reasoningEfforts` (the plugin leaves declared maps untouched).
