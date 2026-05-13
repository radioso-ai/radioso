# radioso-fe-v7

This is a [Next.js](https://nextjs.org) project bootstrapped with [v0](https://v0.app).

## Built with v0

This repository is linked to a [v0](https://v0.app) project. You can continue developing by visiting the link below -- start new chats to make changes, and v0 will push commits directly to this repo. Every merge to `main` will automatically deploy.

[Continue working on v0 →](https://v0.app/chat/projects/prj_f7R8islKPBhdNZsn8iGS8CFQcD89)

## Getting Started

The default local start command for the full Radioso stack is:

```bash
./run-dev.sh
```

That command checks Docker and other local prerequisites, asks which supported AI provider you want to use, collects the required API credentials into `.env`, and starts the local frontend, backend, and database stack through Docker Compose.

After the stack is ready, open the app on [http://localhost:3000](http://localhost:3000), sign in, let Radioso seed the starter docs for an empty workspace, wait for processing, and ask one of the suggested first questions. A valid provider key is required for document processing and chat.

If you only need the standalone frontend development server, run:

```bash
pnpm run dev
```

That starts the standalone Next.js app on [http://localhost:3000](http://localhost:3000).

Workspace control copy is sourced from repo-level markdown files under [`/docs/settings-docs`](../docs/settings-docs). Each setting owns a separate `.md` file that provides the label, inline summary, and tooltip copy rendered by the relevant dashboard surface, including Agent, Knowledge Base, and Settings.

The dashboard account menu in the bottom-left corner includes a `Users` shortcut for account membership. It opens the Users tab in Settings, where you can invite teammates, review active users, and copy the latest invitation link. Invitation links open the public join flow at `/invite/[token]`, where the invited person creates or reuses their own login and then lands in the shared account workspace context.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Learn More

To learn more, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [v0 Documentation](https://v0.app/docs) - learn about v0 and how to use it.

<a href="https://v0.app/chat/api/kiro/clone/borohhov/radioso-fe-v7" alt="Open in Kiro"><img src="https://pdgvvgmkdvyeydso.public.blob.vercel-storage.com/open%20in%20kiro.svg?sanitize=true" /></a>
