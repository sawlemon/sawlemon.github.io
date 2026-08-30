/**
 * Scroll-reveal controller for the Music and Books pages.
 *
 * Same safety rules as home-motion.ts, scaled down to what these pages
 * need (no tilt, parallax, or velocity loop): nothing is hidden unless
 * html.motion-ready is present, and that class is only added after the
 * IntersectionObserver registers — so a slow or failed script can never
 * leave content invisible. One AbortController owns the listeners,
 * pagehide tears the observer down, and a BFCache restore (pageshow,
 * persisted) starts it again.
 */

const rootEl = document.documentElement;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const page = document.querySelector<HTMLElement>('[data-page-motion]');
const targets = page ? Array.from(page.querySelectorAll<HTMLElement>('.page-reveal')) : [];

let started = false;
let observer: IntersectionObserver | null = null;
const teardowns: Array<() => void> = [];

function teardown(): void {
  if (!started) return;
  started = false;
  while (teardowns.length) teardowns.pop()?.();
  observer?.disconnect();
  rootEl.classList.remove('motion-ready');
}

function start(): void {
  if (started || !page || !targets.length) return;
  started = true;

  const controller = new AbortController();
  teardowns.push(() => controller.abort());

  if ('IntersectionObserver' in window && !motionQuery.matches) {
    observer = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            obs.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.13 }
    );
    targets.forEach((el) => observer?.observe(el));
    // Only after the observer is registered.
    rootEl.classList.add('motion-ready');
    // Safety net: on a healthy browser the hero reveals within a frame or
    // two of load. If nothing has revealed after 2s the observer is not
    // firing, so show everything rather than leave gated content hidden.
    const net = setTimeout(() => {
      if (!targets.some((el) => el.classList.contains('is-visible'))) {
        targets.forEach((el) => {
          el.classList.add('is-visible');
          observer?.unobserve(el);
        });
      }
    }, 2000);
    teardowns.push(() => clearTimeout(net));
  }

  window.addEventListener('pagehide', teardown, { signal: controller.signal });
  window.addEventListener(
    'pageshow',
    (event) => {
      if (event.persisted && !started) {
        start();
      } else if (started && observer) {
        targets.forEach((el) => {
          if (!el.classList.contains('is-visible')) observer?.observe(el);
        });
      }
    },
    { signal: controller.signal }
  );
  motionQuery.addEventListener(
    'change',
    () => {
      if (motionQuery.matches) {
        // Reduced motion: show everything, no observer-driven hiding.
        rootEl.classList.remove('motion-ready');
      } else if (observer) {
        rootEl.classList.add('motion-ready');
      }
    },
    { signal: controller.signal }
  );
}

start();

// Module scope: keeps these declarations separate from home-motion.ts,
// which astro check otherwise treats as one shared global script scope.
export {};
