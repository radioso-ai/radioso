# Radioso Dashboard

The Next.js app an operator works in. Here you give an agent its identity, write the directives that steer it, build the routines that carry a request across turns, bind the skills it acts with, and manage the documents and sources it answers from. You also watch live conversations, triage the ones that need a person, and take one over yourself when it does.

The rail is Activity, Agents, Knowledge Base, Eval, and Settings. Agent configuration lives under Agents, next to a Chat tab for trying the agent as you change it and a Channels group for publishing it — public chat link, website widget, API, MCP, Slack, WhatsApp.

## Getting Started

The default local start command for the full Radioso stack is:

```bash
./run-dev.sh
```

That command checks Docker and other local prerequisites, asks which supported AI provider you want to use, collects the required API credentials into `.env`, and starts the local frontend, backend, and database stack through Docker Compose.

The full stack uses `RADIOSO_FRONTEND_PORT`, `RADIOSO_BACKEND_PORT`, and `RADIOSO_POSTGRES_PORT` when those variables are set. In Conductor workspaces, `./run-dev.sh` maps these from the workspace `CONDUCTOR_PORT` range so parallel workspaces do not share the same Docker project or host ports.

After the stack is ready, open the frontend URL printed by the bootstrap, sign in, let Radioso seed the starter docs for an empty workspace, wait for processing, and ask one of the suggested first questions from the agent's Chat tab. A valid provider key is required for document processing and chat.

That first answer is where configuration starts. Under Agents, set the agent's identity and appearance, then write a directive to steer how it handles a case you care about, and add a routine when a request takes several turns to finish. Bind a skill so the agent can act on a request rather than only answer it. Publish the agent from the Channels group, then watch what it does under Activity: All activity holds the transcripts with their turn traces, Needs attention collects the conversations asking for a person, and Take over lets you answer in the agent's place and hand back when you are done.

If you only need the standalone frontend development server, run:

```bash
pnpm run dev
```

That starts the standalone Next.js app on [http://localhost:3000](http://localhost:3000).

Workspace control copy is sourced from repo-level markdown files under [`/docs/settings-docs`](../docs/settings-docs). Each setting owns a separate `.md` file that provides the label, inline summary, and tooltip copy rendered by the relevant dashboard surface, including Agent, Knowledge Base, and Settings.

The dashboard account menu in the bottom-left corner includes a `Users` shortcut for account membership. It opens the Users tab in Settings, where you can invite teammates, review active users, and copy the latest invitation link. Invitation links open the public join flow at `/invite/[token]`, where the invited person creates or reuses their own login and then lands in the shared account workspace context.

`app/page.tsx` handles sign-in and the redirect into a workspace. The dashboard itself is one catch-all route, `app/w/[workspaceKey]/[[...segments]]/page.tsx`, with the section and tab parsed by `lib/dashboard-routes.ts` and the navigation defined in `lib/dashboard-areas.ts` and `components/dashboard/`. Pages auto-update as you edit them.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
