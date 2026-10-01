// Site behaviour. Every page renders and reads fine without this file; it only
// enhances: theme, dock + index overlay, fit-to-width type, reveals, count-ups,
// the scroll-lit manifesto, badge tilt, the pinned projects gallery, the
// cycling connect word, the books view toggle and the music year tabs.
const root = document.documentElement;
const page = document.body.dataset.page as 'home' | 'books' | 'music' | 'blog';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const staticMode = new URLSearchParams(location.search).has('static');
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const fmt = (n: number) => n.toLocaleString('en-IN');
const onScroll: (() => void)[] = [];
addEventListener('scroll', () => onScroll.forEach((f) => f()), { passive: true });

/* theme */
const toggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]')!;
const syncToggle = () => {
  const dark = root.dataset.theme === 'dark';
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
};
syncToggle();
toggle.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  const apply = () => {
    root.dataset.theme = next;
    syncToggle();
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* storage blocked — theme still switches for this visit */
    }
  };
  const startViewTransition = (document as unknown as { startViewTransition?: (cb: () => void) => void }).startViewTransition;
  if (startViewTransition && !reduced) startViewTransition.call(document, apply);
  else apply();
});

/* fit text to its container width */
type Fitter = () => void;
const fitters: Fitter[] = [];
const fit = (el: HTMLElement, sizeTarget: HTMLElement = el) => {
  sizeTarget.style.fontSize = '100px';
  const range = document.createRange();
  range.selectNodeContents(el);
  const w = range.getBoundingClientRect().width;
  const avail = (el.closest('[data-fit-box]') ?? el.parentElement)?.clientWidth ?? 0;
  if (w && avail) sizeTarget.style.fontSize = `${(100 * avail * 0.985) / w}px`;
};
const heroName = document.querySelector<HTMLElement>('[data-hero-name]');
if (heroName) {
  const line = heroName.querySelector<HTMLElement>('[data-fit-line]')!;
  fitters.push(() => fit(line, heroName));
}
document.querySelectorAll<HTMLElement>('[data-fit]').forEach((el) => fitters.push(() => fit(el)));
const runFit = () => fitters.forEach((f) => f());
runFit();
document.fonts?.ready.then(runFit);
new ResizeObserver(runFit).observe(document.body);

/* hero slice parallax */
const slice = document.querySelector<HTMLElement>('[data-slice]');
if (slice && !reduced) {
  onScroll.push(() => {
    const y = scrollY;
    if (y < innerHeight * 1.2) slice.style.transform = `translate3d(0, ${y * 0.35}px, 0) rotate(${y * 0.12}deg)`;
  });
}

/* dock + index overlay */
const dock = document.querySelector<HTMLElement>('[data-dock]')!;
const dockInd = dock.querySelector<HTMLElement>('.dock-ind')!;
const dockCurrent = dock.querySelector<HTMLElement>('[data-dock-current]')!;
const spyLinks = [...dock.querySelectorAll<HTMLAnchorElement>('[data-spy]')];
const setActive = (id: string | null) => {
  const a = spyLinks.find((l) => l.dataset.spy === id);
  spyLinks.forEach((l) => {
    l.classList.toggle('is-active', l === a);
    if (l === a) l.setAttribute('aria-current', 'location');
    else l.removeAttribute('aria-current');
  });
  if (a) {
    dockInd.style.left = `${a.offsetLeft}px`;
    dockInd.style.width = `${a.offsetWidth}px`;
    dockInd.classList.add('on');
    dockCurrent.textContent = a.textContent;
  } else {
    dockInd.classList.remove('on');
    dockCurrent.textContent = page === 'home' ? 'Solomon Raj' : page.charAt(0).toUpperCase() + page.slice(1);
  }
};
const hero = document.querySelector<HTMLElement>('.hero');
if (page === 'home' && hero) {
  onScroll.push(() => dock.classList.toggle('show', scrollY > hero.offsetHeight * 0.55));
  const sections = spyLinks.map((l) => document.getElementById(l.dataset.spy!)).filter((s): s is HTMLElement => Boolean(s));
  const spy = () => {
    const mid = innerHeight * 0.45;
    let current: string | null = null;
    for (const s of sections) {
      const r = s.getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) current = s.id;
    }
    if (dock.dataset.current !== String(current)) {
      dock.dataset.current = String(current);
      setActive(current);
    }
  };
  onScroll.push(spy);
  spy();
} else {
  setActive(page === 'blog' ? 'writing' : null);
}
const remeasureDock = () => setActive(page === 'home' ? (dock.dataset.current === 'null' ? null : dock.dataset.current!) : page === 'blog' ? 'writing' : null);
addEventListener('resize', remeasureDock);
document.fonts?.ready.then(remeasureDock);

