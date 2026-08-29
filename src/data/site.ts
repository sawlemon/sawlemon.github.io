export type Project = {
  title: string;
  description: string;
  tags: string[];
  preview?: {
    src: string;
    alt: string;
    width: number;
    height: number;
  };
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

export const interestGroups = [
  {
    title: 'Security Engineering',
    accent: false,
    columns: false,
    topics: [
      ['Detection engineering', 'Detection rules, lookups, and tuning on NG-SIEM platforms.'],
      ['Security automation', 'SOAR workflows that turn alerts into automated response.'],
      ['Vibe hacking', 'Hunting CTF flags with LLMs in the loop. Early days.']
    ]
  },
  {
    title: 'Cloud & Infrastructure',
    accent: false,
    columns: false,
    topics: [
      ['Cloud security', 'Security across cloud platforms and services.'],
      ['Cloud and DevOps engineering', 'Cloud platforms and delivery practices.'],
      ['Kubernetes and infrastructure as code', 'Modern infrastructure operations.']
    ]
  },
  {
    title: 'AI Security',
    accent: true,
    columns: false,
    topics: [
      ['AI and LLM security', 'LLM jailbreaking, adversarial ML, and the OWASP LLM Top 10.']
    ]
  },
  {
    title: 'Tools & Community',
    accent: false,
    columns: true,
    topics: [
      ['Open-source tools', 'Useful tools and community-led software.'],
      ['Technical writing and community education', 'Sharing practical knowledge clearly.']
    ]
  }
] as const;

export const projects: Project[] = [
  {
    title: 'LLM Report Card',
    description: 'An evidence-based dashboard for comparing AI models across practical strengths, limitations, and observed behavior.',
    tags: ['AI evaluation', 'React', 'GitHub Pages'],
    preview: {
      src: '/images/llm-report-card-preview.jpg',
      alt: 'LLM Report Card dashboard showing the provider index, model filters, and Anthropic model cards',
      width: 1265,
      height: 712
    },
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
