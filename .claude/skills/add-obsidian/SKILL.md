---
name: add-obsidian
description: Connect an Obsidian vault as shared persistent memory for all NanoClaw agents. Agents will read and write structured Markdown notes with bidirectional links to remember users, projects, and context across sessions. Also sets up automatic daily memory consolidation.
---

# Add Obsidian Memory

This skill connects a local Obsidian vault to NanoClaw so all agents share structured, persistent, token-friendly memory. No code changes required — this is pure configuration.

## Phase 1: Pre-flight

### Check if already configured

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null && echo "ALLOWLIST_EXISTS" || echo "ALLOWLIST_MISSING"
grep -n "Obsidian" groups/global/CLAUDE.md && echo "CLAUDE_MD_CONFIGURED" || echo "CLAUDE_MD_NOT_CONFIGURED"
```

If both are already configured, skip to Phase 6 (Verify).

## Phase 2: Collect Information

Use `AskUserQuestion` to collect:

**Required:**
- **Vault path** — absolute path to the Obsidian vault folder on this machine
  - macOS example: `/Users/john/Documents/NanoMemory`
  - Linux example: `/home/john/obsidian/NanoMemory`

**For user profile (use what you already know from context, only ask what's missing):**
- Preferred name
- Preferred language (for vault content)
- Brief description (role, interests — anything useful for agents to remember)

Store as: `VAULT_PATH`, `USER_NAME`, `USER_LANG`, `USER_DESC`.

## Phase 3: Configure Mount Security

The allowlist lives outside the project so containers cannot tamper with it.

```bash
mkdir -p ~/.config/nanoclaw
```

**If allowlist does NOT exist**, create it:

```bash
VAULT_PARENT=$(dirname "$VAULT_PATH")
cat > ~/.config/nanoclaw/mount-allowlist.json << EOF
{
  "allowedRoots": [
    {
      "path": "$VAULT_PARENT",
      "allowReadWrite": true,
      "description": "Obsidian Memory Vault"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
EOF
```

**If allowlist already exists**, merge the new root without overwriting:

```bash
node -e "
const fs = require('fs'), path = require('path'), os = require('os');
const p = path.join(os.homedir(), '.config/nanoclaw/mount-allowlist.json');
const config = JSON.parse(fs.readFileSync(p, 'utf-8'));
const vaultParent = path.dirname('$VAULT_PATH');
if (!config.allowedRoots.some(r => r.path === vaultParent)) {
  config.allowedRoots.push({ path: vaultParent, allowReadWrite: true, description: 'Obsidian Memory Vault' });
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  console.log('Added:', vaultParent);
} else {
  console.log('Already present:', vaultParent);
}
"
```

## Phase 4: Configure Groups

### Add vault mount to all groups in the database

Run from the NanoClaw project root:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db');
const groups = db.prepare('SELECT jid, name, folder, container_config FROM groups').all();
console.log('Groups:', groups.map(g => g.folder).join(', '));
const newMount = { hostPath: '$VAULT_PATH', containerPath: 'obsidian', readonly: false };
let updated = 0;
for (const group of groups) {
  if (group.folder === 'global') continue;
  const existing = group.container_config ? JSON.parse(group.container_config) : {};
  const mounts = existing.additionalMounts || [];
  if (mounts.some(m => m.hostPath === '$VAULT_PATH')) { console.log('Already set:', group.folder); continue; }
  mounts.push(newMount);
  existing.additionalMounts = mounts;
  db.prepare('UPDATE groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(existing), group.folder);
  console.log('Updated:', group.folder);
  updated++;
}
db.close();
console.log('Done. Updated:', updated, 'group(s)');
"
```

### Update groups/global/CLAUDE.md

Check if already present:

```bash
grep -q "Obsidian" groups/global/CLAUDE.md && echo "EXISTS" || echo "MISSING"
```

If MISSING, append:

```bash
cat >> groups/global/CLAUDE.md << 'EOF'

## Shared Obsidian Memory

You have access to a shared persistent memory vault mounted at `/workspace/extra/obsidian/`.

### Loading strategy (token-friendly ⚡)
1. If context is unknown or starting a new topic → read `/workspace/extra/obsidian/_index.md` first
2. Follow only the `[[...]]` links relevant to the current context
3. Never load all files at once
4. After learning something important and durable → update the relevant file (or create a new one)

### Vault structure
- `_index.md` ← always start here
- `/agents/` ← agent profiles and capabilities
- `/users/` ← user profiles and preferences
- `/projects/` ← ongoing projects (one file per project)
- `/system/` ← NanoClaw architecture and memory conventions

### When to update memory
- New user preference discovered → `users/[name].md`
- New project started → create `projects/[name].md` + add link in `_index.md`
- Important decision or technical info → `system/` or relevant file
- Always update the `updated:` field in the YAML frontmatter
EOF
echo "Appended to global/CLAUDE.md"
```

## Phase 5: Create Vault Structure

Create the initial file structure in the user's vault. Skip any file that already exists.

### Directories

```bash
mkdir -p "$VAULT_PATH/agents" "$VAULT_PATH/users" "$VAULT_PATH/projects" "$VAULT_PATH/system"
```

### _index.md

```bash
[ -f "$VAULT_PATH/_index.md" ] || cat > "$VAULT_PATH/_index.md" << EOF
---
updated: $(date +%Y-%m-%d)
---

# Shared Memory — Index

> Entry point for all agents. Load this file first, then follow relevant links only. Never load everything at once.

## Agents
<!-- Agent profiles added here as they are created -->

## Users
- [[users/$USER_NAME]] — $USER_DESC

## System
- [[system/memory]] — How to use this memory system

## Active Projects
<!-- Add project links here as they are created -->

## Recent Notes
<!-- Updated automatically by daily consolidation -->
EOF
```

### system/memory.md

```bash
[ -f "$VAULT_PATH/system/memory.md" ] || cat > "$VAULT_PATH/system/memory.md" << EOF
---
type: system
tags: [memory, conventions]
updated: $(date +%Y-%m-%d)
---

# Obsidian Memory System

## Principle
Shared memory across all NanoClaw agents. Markdown files with bidirectional links. Mounted in each container at \`/workspace/extra/obsidian/\`.

## Loading strategy (token-friendly ⚡)
1. Always start with \`[[_index]]\` if context is unknown
2. Load only files relevant to the current context
3. Never load all files at once
4. Write updates after important interactions

## File conventions
- **YAML frontmatter**: \`type\`, \`tags\`, \`updated\` always required
- **Links**: \`[[path/file]]\` (Obsidian wikilinks, no .md extension)
- **Max file size**: ~80 lines (split if larger)
- **Naming**: lowercase, hyphens, no spaces or special characters

## File types
| Type | Folder | Description |
|------|--------|-------------|
| agent | /agents/ | Agent profile and capabilities |
| user | /users/ | User profile and preferences |
| project | /projects/ | Project tracking |
| system | /system/ | Architecture and conventions |

## Links
- [[_index]]
EOF
```

### User profile

Create in the **user's language** (`$USER_LANG`). Write the content naturally in that language:

```bash
[ -f "$VAULT_PATH/users/$USER_NAME.md" ] || cat > "$VAULT_PATH/users/$USER_NAME.md" << EOF
---
type: user
tags: [user]
updated: $(date +%Y-%m-%d)
---

# $USER_NAME

<!-- Write this file's content in $USER_LANG -->

## Profile
$USER_DESC

## Communication
- Language: $USER_LANG
- Main channel: (fill in)

## Projects
<!-- Add project links as they are created -->

## Links
<!-- Add agent and project links as they are created -->
EOF
```

## Phase 6: Set Up Automatic Memory Consolidation

This step creates a daily scheduled task that reads conversation history and automatically updates the vault with durable information.

Insert the task directly into the NanoClaw database (replace `[USER_LANG]` with the actual language value):

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db');

// Get all non-global registered groups
const groups = db.prepare(\"SELECT jid, folder FROM registered_groups WHERE folder != 'global'\").all();
if (groups.length === 0) { console.error('No groups found'); process.exit(1); }

const PROMPT = \`You are a NanoClaw agent. Your task: consolidate important information from today's conversations into the shared Obsidian memory vault.

## Vault location
\\\`/workspace/extra/obsidian/\\\` — start by reading \\\`_index.md\\\`.

## Procedure

### 1. Read recent conversation history
Read session files in \\\`/home/node/.claude/projects/-workspace-group/*.jsonl\\\`.
Extract only queue-operation entries with operation: enqueue from the last 24 hours.
Parse the content field to get the conversation exchanges.

### 2. Identify durable information
Only retain what deserves long-term memory:
- New user preferences discovered
- Important technical or project decisions
- New projects or status changes on existing projects
- Biographical or contextual info about the user
- Bugs resolved or features delivered
- NOT: casual conversation, greetings, one-off questions
- NOT: information already present in the vault

### 3. Update the vault
For each durable piece of information:
- Update the relevant existing file (users/, projects/, system/)
- Create a new file if needed (follow conventions in system/memory.md)
- Update the updated: frontmatter field
- Add new projects to _index.md if needed

### 4. Write consolidation log
Update \\\`/workspace/extra/obsidian/system/consolidations.md\\\`:
- Date of consolidation
- Number of files updated
- 2-3 line summary of what was memorized

### Rules
- Write content in [USER_LANG]
- Be conservative: when in doubt, do not write
- Keep files under ~80 lines (split if needed)
- Do NOT send a message to the user unless a critical error occurs
- Stay token-friendly: only load relevant vault files\`;

const now = new Date();
const nextRun = new Date();
nextRun.setHours(23, 0, 0, 0);
if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);

let created = 0;
for (const group of groups) {
  const taskId = 'task-' + Date.now() + '-obsidian-' + group.folder;
  // Check if consolidation task already exists for this group
  const existing = db.prepare(\"SELECT id FROM scheduled_tasks WHERE group_folder = ? AND schedule_value = '0 23 * * *' AND status = 'active'\").get(group.folder);
  if (existing) { console.log('Already exists for:', group.folder); continue; }
  db.prepare(\`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, 'cron', '0 23 * * *', 'group', ?, 'active', ?)\`)
    .run(taskId, group.folder, group.jid, PROMPT, nextRun.toISOString(), now.toISOString());
  console.log('Task created for:', group.folder);
  created++;
}
db.close();
console.log('Done. Tasks created:', created);
"
```

## Phase 7: Restart NanoClaw

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Wait 3–5 seconds.

## Phase 8: Verify

```bash
tail -20 logs/nanoclaw.log | grep -i "obsidian\|mount\|allowlist\|extra"
```

Then tell the user:

> ✅ **Obsidian memory is ready!**
>
> Your vault at `[VAULT_PATH]` is now mounted in all agent containers at `/workspace/extra/obsidian/`.
>
> **What happens now:**
> - Agents read `_index.md` when starting a new topic or session
> - They navigate to relevant files via `[[links]]` — never loading everything at once
> - Every night at 11pm, a task automatically extracts important info from the day's conversations and updates your vault
> - You can open your vault in Obsidian and watch the memory grow — the Graph View shows how everything connects
>
> Your memory vault is at: `[VAULT_PATH]`

## Troubleshooting

### Mount not appearing (`/workspace/extra/obsidian/` is empty)

1. Check allowlist: `cat ~/.config/nanoclaw/mount-allowlist.json`
2. Check DB: `node -e "const db = require('better-sqlite3')('./store/messages.db'); console.log(JSON.stringify(db.prepare('SELECT folder, container_config FROM groups').all(), null, 2))"`
3. Check logs: `tail -50 logs/nanoclaw.log`
4. Ensure NanoClaw was restarted after the changes

### "Path not under any allowed root" in logs

The vault's parent directory is not in the allowlist. Re-run Phase 3.

### Vault already has content

The skill never overwrites existing files (all creation commands check `[ -f ... ]` first).