const overlay = document.querySelector<HTMLElement>('[data-index]')!;
const openBtn = document.querySelector<HTMLButtonElement>('[data-index-open]')!;
const background = [...document.body.children].filter((el) => el !== overlay && !el.matches('script, .sprite'));
const setIndex = (open: boolean, restoreFocus = true) => {
  overlay.toggleAttribute('open', open);
  openBtn.setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
  background.forEach((el) => {
    if ('inert' in el) (el as HTMLElement).inert = open;
  });
  if (open) overlay.querySelector<HTMLElement>('[data-index-close]')?.focus();
  else if (restoreFocus) openBtn.focus();
};
openBtn.addEventListener('click', () => setIndex(true));
overlay.querySelector('[data-index-close]')?.addEventListener('click', () => setIndex(false));
overlay.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest('a');
  if (!link) return;
  setIndex(false, false);
  const hash = link.hash && link.pathname === location.pathname ? link.hash : '';
  const target = hash ? document.querySelector<HTMLElement>(hash) : null;
  if (target) {
    target.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay.hasAttribute('open')) setIndex(false);
});

/* reveal on scroll (content hidden only after this runs) */
const io = new IntersectionObserver(
  (entries) =>
    entries.forEach((en) => {
      if (en.isIntersecting) {
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    }),
  { rootMargin: '0px 0px -10% 0px' }
);
const observeReveals = () => document.querySelectorAll('.rv:not(.in), [data-stairs]:not(.in)').forEach((el) => io.observe(el));
if (!reduced && !staticMode) {
  root.classList.add('reveal-ready');
  observeReveals();
}

/* count-up */
const countUp = (el: HTMLElement) => {
  const target = Number(el.dataset.count);
  if (!Number.isFinite(target)) return;
  if (reduced || staticMode) {
    el.textContent = fmt(target);
    return;
  }
  const t0 = performance.now();
  const step = (t: number) => {
    const p = clamp((t - t0) / 1400);
    el.textContent = fmt(Math.round(target * (1 - (1 - p) ** 4)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
const countIO = new IntersectionObserver(
  (entries) =>
    entries.forEach((en) => {
      if (en.isIntersecting) {
        countUp(en.target as HTMLElement);
        countIO.unobserve(en.target);
      }
    }),
  { threshold: 0.5 }
);
const bindCounts = () =>
  document.querySelectorAll<HTMLElement>('[data-count]:not([data-counted])').forEach((el) => {
    el.dataset.counted = '1';
    el.textContent = fmt(Number(el.dataset.count));
    countIO.observe(el);
  });
bindCounts();

/* manifesto: words light up with scroll */
const manifesto = document.querySelector<HTMLElement>('[data-manifesto]');
if (manifesto && !reduced && !staticMode) {
  const wrapWords = (node: Node) => {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent!.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) frag.append(part);
          else {
            const s = document.createElement('span');
            s.className = 'w';
            s.textContent = part;
            frag.append(s);
          }
        });
        n.replaceWith(frag);
      } else if (n instanceof HTMLElement && n.classList.contains('mark')) n.classList.add('w');
    });
  };
  wrapWords(manifesto);
  const words = [...manifesto.querySelectorAll<HTMLElement>('.w')];
  const light = () => {
    const r = manifesto.getBoundingClientRect();
    const p = clamp((innerHeight * 0.85 - r.top) / (r.height + innerHeight * 0.35));
    const lit = p * words.length * 1.15;
    words.forEach((w, i) => w.style.setProperty('--o', String(clamp(lit - i, 0.48, 1))));
  };
  onScroll.push(light);
  light();
}

/* badge tilt */
const badge = document.querySelector<HTMLElement>('[data-tilt]');
if (badge && fine && !reduced) {
  const wrap = badge.closest<HTMLElement>('[data-tilt-wrap]')!;
  wrap.addEventListener('pointermove', (e) => {
    const r = badge.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    badge.classList.add('tilting');
    badge.style.setProperty('--ry', `${(x - 0.5) * 16}deg`);
    badge.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
    badge.style.setProperty('--gx', `${x * 100}%`);
    badge.style.setProperty('--gy', `${y * 100}%`);
  });
  wrap.addEventListener('pointerleave', () => {
    badge.classList.remove('tilting');
    badge.style.setProperty('--rx', '0deg');
    badge.style.setProperty('--ry', '0deg');
  });
}

