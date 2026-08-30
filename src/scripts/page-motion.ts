/**
 * Music/Books motion adapter and route entrypoint.
 *
 * Page-specific responsibility only: find the motion root, collect the
 * reveal targets, and boot the shared runtime. Lifecycle and safety
 * policy — the `.motion-ready` gate, reveal observation, the safety net,
 * reduced motion, teardown, and BFCache restart — live in
 * motion/runtime.ts.
 */

import { createMotionRuntime } from './motion/runtime';

const page = document.querySelector<HTMLElement>('[data-page-motion]');

if (page) {
  createMotionRuntime({
    bindings: [
      {
        root: page,
        revealTargets: Array.from(page.querySelectorAll<HTMLElement>('.page-reveal')),
        setup() {
          // No page-specific runtime effects: Music and Books motion is
          // generic reveal plus CSS-driven hover/entrance states. Music's
          // year-tab behavior stays in music.astro's inline script.
        }
      }
    ]
  }).start();
}
