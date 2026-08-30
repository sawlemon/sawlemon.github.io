/**
 * Shared motion policy runtime.
 *
 * Owns everything lifecycle/safety that used to be duplicated across
 * home-motion.ts and page-motion.ts:
 *
 *  - the global `.motion-ready` gate: hidden/entrance CSS states exist only
 *    under it, and it is added only after every binding's observers and
 *    setup have registered — so a no-JS or failed-script load shows all
 *    content;
 *  - generic one-shot reveal observation (threshold 0.13);
 *  - a safety net that reveals any remaining hidden target after a timeout,
 *    covering both fully and partially stalled observers;
 *  - reduced-motion state: the gate stays off while reduced, and any
 *    preference change restarts the cycle so adapters reinitialize cleanly
 *    in both directions;
 *  - document visibility notifications;
 *  - per-cycle resources: one AbortController, tracked observers, timers,
 *    and cleanup callbacks;
 *  - idempotent start/stop and BFCache restart: `pagehide` stops the cycle,
 *    while `pageshow` is a PERMANENT listener (deliberately not on the
 *    cycle controller) so a persisted restore can always start a fresh one.
 *
 * It knows nothing about page-specific effects. Adapters own selectors,
 * pointer math, RAF loops, and inline-style semantics.
 */

export type MotionBinding = {
  root: HTMLElement;
  revealTargets: HTMLElement[];
  setup: (context: MotionContext) => void;
};

export type MotionContext = {
  /** Aborted when the cycle stops; use for every adapter listener. */
  signal: AbortSignal;
  isReduced(): boolean;
  isDocumentVisible(): boolean;
  /** Creates a lifecycle-tracked observer; null when unsupported. */
  createObserver(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ): IntersectionObserver | null;
  /** Fires on document visibility changes for the active cycle. */
  onVisibilityChange(callback: () => void): void;
  /** Registers cleanup run when the cycle stops. */
  track(cleanup: () => void): void;
};

type RuntimeOptions = {
  bindings: MotionBinding[];
  revealThreshold?: number;
  revealTimeoutMs?: number;
};

export function createMotionRuntime({
  bindings,
  revealThreshold = 0.13,
  revealTimeoutMs = 2000
}: RuntimeOptions): { start(): void; stop(): void } {
  const rootEl = document.documentElement;
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  interface Cycle {
    controller: AbortController;
    observers: IntersectionObserver[];
    timers: number[];
    cleanups: Array<() => void>;
    visibilityHandlers: Array<() => void>;
  }

  let cycle: Cycle | null = null;

  function stop(): void {
    if (!cycle) return;
    const closing = cycle;
    cycle = null;
    closing.timers.forEach((timer) => clearTimeout(timer));
    closing.observers.forEach((observer) => observer.disconnect());
    for (const cleanup of [...closing.cleanups].reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.error('motion runtime: cleanup failed', error);
      }
    }
    closing.visibilityHandlers.length = 0;
    closing.controller.abort();
    rootEl.classList.remove('motion-ready');
  }

  function start(): void {
    if (cycle || bindings.length === 0) return;
    const controller = new AbortController();
    const active: Cycle = {
      controller,
      observers: [],
      timers: [],
      cleanups: [],
      visibilityHandlers: []
    };
    cycle = active;

    const reduced = motionQuery.matches;
    const useReveal = 'IntersectionObserver' in window && !reduced;

    if (useReveal) {
      const revealObserver = new IntersectionObserver(
        (entries, observer) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
              observer.unobserve(entry.target);
            }
          }
        },
        { threshold: revealThreshold }
      );
      active.observers.push(revealObserver);

      let observed = 0;
      for (const binding of bindings) {
        for (const target of binding.revealTargets) {
          revealObserver.observe(target);
          observed++;
        }
      }

      if (observed > 0) {
        active.timers.push(
          window.setTimeout(() => {
            // Stale-cycle guard: a stopped or restarted cycle must never
            // reveal anything for a later one.
            if (cycle !== active) return;
            for (const binding of bindings) {
              for (const target of binding.revealTargets) {
                if (!target.classList.contains('is-visible')) {
                  target.classList.add('is-visible');
                  revealObserver.unobserve(target);
                }
              }
            }
          }, revealTimeoutMs)
        );
      }
    }

    try {
      for (const binding of bindings) {
        binding.setup({
          signal: controller.signal,
          isReduced: () => motionQuery.matches,
          isDocumentVisible: () => !document.hidden,
          createObserver(callback, options) {
            if (!('IntersectionObserver' in window)) return null;
            const observer = new IntersectionObserver(callback, options);
            active.observers.push(observer);
            return observer;
          },
          onVisibilityChange(callback) {
            active.visibilityHandlers.push(callback);
          },
          track(cleanup) {
            active.cleanups.push(cleanup);
          }
        });
      }
    } catch (error) {
      console.error('motion runtime: adapter setup failed', error);
      stop();
      return;
    }

    // Only after every binding registered its observers and setup.
    if (useReveal) rootEl.classList.add('motion-ready');
  }

  // Permanent lifecycle listeners. Deliberately NOT attached to the cycle
  // controller: `pagehide` stops the cycle (aborting it), and a persisted
  // `pageshow` must still be able to start a fresh one.
  window.addEventListener('pagehide', () => stop());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && !cycle) start();
  });
  motionQuery.addEventListener('change', () => {
    // Any preference change gets a fresh cycle: reduced mode keeps the gate
    // off, normal mode re-registers observers before re-enabling it.
    stop();
    if (!motionQuery.matches) start();
  });
  document.addEventListener('visibilitychange', () => {
    if (!cycle) return;
    for (const handler of [...cycle.visibilityHandlers]) {
      try {
        handler();
      } catch (error) {
        console.error('motion runtime: visibility handler failed', error);
      }
    }
  });

  return { start, stop };
}
