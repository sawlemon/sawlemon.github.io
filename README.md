# sawlemon.github.io

Static portfolio and Markdown-first blog for Solomon Raj A.

## Local development

```sh
npm install
npm run dev
```

## Add a blog post

Add a Markdown file under `src/content/blog/` with the required frontmatter:

```yaml
---
title: Your article title
description: A concise summary.
publishedDate: 2026-08-24
tags: [cybersecurity]
draft: false
---
```

Use `canonicalUrl` and `originalPublication` when migrating an article first published elsewhere.
