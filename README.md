# sawlemon.github.io

Source for [sawlemon.github.io](https://sawlemon.github.io), my personal portfolio.

The site covers my work in cybersecurity, cloud engineering, and AI. It also hosts writing and an Apple Music Replay page with yearly stats, monthly listening totals, top artists, top songs, and playlist links.

## Stack

- [Astro 7](https://astro.build/) with static output
- TypeScript
- Astro content collections for Markdown and MDX
- Plain CSS with light and dark themes
- Local font packages for Bodoni Moda, Inter, Space Grotesk, and JetBrains Mono
- GitHub Actions and GitHub Pages

There is no client-side framework. Astro emits static HTML, CSS, RSS, and sitemap files into `dist/`.

## Run it locally

The deployment workflow uses Node.js 22.

```sh
npm install
npm run dev
```

Astro prints the local URL when the server starts.

Before publishing a change, run both checks:

```sh
npm run check
npm run build
```

Preview the production build with:

```sh
npm run preview
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the Astro development server |
| `npm run check` | Runs Astro and TypeScript diagnostics |
| `npm run build` | Builds the static site into `dist/` |
| `npm run preview` | Serves the contents of `dist/` locally |
| `npm run music:refresh -- --no-push` | Refreshes Replay data without committing or pushing |
| `npm run music:refresh` | Refreshes Replay data, commits `src/data/music.json`, and pushes `main` |

## Repository layout

```text
.github/workflows/deploy.yml       GitHub Pages build and deploy workflow
public/images/                     Static images copied into the build
scripts/build-music-data.py        Converts Replay API responses into site data
scripts/refresh-music/             Browser-based Replay refresh tool
src/components/                    Shared header and footer
src/content/blog/                  Local and external writing entries
src/data/music.json                Generated Apple Music Replay data
src/data/site.ts                   Portfolio, project, experience, and credential data
src/layouts/BaseLayout.astro       Shared document layout and metadata
src/pages/index.astro              Portfolio homepage
src/pages/blog/                    Writing index and local article routes
src/pages/music.astro              Apple Music Replay page
src/pages/rss.xml.ts               RSS feed
src/styles/global.css              Site styles and theme tokens
src/utils/blog.ts                  Local and external article link handling
```

## Add writing

Writing entries live in `src/content/blog/`. Published entries appear on the homepage, `/blog/`, and the RSS feed. Entries with `draft: true` stay out of all public routes.

### Local article

Create a Markdown or MDX file with frontmatter, then write the article below it:

```md
---
title: Building a useful security tool
description: What I learned while turning a small script into a tool I could trust.
publishedDate: 2026-08-29
tags:
  - security
  - tooling
draft: false
---

Article content goes here.
```

Astro publishes this example at `/blog/building-a-useful-security-tool/`.

Use `canonicalUrl` and `originalPublication` when the full article is stored here but was first published somewhere else:

```yaml
canonicalUrl: https://example.com/original-article
originalPublication: Example
```

### External article

For an article that should remain on another site, add a metadata-only entry with `externalUrl`. The portfolio card and RSS item link directly to that URL, and Astro does not create an empty local article page.

```md
---
title: Article title
description: A specific one-sentence summary.
publishedDate: 2026-08-29
externalUrl: https://www.linkedin.com/pulse/example
originalPublication: LinkedIn
heroImage:
  src: /images/article-cover.png
  alt: Description of the cover image.
  width: 1280
  height: 720
---
```

Store article covers in `public/images/`. Set the real width and height so the browser can reserve space before the image loads.

The complete frontmatter schema is in [`src/content.config.ts`](src/content.config.ts).

## Update portfolio content

Most structured homepage content lives in [`src/data/site.ts`](src/data/site.ts):

- interests
- projects and project previews
- work experience
- education
- credentials
- profile links and site metadata

The About, Connect, and Hobbies copy currently lives in [`src/pages/index.astro`](src/pages/index.astro).

## Refresh Apple Music Replay

The Replay page reads [`src/data/music.json`](src/data/music.json). Do not hand-edit that file unless you are fixing generated data deliberately.

The refresh tool opens Apple Music Replay in Chromium, waits for login, captures the API requests made by the Replay app, fetches available year and month summaries, and rebuilds `music.json`. Authentication tokens remain in browser memory. The script does not log or write them to disk.

Install the refresh tool once:

```sh
cd scripts/refresh-music
npm install
npx playwright install chromium
cd ../..
```

For a reviewable local refresh, use:

```sh
npm run music:refresh -- --no-push
git diff -- src/data/music.json
```

The full command is intentionally more aggressive:

```sh
npm run music:refresh
```

It runs the fetch, build, and checks, then commits only `src/data/music.json` and pushes `main`. It refuses to perform the commit step from any other branch.

To rebuild from existing files in `/tmp/replay/` without opening Apple Music:

```sh
npm run music:refresh -- --skip-fetch --no-push
```

The persistent browser profile is stored under `scripts/refresh-music/.profile/` and ignored by Git. See [`scripts/refresh-music/README.md`](scripts/refresh-music/README.md) for script-specific notes.

## Deployment

A push to `main` starts [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The workflow:

1. Installs dependencies with `npm ci` on Node.js 22.
2. Runs `npm run check`.
3. Runs `npm run build`.
4. Uploads `dist/` and deploys it to GitHub Pages.

The Astro site URL is set to `https://sawlemon.github.io` in [`astro.config.mjs`](astro.config.mjs). The sitemap integration uses that value when generating URLs.
