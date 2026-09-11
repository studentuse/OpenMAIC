/**
 * Process-scoped startup work.
 *
 * Next calls `register` once per server instance, before it serves a request.
 * That makes it the only place in this app where a background schedule can
 * live: a route module has no such guarantee — it can be instantiated more
 * than once and gets no shutdown hook — so anything periodic started from one is
 * really started per instantiation.
 *
 * `register` must return before the server is ready, so nothing here may block
 * on I/O. Starting a timer does not.
 *
 * Next also compiles this file for the Edge runtime (whenever Edge proxy or
 * Edge routes exist). Turbopack's Edge static analysis warns on any `process.*`
 * member — even inside branches it dead-code-eliminates — so the entire Node
 * body, including the SIGTERM/SIGINT handlers, must stay out of this file and
 * in `lib/server/instrumentation-node.ts`, which is only ever reached through
 * the runtime-guarded dynamic import below.
 */
export async function register(): Promise<void> {
  // Also invoked for the Edge runtime, which has neither `pg` nor timers we
  // want; the persistence stack is Node-only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { registerNode } = await import('@/lib/server/instrumentation-node');
  await registerNode();
}
