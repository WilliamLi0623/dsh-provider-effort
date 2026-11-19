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
  })).default({}).volatile(),
})

/** Unwrap a live volatile reference; plain values pass through. */
function read(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

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
    // diff is what keeps this from looping on the plugin's own writes.
    child.on('settings/document-updated', schedule)
    child.on('llm/adapters-updated', schedule)
    // The initial pass runs without the debounce so the first request of a
    // boot already sees the injected configuration.
    chain = chain.then(() => runReconcile()).catch((error) => {
      logger.warn('provider-effort: initial reconciliation failed: ' + describe(error))
    })

    function describe(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function runReconcile() {
      const config = {
        effort: read(rawConfig.effort) ?? 'medium',
        levels: read(rawConfig.levels) ?? ['off', 'minimal', 'low', 'medium', 'high'],
        namespace: read(rawConfig.namespace) ?? 'llm-pi-ai',
        skip: read(rawConfig.skip) ?? [],
        routes: read(rawConfig.routes) ?? {},
      }

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
