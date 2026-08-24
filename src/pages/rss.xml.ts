import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { site } from '../data/site';

export const GET: APIRoute = async (context) => {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort((a, b) => b.data.publishedDate.getTime() - a.data.publishedDate.getTime());
  return rss({
    title: `${site.name} — Writing`,
    description: site.description,
    site: context.site ?? site.url,
    items: posts.map((post) => ({ title: post.data.title, description: post.data.description, pubDate: post.data.publishedDate, link: `/blog/${post.id}/` }))
  });
};
