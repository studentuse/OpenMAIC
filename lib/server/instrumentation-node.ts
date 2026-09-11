/**
 * The Node-only body of `instrumentation.ts`'s `register`.
 *
 * It lives in its own module so the Edge compile of `instrumentation.ts`
 * never contains Node-only source (signal handlers, `pg` persistence) in the
 * first place — Turbopack's Edge static analysis warns on any `process.*`
 * member it sees, even in branches it then dead-code-eliminates, so the Node
 * code must not be lexically present in the file Next also compiles for Edge.
 */
import type { AgentRunnerHandle } from '@/lib/server/agent-runtime/runner';
import type { MaterialExtractionRunnerHandle } from '@/lib/server/material-extraction/runner';

export async function registerNode(): Promise<void> {
  // Imported dynamically so the Edge bundle never pulls in `pg`.
  const { startAssetCollectorSchedule } =
    await import('@/lib/persistence/asset-collector-schedule');
  const assetSchedule = startAssetCollectorSchedule();

  // Warn-first boot-time validation of model routing config (MODEL_ROUTES,
  // DEFAULT_MODEL, <PREFIX>_MODELS). Cheap and non-throwing: broken config
  // surfaces here as [config] warnings instead of failing at request time.
  // Imported dynamically so the Edge bundle never pulls in the fs/js-yaml
  // backed provider config it reads.
  const { validateServerConfig } = await import('@/lib/server/config-validation');
  validateServerConfig();

  let runner: AgentRunnerHandle | undefined;
  let extractionRunner: MaterialExtractionRunnerHandle | undefined;
  let stopAgentEventNotifyBus: (() => Promise<void>) | null = null;
  try {
    const { isAgentRuntimeConfigured } = await import('@/lib/config/feature-flags');
    if (isAgentRuntimeConfigured()) {
      // One dedicated LISTEN connection per application instance. The HTTP
      // SSE routes and the runner share its in-process fanout registry; it is
      // not a pool client and never scales with the number of streams.
      const { startAgentEventNotifyBus } =
        await import('@/lib/server/agent-runtime/event-notify-bus');
      const eventNotifyBus = startAgentEventNotifyBus();
      stopAgentEventNotifyBus = () => eventNotifyBus.stop();
      // startAgentRunner only installs a timer. Store/schema initialization is
      // retained behind the store's lazy promise and never blocks register().
      const runtime = await import('@/lib/server/agent-runtime/runner');
      runner = runtime.startAgentRunner();
      const extraction = await import('@/lib/server/material-extraction/runner');
      extractionRunner = extraction.startMaterialExtractionRunner();
    }
  } catch (error) {
    console.error('[instrumentation] Agent runtime startup failed', error);
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      // Park sessions before any pool they use is closed. This preserves the
      // last durable entry-tree checkpoint for immediate takeover.
      try {
        await extractionRunner?.stop();
      } catch (error) {
        console.error('[instrumentation] Material extraction runner drain failed', error);
      }
      try {
        await runner?.stop();
      } catch (error) {
        console.error('[instrumentation] Agent runner drain failed', error);
      }
      try {
        await stopAgentEventNotifyBus?.();
      } catch (error) {
        console.error('[instrumentation] Agent event notify bus drain failed', error);
      }
      try {
        await assetSchedule?.stop();
      } catch (error) {
        console.error('[instrumentation] Asset collector drain failed', error);
      }
      const connectionString = process.env.DATABASE_URL?.trim();
      if (connectionString) {
        try {
          const { getServerPersistenceProvider } =
            await import('@/lib/persistence/server-provider');
          const { pool } = await getServerPersistenceProvider(connectionString);
          await pool.end();
        } catch (error) {
          console.error('[instrumentation] Persistence pool shutdown failed', error);
        }
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