/* horizontal work gallery */
const work = document.querySelector<HTMLElement>('[data-work]');
if (work) {
  const pin = work.querySelector<HTMLElement>('[data-work-pin]')!;
  const track = work.querySelector<HTMLElement>('[data-work-track]')!;
  const bar = work.querySelector<HTMLElement>('[data-work-bar]')!;
  const count = work.querySelector<HTMLElement>('[data-work-count]')!;
  let dist = 0;
  let enabled = false;
  const layout = () => {
    enabled = innerWidth >= 900 && innerHeight >= 680 && !reduced && !staticMode;
    work.classList.toggle('no-pin', !enabled);
    if (enabled) {
      track.style.transform = '';
      const clipped = [...track.querySelectorAll<HTMLElement>('.proj-body')].some((b) => b.scrollHeight > b.clientHeight + 2);
      if (clipped) {
        enabled = false;
        work.classList.add('no-pin');
      }
    }
    if (!enabled) {
      work.style.height = '';
      track.style.transform = '';
      return;
    }
    dist = Math.max(0, track.scrollWidth - innerWidth);
    work.style.height = `${dist + innerHeight}px`;
    move();
  };
  const move = () => {
    if (!enabled) return;
    const p = clamp(-work.getBoundingClientRect().top / (work.offsetHeight - innerHeight || 1));
    track.style.transform = `translate3d(${-p * dist}px, 0, 0)`;
    bar.style.transform = `scaleX(${p})`;
    count.textContent = String(Math.min(3, Math.max(1, Math.ceil(p * 3.2)))).padStart(2, '0');
  };
  track.addEventListener('focusin', (e) => {
    if (!enabled) return;
    const panel = (e.target as HTMLElement).closest<HTMLElement>('.proj, .work-intro');
    if (!panel) return;
    pin.scrollLeft = 0;
    const x = clamp(panel.offsetLeft - innerWidth * 0.1, 0, dist);
    scrollTo({ top: work.offsetTop + (x / (dist || 1)) * (work.offsetHeight - innerHeight), behavior: 'instant' as ScrollBehavior });
  });
  layout();
  onScroll.push(move);
  addEventListener('resize', layout);
  document.fonts?.ready.then(layout);
}

/* slot word */
const slot = document.querySelector<HTMLElement>('[data-slot]');
if (slot) {
  fitters.push(() => {
    slot.style.fontSize = '';
    const avail = slot.clientWidth;
    const widest = Math.max(
      ...[...slot.querySelectorAll('li')].map((li) => {
        const r = document.createRange();
        r.selectNodeContents(li);
        return r.getBoundingClientRect().width;
      })
    );
    if (widest > avail) slot.style.fontSize = `${parseFloat(getComputedStyle(slot).fontSize) * (avail / widest) * 0.98}px`;
  });
  runFit();
  if (!reduced) {
    const list = slot.querySelector('ul')!;
    const n = list.children.length - 1;
    let i = 0;
    window.setInterval(() => {
      i += 1;
      list.style.transition = '';
      list.style.transform = `translateY(${-i * 1.02}em)`;
      if (i === n) {
        window.setTimeout(() => {
          list.style.transition = 'none';
          list.style.transform = 'translateY(0)';
          i = 0;
        }, 850);
      }
    }, 2200);
  }
}

/* blog hover cover */
const cover = document.querySelector<HTMLElement>('[data-hover-cover]');
if (cover && fine && !reduced) {
  document.querySelectorAll<HTMLElement>('[data-cover]').forEach((row) => {
    row.addEventListener('pointerenter', () => cover.classList.add('on'));
    row.addEventListener('pointerleave', () => cover.classList.remove('on'));
    row.addEventListener('pointermove', (e) => {
      cover.style.left = `${e.clientX}px`;
      cover.style.top = `${e.clientY}px`;
    });
  });
}

/* books: shelf / list toggle */
const booksView = document.querySelector<HTMLElement>('[data-books-view]');
if (booksView) {
  const buttons = [...booksView.querySelectorAll<HTMLButtonElement>('[data-view]')];
  buttons.forEach((btn) =>
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      booksView.classList.toggle('books-list', btn.dataset.view === 'list');
    })
  );
}

/* music: year tabs with roving tabindex */
const tablist = document.querySelector<HTMLElement>('[data-years]');
if (tablist) {
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement, focus = false) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll<HTMLElement>('.year-panel').forEach((p) => {
      p.hidden = p.id !== `panel-${tab.dataset.year}`;
    });
    if (focus) tab.focus();
    bindCounts();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const keys: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      select(tabs[(keys[e.key] + tabs.length) % tabs.length], true);
    });
  });
}
