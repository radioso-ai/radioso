import os, json, re
from collections import Counter

projects_dir = os.path.expanduser('~/.claude/projects')
jsonl_files = []
for root, dirs, files in os.walk(projects_dir):
    for f in files:
        if f.endswith('.jsonl'):
            jsonl_files.append(os.path.join(root, f))

jsonl_files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
jsonl_files = jsonl_files[:50]

print(f'Scanning {len(jsonl_files)} transcript files...')

bash_cmds = Counter()
mcp_tools = Counter()

for path in jsonl_files:
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                msg = obj.get('message', {})
                if msg.get('role') != 'assistant':
                    continue
                for item in msg.get('content', []):
                    if not isinstance(item, dict) or item.get('type') != 'tool_use':
                        continue
                    name = item.get('name', '')
                    inp = item.get('input', {})
                    if name == 'Bash':
                        cmd = inp.get('command', '').strip()
                        cmd_stripped = re.sub(r'^([A-Z_]+=\S+\s+)+', '', cmd)
                        tokens = cmd_stripped.split()
                        if not tokens:
                            continue
                        t0 = tokens[0]
                        if t0 == 'sudo' and len(tokens) > 1:
                            tokens = tokens[1:]
                        if len(tokens) >= 2:
                            key = tokens[0] + ' ' + tokens[1]
                        else:
                            key = tokens[0]
                        bash_cmds[key] += 1
                    elif name.startswith('mcp__'):
                        mcp_tools[name] += 1
    except Exception:
        pass

print('\n=== TOP BASH COMMANDS ===')
for cmd, count in bash_cmds.most_common(60):
    print(f'{count:4d}  {cmd}')

print('\n=== TOP MCP TOOLS ===')
for tool, count in mcp_tools.most_common(30):
    print(f'{count:4d}  {tool}')
