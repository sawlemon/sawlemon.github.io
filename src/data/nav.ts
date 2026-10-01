export type NavSection = { label: string; id: string };

// Order and numbering must stay in sync with the section labels on the home page.
export const navSections: NavSection[] = [
  { label: 'About', id: 'about' },
  { label: 'Projects', id: 'projects' },
  { label: 'Experience', id: 'experience' },
  { label: 'Interests', id: 'interests' },
  { label: 'Credentials', id: 'credentials' },
  { label: 'Writing', id: 'writing' },
  { label: 'Connect', id: 'connect' }
];
