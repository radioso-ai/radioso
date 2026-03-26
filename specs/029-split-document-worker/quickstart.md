# Quickstart: Split Document Worker Runtime

## Backend commands

Run the API runtime only:

```bash
cd /Users/dm/conductor/workspaces/radioso/beijing-v1/backend
npm run dev:http
```

Run the worker runtime only:

```bash
cd /Users/dm/conductor/workspaces/radioso/beijing-v1/backend
npm run dev:worker
```

Run both runtimes through local orchestration:

```bash
cd /Users/dm/conductor/workspaces/radioso/beijing-v1
./run-dev.sh
```

## Verification scenarios

1. Start only the API runtime and confirm authenticated HTTP routes still respond.
2. Queue a document while the worker is stopped and confirm the document remains queued.
3. Start the worker runtime and confirm the queued document is processed without restarting the API runtime.
4. Stop the worker runtime, queue more documents, and confirm logs make backlog growth visible.
5. Create a pending migration state and confirm the worker runtime exits before claiming jobs.
