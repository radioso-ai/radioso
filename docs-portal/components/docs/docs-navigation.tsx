import {
  AlertTriangle,
  Book,
  Code2,
  Database,
  FileText,
  type LucideIcon,
  Settings2,
  Shield,
  Workflow,
} from 'lucide-react'

export type NavItem = {
  title: string
  href?: string
  icon?: LucideIcon
  items?: NavItem[]
}

export const navigation: NavItem[] = [
  {
    title: 'Getting Started',
    icon: Book,
    items: [
      { title: 'Overview', href: '/quickstarts' },
      { title: 'Run locally in 5 minutes', href: '/quickstarts/run-locally' },
      { title: 'Embed on your website', href: '/quickstarts/website-embed' },
      { title: 'API first success', href: '/quickstarts/api-first-success' },
    ],
  },
  {
    title: 'Why Radioso',
    icon: Shield,
    items: [
      { title: 'Overview', href: '/why-radioso' },
      { title: 'Grounded answers', href: '/why-radioso/grounded-answers' },
      { title: 'Use cases', href: '/why-radioso/use-cases' },
    ],
  },
  {
    title: 'Guides',
    icon: Code2,
    items: [
      { title: 'Authentication', href: '/guides/authentication' },
      { title: 'Document upload', href: '/guides/document-upload' },
      { title: 'Retrieval tuning', href: '/guides/retrieval-tuning' },
    ],
  },
  {
    title: 'API',
    icon: Database,
    items: [
      { title: 'Overview', href: '/api' },
      { title: 'Auth and sessions', href: '/api/auth-and-sessions' },
      { title: 'Accounts and users', href: '/api/accounts-and-users' },
      { title: 'Workspaces and tokens', href: '/api/workspaces-and-tokens' },
      { title: 'Documents and search', href: '/api/documents-and-search' },
      { title: 'Chat and history', href: '/api/chat-and-history' },
      { title: 'Public chat and embed', href: '/api/public-chat-and-embed' },
      { title: 'Settings', href: '/api/settings' },
      { title: 'Evals', href: '/api/evals' },
      { title: 'Connectors and webhooks', href: '/api/connectors-and-webhooks' },
      { title: 'API reference', href: '/api-reference' },
    ],
  },
  {
    title: 'SDK',
    icon: Settings2,
    items: [
      { title: 'TypeScript getting started', href: '/sdk/typescript-getting-started' },
      { title: 'Basic usage', href: '/sdk/basic-usage' },
      { title: 'Retrieval settings', href: '/sdk/retrieval-settings' },
    ],
  },
  {
    title: 'Architecture',
    icon: Workflow,
    items: [
      { title: 'Overview', href: '/architecture' },
      { title: 'Retrieval pipeline', href: '/architecture/retrieval-pipeline' },
      { title: 'Document processing lifecycle', href: '/architecture/document-processing-lifecycle' },
      { title: 'Deployment topology', href: '/architecture/deployment-topology' },
    ],
  },
  {
    title: 'Operators',
    icon: FileText,
    items: [
      { title: 'Overview', href: '/operators' },
      { title: 'Deployment', href: '/operators/deployment' },
      { title: 'Document processing', href: '/operators/document-processing' },
    ],
  },
  {
    title: 'Security',
    icon: Shield,
    items: [
      { title: 'Overview', href: '/security' },
      { title: 'Token handling', href: '/security/token-handling' },
      { title: 'Public embed safety', href: '/security/public-embed-safety' },
    ],
  },
  {
    title: 'Troubleshooting',
    icon: AlertTriangle,
    items: [
      { title: 'Overview', href: '/troubleshooting' },
      { title: 'Startup failures', href: '/troubleshooting/startup-failures' },
      { title: 'Document processing failures', href: '/troubleshooting/document-processing-failures' },
      { title: 'Retrieval quality debugging', href: '/troubleshooting/retrieval-quality-debugging' },
    ],
  },
]

export const mobileDiscoveryLinks = [
  { title: 'API reference', href: '/api-reference' },
  { title: 'Operators', href: '/operators' },
  { title: 'Security', href: '/security' },
  { title: 'Troubleshooting', href: '/troubleshooting' },
]
