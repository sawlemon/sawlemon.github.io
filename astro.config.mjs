import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sawlemon.fyi',
  output: 'static',
  integrations: [sitemap()]
});
