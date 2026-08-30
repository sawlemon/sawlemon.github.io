/**
 * Homepage motion adapter.
 *
 * Visual implementation only: hero parallax, tilt cards, pointer glows,
 * About emphasis, and the velocity band. Lifecycle and safety policy —
 * the `.motion-ready` gate, generic reveal observation, the reveal safety
 * net, reduced motion, teardown, and BFCache restart — live in
 * motion/runtime.ts. Everything this adapter registers hangs off the
 * cycle's AbortSignal or context.track(), so a stop leaves no state behind
 * and a BFCache restore starts a completely fresh cycle.
 */

import { createMotionRuntime } from './motion/runtime';

const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
const home = document.querySelector<HTMLElement>('[data-home-motion]');

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

if (home) {
  const runtime = createMotionRuntime({
    bindings: [
      {
        root: home,
        revealTargets: Array.from(home.querySelectorAll<HTMLElement>('.reveal')),
        setup(context) {
          const { signal } = context;
          const isReduced = context.isReduced;

          /* ---------- about: scroll-progress emphasis ---------- */

          const about = home.querySelector<HTMLElement>('.about');
          const aboutWords = about
            ? Array.from(about.querySelectorAll<HTMLElement>('.kinetic-about .word'))
            : [];
          let aboutNear = false;

          function updateAbout(): void {
            if (!about) return;
            if (isReduced()) {
              aboutWords.forEach((word) => word.classList.remove('is-active'));
              return;
            }
            const rect = about.getBoundingClientRect();
            const progress = clamp(
              (window.innerHeight * 0.72 - rect.top) / (window.innerHeight * 0.72 + rect.height * 0.55),
              0,
              0.999
            );
            const active = Math.min(2, Math.floor(progress * 3));
            aboutWords.forEach((word, index) => word.classList.toggle('is-active', index === active));
          }

          if (about) {
            const aboutObserver = context.createObserver(
              (entries) => {
                aboutNear = entries[entries.length - 1]?.isIntersecting ?? false;
                if (aboutNear) updateAbout();
              },
              { rootMargin: '25% 0px 25% 0px' }
            );
            aboutObserver?.observe(about);
          }
          context.track(() => aboutWords.forEach((word) => word.classList.remove('is-active')));

          /* ---------- hero: fine-pointer parallax ---------- */

          const heroShell = home.querySelector<HTMLElement>('.hero-shell');
          let heroFrame = 0;
          let heroX = 0;
          let heroY = 0;

          function applyHeroParallax(): void {
            heroFrame = 0;
            heroShell?.style.setProperty('--px', String(heroX));
            heroShell?.style.setProperty('--py', String(heroY));
          }

          function resetHeroParallax(): void {
            if (heroFrame) {
              cancelAnimationFrame(heroFrame);
              heroFrame = 0;
            }
            heroX = 0;
            heroY = 0;
            heroShell?.style.removeProperty('--px');
            heroShell?.style.removeProperty('--py');
          }

          if (heroShell && finePointerQuery.matches) {
            heroShell.addEventListener(
              'pointermove',
              (event) => {
                if (isReduced()) return;
                const rect = heroShell.getBoundingClientRect();
                heroX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
                heroY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
                if (!heroFrame) heroFrame = requestAnimationFrame(applyHeroParallax);
              },
              { signal }
            );
            heroShell.addEventListener('pointerleave', resetHeroParallax, { signal });
          }
          context.track(resetHeroParallax);

          /* ---------- tilt cards on stationary hit wrappers ---------- */

          interface TiltState {
            hit: HTMLElement;
            card: HTMLElement;
            frame: number;
            rx: number;
            ry: number;
            mx: number;
            my: number;
            mxn: number;
            myn: number;
          }

          const tilts: TiltState[] = [];
          home.querySelectorAll<HTMLElement>('.tilt-hit').forEach((hit) => {
            const card = hit.querySelector<HTMLElement>('[data-tilt]');
            if (card) tilts.push({ hit, card, frame: 0, rx: 0, ry: 0, mx: 50, my: 50, mxn: 0, myn: 0 });
          });

          function applyTilt(tilt: TiltState): void {
            tilt.frame = 0;
            tilt.card.style.setProperty('--rx', `${tilt.rx}deg`);
            tilt.card.style.setProperty('--ry', `${tilt.ry}deg`);
            tilt.card.style.setProperty('--mx', `${tilt.mx}%`);
            tilt.card.style.setProperty('--my', `${tilt.my}%`);
            tilt.card.style.setProperty('--mxn', String(tilt.mxn));
            tilt.card.style.setProperty('--myn', String(tilt.myn));
          }

          function resetTilt(tilt: TiltState): void {
            if (tilt.frame) {
              cancelAnimationFrame(tilt.frame);
              tilt.frame = 0;
            }
            tilt.card.classList.remove('is-tilting');
            tilt.card.style.setProperty('--rx', '0deg');
            tilt.card.style.setProperty('--ry', '0deg');
            tilt.card.style.setProperty('--mxn', '0');
            tilt.card.style.setProperty('--myn', '0');
          }

          function onTiltMove(event: PointerEvent, tilt: TiltState): void {
            if (isReduced() || !finePointerQuery.matches) return;
            const rect = tilt.hit.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;
            tilt.ry = (x - 0.5) * 12;
            tilt.rx = (0.5 - y) * 10;
            tilt.mx = x * 100;
            tilt.my = y * 100;
            tilt.mxn = x - 0.5;
            tilt.myn = y - 0.5;
            tilt.card.classList.add('is-tilting');
            if (!tilt.frame) tilt.frame = requestAnimationFrame(() => applyTilt(tilt));
          }

          tilts.forEach((tilt) => {
            tilt.hit.addEventListener('pointermove', (event) => onTiltMove(event, tilt), { signal });
            tilt.hit.addEventListener('pointerleave', () => resetTilt(tilt), { signal });
            tilt.hit.addEventListener('pointercancel', () => resetTilt(tilt), { signal });
          });
          context.track(() => tilts.forEach(resetTilt));

          /* ---------- education cards: pointer highlight ---------- */

          const educationCards = Array.from(home.querySelectorAll<HTMLElement>('.education-grid article'));

          function onEducationMove(event: PointerEvent, card: HTMLElement): void {
            if (isReduced() || !finePointerQuery.matches) return;
            const rect = card.getBoundingClientRect();
            card.style.setProperty('--edu-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
            card.style.setProperty('--edu-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
          }

          educationCards.forEach((card) => {
            card.addEventListener('pointermove', (event) => onEducationMove(event, card), { signal });
          });

          /* ---------- credential + contact tiles: pointer glow ---------- */

          const glowTargets = Array.from(home.querySelectorAll<HTMLElement>('[data-glow]'));

          function onGlowMove(event: PointerEvent, el: HTMLElement): void {
            if (isReduced() || !finePointerQuery.matches) return;
            const rect = el.getBoundingClientRect();
            el.style.setProperty('--glow-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
            el.style.setProperty('--glow-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
          }

          glowTargets.forEach((el) => {
            el.addEventListener('pointermove', (event) => onGlowMove(event, el), { signal });
          });

          /* ---------- velocity band: scroll-driven rows ---------- */

          interface VelocityRow {
            el: HTMLElement;
            pos: number;
            dir: number;
            width: number;
          }

          const rows: VelocityRow[] = Array.from(home.querySelectorAll<HTMLElement>('.velocity-row')).map(
            (el, index) => ({
              el,
              pos: index ? -180 : 0,
              dir: Number(el.dataset.direction ?? '1') || 1,
              width: 0
            })
          );
          const band = home.querySelector<HTMLElement>('.velocity-band');
          let bandVisible = false;
          let rafId = 0;
          let velocityRunning = false;
          let lastY = window.scrollY;
          let lastT = 0;
          let velocity = 0;

          function measureRows(): void {
            for (const row of rows) {
              const copy = row.el.firstElementChild as HTMLElement | null;
              if (copy) row.width = copy.getBoundingClientRect().width;
            }
          }

          function velocityFrame(now: number): void {
            rafId = 0;
            const dy = clamp(window.scrollY - lastY, -240, 240);
            lastY = window.scrollY;
            velocity += (dy * 1.8 - velocity) * 0.13;
            velocity *= 0.92;
            const dt = Math.min(32, now - lastT);
            lastT = now;
            rows.forEach((row, index) => {
              const base = index ? -0.022 : 0.035;
              const boost = clamp(velocity * 0.035, -2.4, 2.4);
              row.pos += (base * row.dir + boost * row.dir) * dt;
              if (row.width) {
                row.pos = ((row.pos % row.width) - row.width) % row.width;
                row.el.style.transform = `translate3d(${row.pos}px,0,0)`;
              }
            });
            if (bandVisible && context.isDocumentVisible() && !isReduced()) {
              rafId = requestAnimationFrame(velocityFrame);
            } else {
              velocityRunning = false;
              if (isReduced()) rows.forEach((row) => (row.el.style.transform = 'none'));
            }
          }

          function syncVelocityLoop(): void {
            const shouldRun =
              rows.length > 0 && bandVisible && context.isDocumentVisible() && !isReduced();
            if (shouldRun && !velocityRunning) {
              velocityRunning = true;
              lastY = window.scrollY;
              lastT = performance.now();
              rafId = requestAnimationFrame(velocityFrame);
            } else if (!shouldRun && velocityRunning) {
              velocityRunning = false;
              if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
              }
              if (isReduced()) rows.forEach((row) => (row.el.style.transform = 'none'));
            }
          }

          if (band) {
            const bandObserver = context.createObserver(
              (entries) => {
                bandVisible = entries[entries.length - 1]?.isIntersecting ?? false;
                syncVelocityLoop();
              },
              { rootMargin: '12% 0px 12% 0px' }
            );
            bandObserver?.observe(band);

            if ('ResizeObserver' in window) {
              const resizeObserver = new ResizeObserver(() => measureRows());
              resizeObserver.observe(band);
              context.track(() => resizeObserver.disconnect());
            }
          }
          context.onVisibilityChange(() => syncVelocityLoop());
          context.track(() => {
            if (rafId) cancelAnimationFrame(rafId);
            velocityRunning = false;
            rows.forEach((row) => (row.el.style.transform = 'none'));
          });

          /* ---------- scroll + initial state ---------- */

          window.addEventListener(
            'scroll',
            () => {
              if (aboutNear && !isReduced()) updateAbout();
            },
            { passive: true, signal }
          );

          measureRows();
          void document.fonts.ready.then(() => {
            if (!signal.aborted) measureRows();
          });
          updateAbout();
          syncVelocityLoop();
        }
      }
    ]
  });

  runtime.start();
}
