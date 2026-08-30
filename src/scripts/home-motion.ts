/**
 * Homepage motion controller.
 *
 * Vanilla TS port of the approved standalone prototype. Runs only on the
 * homepage ([data-home-motion]); every listener hangs off one AbortController,
 * the velocity band runs a single RAF only while it is onscreen, the document
 * is visible, and reduced motion is off. pagehide tears everything down and a
 * BFCache restore (pageshow, persisted) starts it again — so there can never
 * be duplicate observers, listeners, or loops.
 */

const root = document.documentElement;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');

const home = document.querySelector<HTMLElement>('[data-home-motion]');

let started = false;
let rafId = 0;
let velocityRunning = false;
let bandVisible = false;
let aboutNear = false;
const teardowns: Array<() => void> = [];

function isReduced(): boolean {
  return motionQuery.matches;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ---------- progressive reveal ---------- */

const revealTargets = home ? Array.from(home.querySelectorAll<HTMLElement>('.reveal')) : [];
let revealObserver: IntersectionObserver | null = null;
if (home && 'IntersectionObserver' in window && revealTargets.length) {
  revealObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.13 }
  );
}

/* ---------- about: scroll-progress emphasis ---------- */

const about = home ? home.querySelector<HTMLElement>('.about') : null;
const aboutWords = about ? Array.from(about.querySelectorAll<HTMLElement>('.kinetic-about .word')) : [];

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

let aboutObserver: IntersectionObserver | null = null;
if (about && 'IntersectionObserver' in window) {
  aboutObserver = new IntersectionObserver(
    (entries) => {
      aboutNear = entries[entries.length - 1]?.isIntersecting ?? false;
      if (aboutNear) updateAbout();
    },
    { rootMargin: '25% 0px 25% 0px' }
  );
}

/* ---------- hero: fine-pointer parallax ---------- */

const heroShell = home ? home.querySelector<HTMLElement>('.hero-shell') : null;
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

/* ---------- tilt cards (projects + hobbies) on stationary hit wrappers ---------- */

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
if (home) {
  home.querySelectorAll<HTMLElement>('.tilt-hit').forEach((hit) => {
    const card = hit.querySelector<HTMLElement>('[data-tilt]');
    if (card) tilts.push({ hit, card, frame: 0, rx: 0, ry: 0, mx: 50, my: 50, mxn: 0, myn: 0 });
  });
}

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

/* ---------- education cards: pointer-following highlight ---------- */

const educationCards = home ? Array.from(home.querySelectorAll<HTMLElement>('.education-grid article')) : [];

function onEducationMove(event: PointerEvent, card: HTMLElement): void {
  if (isReduced() || !finePointerQuery.matches) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--edu-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
  card.style.setProperty('--edu-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
}

/* ---------- credential + contact tiles: pointer-following glow ---------- */

const glowTargets = home ? Array.from(home.querySelectorAll<HTMLElement>('[data-glow]')) : [];

function onGlowMove(event: PointerEvent, el: HTMLElement): void {
  if (isReduced() || !finePointerQuery.matches) return;
  const rect = el.getBoundingClientRect();
  el.style.setProperty('--glow-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
  el.style.setProperty('--glow-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
}

/* ---------- velocity band: scroll-driven rows ---------- */

interface VelocityRow {
  el: HTMLElement;
  pos: number;
  dir: number;
  width: number;
}

const rows: VelocityRow[] = home
  ? Array.from(home.querySelectorAll<HTMLElement>('.velocity-row')).map((el, index) => ({
      el,
      pos: index ? -180 : 0,
      dir: Number(el.dataset.direction ?? '1') || 1,
      width: 0
    }))
  : [];
const band = home ? home.querySelector<HTMLElement>('.velocity-band') : null;
let lastY = 0;
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
  if (bandVisible && !document.hidden && !isReduced()) {
    rafId = requestAnimationFrame(velocityFrame);
  } else {
    velocityRunning = false;
    if (isReduced()) rows.forEach((row) => (row.el.style.transform = 'none'));
  }
}

function syncVelocityLoop(): void {
  const shouldRun = rows.length > 0 && bandVisible && !document.hidden && !isReduced();
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

let bandObserver: IntersectionObserver | null = null;
if (band && 'IntersectionObserver' in window) {
  bandObserver = new IntersectionObserver(
    (entries) => {
      bandVisible = entries[entries.length - 1]?.isIntersecting ?? false;
      syncVelocityLoop();
    },
    { rootMargin: '12% 0px 12% 0px' }
  );
} else if (band) {
  bandVisible = true;
}

let resizeObserver: ResizeObserver | null = null;
if (band && 'ResizeObserver' in window) {
  resizeObserver = new ResizeObserver(() => measureRows());
}

/* ---------- mode switching + lifecycle ---------- */

function applyMotionMode(): void {
  if (isReduced() || !revealObserver) {
    root.classList.remove('motion-ready');
  } else {
    root.classList.add('motion-ready');
  }
  if (isReduced()) {
    resetHeroParallax();
    tilts.forEach(resetTilt);
    rows.forEach((row) => (row.el.style.transform = 'none'));
    aboutWords.forEach((word) => word.classList.remove('is-active'));
  }
  syncVelocityLoop();
}

function onMotionChange(): void {
  applyMotionMode();
  updateAbout();
}

function onScroll(): void {
  if (aboutNear && !isReduced()) updateAbout();
}

function teardown(): void {
  if (!started) return;
  started = false;
  while (teardowns.length) teardowns.pop()?.();
  revealObserver?.disconnect();
  aboutObserver?.disconnect();
  bandObserver?.disconnect();
  resizeObserver?.disconnect();
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  velocityRunning = false;
  resetHeroParallax();
  tilts.forEach(resetTilt);
  root.classList.remove('motion-ready');
}

function start(): void {
  if (started || !home) return;
  started = true;

  const controller = new AbortController();
  const { signal } = controller;
  teardowns.push(() => controller.abort());

  if (revealObserver) revealTargets.forEach((el) => revealObserver?.observe(el));
  if (about && aboutObserver) aboutObserver.observe(about);
  if (band && bandObserver) bandObserver.observe(band);
  if (band && resizeObserver) resizeObserver.observe(band);

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

  tilts.forEach((tilt) => {
    tilt.hit.addEventListener('pointermove', (event) => onTiltMove(event, tilt), { signal });
    tilt.hit.addEventListener('pointerleave', () => resetTilt(tilt), { signal });
    tilt.hit.addEventListener('pointercancel', () => resetTilt(tilt), { signal });
  });

  educationCards.forEach((card) => {
    card.addEventListener('pointermove', (event) => onEducationMove(event, card), { signal });
  });

  glowTargets.forEach((el) => {
    el.addEventListener('pointermove', (event) => onGlowMove(event, el), { signal });
  });

  window.addEventListener('scroll', onScroll, { passive: true, signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      syncVelocityLoop();
    },
    { signal }
  );
  motionQuery.addEventListener('change', onMotionChange, { signal });
  window.addEventListener('pagehide', teardown, { signal });
  window.addEventListener(
    'pageshow',
    (event) => {
      if (event.persisted && !started) start();
      if (started) {
        lastY = window.scrollY;
        syncVelocityLoop();
        updateAbout();
      }
    },
    { signal }
  );

  measureRows();
  void document.fonts.ready.then(() => {
    if (started) measureRows();
  });

  updateAbout();
  // Adds .motion-ready only after observers are registered, so a slow or
  // failed script can never leave sections permanently hidden.
  applyMotionMode();
}

start();
