import type { CollectionEntry } from 'astro:content';

export function postHref(post: CollectionEntry<'blog'>): string {
  return post.data.externalUrl ?? `/blog/${post.id}/`;
}

export function isExternalPost(post: CollectionEntry<'blog'>): boolean {
  return Boolean(post.data.externalUrl);
}
