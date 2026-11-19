/**
 * Provider effort injector — automatically adds reasoning-effort capability
 * and a route-default effort to DSH's third-party (pi-ai) provider routes.
 *
 * The plugin never touches model requests. It reconciles the target adapter's
 * settings namespace through DSH's settings service:
 *
 * 1. Capability injection — model entries of stored routes that declare no
 *    `reasoningEfforts` receive one (`off` plus the configured levels), so the
 *    level becomes selectable and passes pi-ai's per-model validation.
 * 2. Route default — when every model of a route supports the configured
 *    level, the route-level `reasoning` default is written. DSH's LLM runtime
 *    then materializes it (`requested ?? reasoning.defaultEffort`) into every
 *    request that omits an effort, and the pi-ai adapter puts it on the wire.
 * 3. Per-model defaults — `routes.<route>.effortByModel` names a level per
 *    model id; the runtime's model metadata is taught to advertise it as that
 *    model's `defaultEffort`, so requests that omit an effort materialize it
 *    on every resolution path while explicit request efforts still win.
 *
 * Writes are missing-only, revision-fenced, idempotent, and persisted through
 * the active profile patch, so they survive restarts and stay visible in the
 * Models settings page. DeepSeek first-party routes belong to another adapter
 * and are never touched.
 *
 * @module @local/dsh-provider-effort
 */
import z from '@deepseek-ai/schemastery'

/** Every pi-ai thinking level a profile may declare, in escalation order. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const Level = z.union(LEVELS)

/** Plugin configuration; volatile fields stay editable live in Settings. */
export const Config = z.object({
  /** Effort level written as a route default when every model supports it. */
  effort: Level.default('medium').volatile(),
  /** Levels offered by injected `reasoningEfforts` maps (wire spelling = level name; `off` maps to null). */
  levels: z.array(Level).default(['off', 'minimal', 'low', 'medium', 'high']).volatile(),
  /** Settings namespace of the adapter whose provider routes this plugin reconciles. */
  namespace: z.string().default('llm-pi-ai').volatile(),
  /** Route names the plugin must leave untouched. */
  skip: z.array(z.string()).default([]).volatile(),
  /** Per-route overrides keyed by route name. */
  routes: z.dict(z.object({
    /** Route-specific effort level; falls back to the global `effort`. */
    effort: Level,
    /** Route-specific capability levels; falls back to the global `levels`. */
    levels: z.array(Level),
    /** Leave this route untouched entirely. */
    skip: z.boolean(),
    /** Set the route default even when verification fails or values differ. */
    force: z.boolean(),
    /** Never set the route default for this route (capability injection still applies). */
    routeDefault: z.boolean(),
    /**
     * Per-model default effort keyed by model id: when a request to this
     * route names the model and omits an effort, the runtime materializes
     * this level instead of the route default. An explicit request effort
     * still wins; the level must be among the model's selectable efforts.
     */
    effortByModel: z.dict(Level),
  })).default({}).volatile(),
})

