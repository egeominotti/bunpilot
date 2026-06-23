// ---------------------------------------------------------------------------
// bunpilot – Generic Poll-Until Helper
// ---------------------------------------------------------------------------
//
// Shared polling primitive used by the process manager (wait for a pid to
// exit) and the reload handler (wait for replacement workers to come online).
// Centralising it removes the duplicated start/interval/timeout boilerplate.
// ---------------------------------------------------------------------------

/** Default poll interval in milliseconds. */
export const DEFAULT_POLL_INTERVAL = 100;

/**
 * Repeatedly evaluate `predicate` until it returns `true` or `timeout` ms
 * elapse.
 *
 * Resolves `true` when the predicate became truthy, or `false` when the
 * timeout elapsed first. If `predicate` throws, the returned promise rejects
 * with that error immediately — callers use this to abort early (e.g. a
 * replacement worker entering a terminal-failure state during reload).
 */
export function pollUntil(
  predicate: () => boolean,
  timeout: number,
  interval: number = DEFAULT_POLL_INTERVAL,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const start = Date.now();

    const tick = () => {
      let satisfied: boolean;
      try {
        satisfied = predicate();
      } catch (err) {
        reject(err);
        return;
      }

      if (satisfied) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeout) {
        resolve(false);
        return;
      }
      setTimeout(tick, interval);
    };

    tick();
  });
}
