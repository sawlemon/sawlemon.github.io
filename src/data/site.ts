export type Project = {
  title: string;
  description: string;
  tags: string[];
  href?: string;
  sourceHref?: string;
  status?: 'coming-soon';
};

export const site = {
  name: 'Solomon Raj A',
  handle: 'SAWLEMON',
  url: 'https://sawlemon.github.io',
  description: 'Personal portfolio of Solomon Raj A, a Senior Consultant in Cybersecurity at Presidio.',
  linkedin: 'https://www.linkedin.com/in/solomonraja/',
  github: 'https://github.com/sawlemon'
} as const;

export const interests = [
  ['Cybersecurity engineering', 'Practical security design and implementation.'],
  ['SIEM implementation', 'Event visibility and security monitoring systems.'],
  ['Endpoint security', 'Endpoint protection and operational security.'],
  ['Security operations and detection', 'Detection engineering and investigation workflows.'],
  ['Cloud security', 'Security across cloud platforms and services.'],
  ['AI and LLM security', 'Security questions raised by AI systems.'],
  ['Cloud and DevOps engineering', 'Cloud platforms and delivery practices.'],
  ['Kubernetes and infrastructure as code', 'Modern infrastructure operations.'],
  ['Open-source tools', 'Useful tools and community-led software.'],
  ['Technical writing and community education', 'Sharing practical knowledge clearly.']
] as const;

export const projects: Project[] = [
  {
    title: 'LLM Report Card',
    description: 'An evidence-based dashboard for comparing AI models across practical strengths, limitations, and observed behavior.',
    tags: ['AI evaluation', 'React', 'GitHub Pages'],
    href: 'https://sawlemon.github.io/llm-reportcard/',
    sourceHref: 'https://github.com/sawlemon/llm-reportcard'
  },
  {
    title: 'Next project',
    description: 'A new project will appear here when it is ready to share.',
    tags: ['Coming soon'],
    status: 'coming-soon'
  },
  {
    title: 'More work',
    description: 'More selected work is being prepared for this portfolio.',
    tags: ['Coming soon'],
    status: 'coming-soon'
  }
];

export const experience = [
  ['Senior Consultant', 'June 2025 to present'],
  ['Senior Cloud Engineer', 'March 2024 to July 2025'],
  ['Cloud Engineer', 'July 2022 to April 2024'],
  ['Associate Cloud Engineer', 'June 2021 to July 2022'],
  ['Cloud Engineer Trainee', 'October 2020 to June 2021']
] as const;

export const education = [
  ['BITS Pilani', 'Master of Technology, Cloud Computing', '2023 to 2025'],
  ['KGiSL Institute of Technology', 'Bachelor of Engineering, Computer Science and Engineering', '2017 to 2021']
] as const;

export const credentials = [
  ['CrowdStrike Certified Falcon Administrator (CCFA)', ''],
  ['CrowdStrike Certified SIEM Engineer (CCSE)', 'Latest'],
  ['NVIDIA Certified Associate: AI Infrastructure', ''],
  ['Google Professional Cloud Architect', 'October 2024'],
  ['Certified Kubernetes Administrator', 'September 2023'],
  ['Microsoft AZ-400', 'July 2021'],
  ['Microsoft Azure Fundamentals', 'June 2021'],
  ['HashiCorp Terraform Associate', ''],
  ['AWS SysOps Administrator Associate', ''],
  ['AWS Cloud Practitioner', ''],
  ['Microsoft Azure Administrator Associate', '']
] as const;