/** Unwrap a live volatile reference; plain values pass through. */
function read(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * The plugin instance whose configuration the runtime metadata patch reads.
 * Module-level because the prototype patch outlives a single plugin
 * activation: a restarted instance re-points it at its own configuration.
 */
const activeRawConfig = { raw: undefined }

/** Build the capability map injected into model entries: `off` → null, level → level. */
function effortsMap(levels) {
  const map = {}
  for (const entry of levels) map[entry] = entry === 'off' ? null : entry
  return map
}

/** Whether one declared `reasoningEfforts` map supports the requested level. */
function supportsLevel(map, requested) {
  if (requested === 'off') return true
  if (map === undefined || map === null || map === false) return false
  const wire = map[requested]
  return typeof wire === 'string' && wire.length > 0
}

/**
 * Live plugin configuration as plain values, re-read on every access so
 * volatile edits take effect without a restart.
 */
function liveConfig(rawConfig) {
  return {
    effort: read(rawConfig.effort) ?? 'medium',
    levels: read(rawConfig.levels) ?? ['off', 'minimal', 'low', 'medium', 'high'],
    namespace: read(rawConfig.namespace) ?? 'llm-pi-ai',
    skip: read(rawConfig.skip) ?? [],
    routes: read(rawConfig.routes) ?? {},
  }
}

/** The per-model effort one route/model pair resolves to, or undefined. */
function perModelEffort(config, provider, model) {
  const rawRouteCfg = config.routes[provider]
  if (rawRouteCfg === undefined || rawRouteCfg === null || typeof rawRouteCfg !== 'object') return undefined
  const byModel = rawRouteCfg.effortByModel
  if (byModel === undefined || byModel === null || typeof byModel !== 'object') return undefined
  const level = byModel[model]
  return LEVELS.includes(level) ? level : undefined
}

/**
 * Host plugin entry. Idles until both the `llm` and `settings` services are
 * available (a composition without the settings service simply never runs).
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger ?? console
  logger.info('provider-effort: waiting for the llm and settings services')

  ctx.inject(['llm', 'settings'], (child) => {
    logger.info('provider-effort: active; reconciling third-party provider effort configuration')
    let timer
    let chain = Promise.resolve()

    const schedule = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        chain = chain.then(() => runReconcile()).catch((error) => {
          logger.warn('provider-effort: reconciliation failed: ' + describe(error))
        })
      }, 300)
    }

    child.effect(() => () => {
      if (timer !== undefined) clearTimeout(timer)
    })
    // Any settings or adapter change can move the target state; the reconcile
    // diff is what keeps this from looping on the plugin's own writes. A
    // re-assert also restores the per-model metadata patch if the LLM runtime
    // module was reloaded under it.
    child.on('settings/document-updated', schedule)
    child.on('llm/adapters-updated', schedule)
    // The initial pass runs without the debounce so the first request of a
    // boot already sees the injected configuration and per-model metadata.
    chain = chain
      .then(() => installPerModelDefaults(child))
      .then(() => runReconcile())
      .catch((error) => {
        logger.warn('provider-effort: initial reconciliation failed: ' + describe(error))
      })

    /**
     * Teach the LLM runtime to advertise per-model default efforts.
     *
     * DSH resolves every request's effort as `requested ?? model.defaultEffort`,
     * validates it against the model's selectable efforts, marks the
     * materialization as adapter-supplied (so session selections re-resolve it
     * instead of pinning it), and merges it into dispatch on every path —
     * prepared calls, direct streams, and standalone resolution. The adapter
     * derives `defaultEffort` from the route-level `reasoning` only, so
     * per-model defaults arrive by wrapping the runtime's model-metadata
     * normalization on the class prototype: a guarded, idempotent patch that
     * replaces the advertised default when this plugin's configuration names
     * one for the exact provider/model pair and the model supports it.
     * Explicit request efforts always win. If the runtime's internals change,
     * the patch refuses to install and the feature degrades to a logged no-op.
     */
    let perModelAvailable = true
    function installPerModelDefaults() {
      if (!perModelAvailable) return
      try {
        activeRawConfig.raw = rawConfig
        const proto = Object.getPrototypeOf(child.llm)
        if (proto === null || typeof proto !== 'object' || !Object.hasOwn(proto, 'normalizeModelInfo')
          || typeof proto.normalizeModelInfo !== 'function') {
          perModelAvailable = false
          logger.warn('provider-effort: runtime model-metadata seam not found; per-model efforts stay off')
          return
        }
        if (proto.normalizeModelInfo.__providerEffortPatched === true) return
        const original = proto.normalizeModelInfo
        const patched = function normalizeModelInfo(registration, model, resolved) {
          const info = original.call(this, registration, model, resolved)
          try {
            const config = liveConfig(activeRawConfig.raw)
            const level = perModelEffort(config, info.provider, info.id)
            if (level !== undefined && info.reasoning !== undefined && Array.isArray(info.reasoning.efforts)) {
              const match = info.reasoning.efforts.find((effort) => effort !== undefined && effort.id === level)
              if (match !== undefined) {
                info.reasoning = { ...info.reasoning, defaultEffort: match.id }
              }
            }
          } catch { /* metadata advertising must never fail a resolution */ }
          return info
        }
        patched.__providerEffortPatched = true
        proto.normalizeModelInfo = patched
        logger.info('provider-effort: per-model default efforts active on the LLM runtime')
      } catch (error) {
        perModelAvailable = false
        logger.warn('provider-effort: per-model default efforts unavailable: ' + describe(error))
      }
    }

    function describe(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function runReconcile() {
      installPerModelDefaults(child)
      const config = liveConfig(rawConfig)

      // 1. Locate the target namespace and its live plus override sections.
      let descriptor
      try {
        descriptor = child.settings.describe().find((row) => row.ns === config.namespace)
      } catch (error) {
        logger.warn('provider-effort: settings describe failed: ' + describe(error))
        return
      }
      if (descriptor === undefined) {
        logger.info('provider-effort: no "' + config.namespace + '" settings namespace; nothing to reconcile')
        return
      }
      const section = (value) => (value !== null && typeof value === 'object' ? value : {})
      const effectiveProviders = section(descriptor.value?.providers)
      const overrideProviders = section(descriptor.user?.providers)

      // 2. Enumerate third-party routes: the adapter's directory joined with
      //    every route the stored configuration names.
      let directory = []
      try {
        directory = await child.llm.listConfigurableProviders()
      } catch (error) {
        logger.warn('provider-effort: provider directory unavailable: ' + describe(error))
        return
      }
      let registered = new Set()
      try {
        registered = new Set((await child.llm.listProviders()).map((row) => row.id))
      } catch (error) {
        logger.warn('provider-effort: registered-route listing unavailable: ' + describe(error))
      }
      const targets = new Map()
      for (const entry of directory) {
        if (entry.settingsNs === config.namespace) targets.set(entry.provider, entry)
      }
      for (const route of Object.keys(effectiveProviders)) {
        if (!targets.has(route)) targets.set(route, undefined)
      }
      for (const route of Object.keys(overrideProviders)) {
        if (!targets.has(route)) targets.set(route, undefined)
      }

      const ops = []
      const injected = []
      const defaults = []
      const skipped = []

      for (const [route, directoryEntry] of targets) {
        const rawRouteCfg = section(config.routes)[route]
        const routeCfg = rawRouteCfg !== null && typeof rawRouteCfg === 'object' ? rawRouteCfg : {}
        if (routeCfg.skip === true || config.skip.includes(route)) {
          skipped.push(route + ': excluded by config')
          continue
        }
        const effortLevel = routeCfg.effort ?? config.effort
        if (!LEVELS.includes(effortLevel)) {
          skipped.push(route + ': unknown effort "' + effortLevel + '"')
          continue
        }
        const routeLevels = Array.isArray(routeCfg.levels) && routeCfg.levels.length > 0
          ? routeCfg.levels
          : config.levels
        const capability = effortsMap(routeLevels)

        // Config hygiene: a per-model level outside the offered capability
        // map can never materialize (the runtime rejects unknown defaults),
        // so point the configuration at the offered list.
        if (routeCfg.effortByModel !== undefined && routeCfg.effortByModel !== null
          && typeof routeCfg.effortByModel === 'object') {
          for (const [modelId, level] of Object.entries(routeCfg.effortByModel)) {
            if (LEVELS.includes(level) && routeLevels.includes(level) === false) {
              logger.warn('provider-effort: route "' + route + '" model "' + modelId + '" default "' + level
                + '" is not in the offered levels; add it to levels or routes.' + route + '.levels')
            }
          }
        }

        const effProfile = section(effectiveProviders[route])
        const ovrProfile = overrideProviders[route] !== null && typeof overrideProviders[route] === 'object'
          ? overrideProviders[route]
          : undefined
        const ovrModels = Array.isArray(ovrProfile?.models) ? ovrProfile.models : undefined

        // A. Capability injection — only on hand-declared routes
        //    (`declared === true`), and only into model entries the override
        //    layer actually stores, so path ops address a real array. A
        //    narrowed catalog route keeps its models' installed-catalog
        //    capability — including the catalog's wire spellings — because a
        //    declared `reasoningEfforts` dict would REPLACE that map. Declared
        //    maps (including `false`) are always respected and never rewritten.
        let postInjectionSupport = null
        const handDeclared = directoryEntry !== undefined && directoryEntry.declared === true
        if (handDeclared && ovrModels !== undefined) {
          if (ovrModels.length === 0) {
            skipped.push(route + ': stored route declares no models')
          } else {
            let count = 0
            ovrModels.forEach((model, index) => {
              if (model === null || typeof model !== 'object' || typeof model.id !== 'string') return
              const declared = model.reasoningEfforts
              if (declared === false) return
              if (declared === undefined || declared === null) {
                ops.push({
                  op: 'set',
                  path: ['providers', route, 'models', index, 'reasoningEfforts'],
                  value: capability,
                })
                count += 1
              }
            })
            if (count > 0) injected.push(route + ': ' + count + ' model(s)')
            postInjectionSupport = ovrModels.every((model) => {
              if (model === null || typeof model !== 'object' || typeof model.id !== 'string') return false
              const declared = model.reasoningEfforts
              if (declared === false) return false
              const map = declared === undefined || declared === null ? capability : declared
              return supportsLevel(map, effortLevel)
            })
          }
        }

        // B. Route-level default — missing-only, unless `force` overrides.
        const existing = effProfile.reasoning
        if (existing === effortLevel) {
          skipped.push(route + ': route default already "' + effortLevel + '"')
          continue
        }
        if (existing !== undefined && routeCfg.force !== true) {
          skipped.push(route + ': route default already set to "' + existing + '"')
          continue
        }
        if (routeCfg.routeDefault === false) {
          skipped.push(route + ': route default disabled by config')
          continue
        }
        if (routeCfg.force !== true) {
          let supportAll = postInjectionSupport
          if (supportAll === null) {
            // Verify against the adapter itself: catalog routes (and stored
            // routes whose models live in a lower layer) have no override
            // models array to reason about locally.
            if (!registered.has(route)) {
              skipped.push(route + ': route not registered')
              continue
            }
            let models = []
            try {
              models = await child.llm.listModels(route)
            } catch {
              models = []
            }
            if (models.length === 0) {
              skipped.push(route + ': no enumerable models (store an API key first, or the route serves none)')
              continue
            }
            const results = await Promise.allSettled(models.map((model) => child.llm.resolveModelInfo(route, model.id)))
            supportAll = results.every((result) => result.status === 'fulfilled'
              && result.value !== null && typeof result.value === 'object'
              && Array.isArray(result.value.reasoning?.efforts)
              && result.value.reasoning.efforts.some((entry) => entry?.id === effortLevel))
          }
          if (supportAll !== true) {
            skipped.push(route + ': not every model supports "' + effortLevel + '" (use routes.' + route + '.force to override)')
            continue
          }
        }
        ops.push({ op: 'set', path: ['providers', route, 'reasoning'], value: effortLevel })
        defaults.push(route + ' → ' + effortLevel)
      }

      if (ops.length === 0) {
        logger.info('provider-effort: nothing to write'
          + (skipped.length > 0 ? ' (' + skipped.join('; ') + ')' : ''))
        return
      }

      // 3. Write once, fenced by the revision just read. A conflict means the
      //    stored state moved (paths into models arrays may have shifted), so
      //    never replay the computed ops unfenced — schedule a fresh
      //    reconciliation against the new state instead.
      try {
        await child.settings.mutate(config.namespace, ops, descriptor.revision)
        logger.info('provider-effort: applied — route defaults: [' + defaults.join(', ') + ']'
          + ' capability: [' + injected.join(', ') + ']'
          + (skipped.length > 0 ? ' skipped: ' + skipped.join('; ') : ''))
      } catch (error) {
        const conflict = error !== null && typeof error === 'object'
          && (error.code === 'SETTINGS_CONFLICT' || error.name === 'SettingsConflictError')
        if (conflict) {
          logger.warn('provider-effort: settings moved during reconciliation; scheduling a fresh pass')
          schedule()
          return
        }
        logger.warn('provider-effort: settings write failed: ' + describe(error))
      }
    }
  })
}

export default apply
