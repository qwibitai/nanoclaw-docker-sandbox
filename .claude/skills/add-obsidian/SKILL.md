---
name: add-obsidian
description: Add a shared Obsidian vault as persistent, token-friendly memory for all NanoClaw agents. Agents will read and write structured Markdown notes with bidirectional links to remember users, projects, and context across sessions.
---

# Add Obsidian Memory

This skill connects an Obsidian vault to NanoClaw so all agents share a structured, persistent memory. No code changes required — this is pure configuration.

## Phase 1: Pre-flight

### Check if already configured

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null && echo "EXISTS" || echo "NOT FOUND"
```

Also check `groups/global/CLAUDE.md` for an "Obsidian" section:

```bash
grep -n "Obsidian" groups/global/CLAUDE.md && echo "ALREADY CONFIGURED" || echo "NOT CONFIGURED"
```

If already configured, skip to Phase 5 (Verify).

## Phase 2: Collect Information

Use `AskUserQuestion` to collect:

1. **Vault path** — absolute path to the Obsidian vault folder on the host machine
   - Example Mac: `/Users/john/Documents/MyVault`
   - Example Linux: `/home/john/obsidian/MyVault`

2. **User info** (to create the initial user profile) — ask only what's unknown:
   - Name / preferred name
   - Preferred language
   - Brief description (role, interests, or anything useful for the agent to remember)

3. **Which groups** — ask if they want the vault shared with all groups or specific ones:
   - "All groups" (recommended)
   - "Main group only"

Store these answers as variables: `VAULT_PATH`, `USER_NAME`, `USER_LANG`, `USER_DESC`, `TARGET_GROUPS`.

## Phase 3: Configure Mount Security

### Create or update the mount allowlist

The allowlist is stored outside the project so containers cannot tamper with it.

```bash
mkdir -p ~/.config/nanoclaw
```

Check if the file already exists:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null
```

**If it does NOT exist**, create it:

```bash
VAULT_PARENT=$(dirname "$VAULT_PATH")

cat > ~/.config/nanoclaw/mount-allowlist.json << EOF
{
  "allowedRoots": [
    {
      "path": "$VAULT_PARENT",
      "allowReadWrite": true,
      "description": "Obsidian Vault"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
EOF
```

**If it already exists**, add the new root to it using Node.js (to avoid breaking existing config):

```bash
node -e "
const fs = require('fs');
const p = require('os').homedir() + '/.config/nanoclaw/mount-allowlist.json';
const config = JSON.parse(fs.readFileSync(p, 'utf-8'));
const vaultParent = require('path').dirname('$VAULT_PATH');
const already = config.allowedRoots.some(r => r.path === vaultParent);
if (!already) {
  config.allowedRoots.push({ path: vaultParent, allowReadWrite: true, description: 'Obsidian Vault' });
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  console.log('Added:', vaultParent);
} else {
  console.log('Already present:', vaultParent);
}
"
```

## Phase 4: Configure Groups

### Add the vault mount to all target groups in the database

Run this Node.js script from the NanoClaw project root:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db');

const groups = db.prepare('SELECT jid, name, folder, container_config FROM groups').all();
console.log('Groups found:', groups.map(g => g.folder).join(', '));

const newMount = {
  hostPath: '$VAULT_PATH',
  containerPath: 'obsidian',
  readonly: false
};

let updated = 0;
for (const group of groups) {
  if (group.folder === 'global') continue; // global group has no container

  const existing = group.container_config ? JSON.parse(group.container_config) : {};
  const mounts = existing.additionalMounts || [];

  // Skip if already configured for this vault
  if (mounts.some(m => m.hostPath === '$VAULT_PATH')) {
    console.log('Already configured:', group.folder);
    continue;
  }

  mounts.push(newMount);
  existing.additionalMounts = mounts;

  db.prepare('UPDATE groups SET container_config = ? WHERE folder = ?')
    .run(JSON.stringify(existing), group.folder);
  console.log('Updated:', group.folder);
  updated++;
}

db.close();
console.log('Done. Groups updated:', updated);
"
```

### Update global/CLAUDE.md

Check if the Obsidian section already exists:

```bash
grep -q "Mémoire partagée Obsidian\|Shared Obsidian Memory" groups/global/CLAUDE.md && echo "EXISTS" || echo "MISSING"
```

If MISSING, append it:

```bash
cat >> groups/global/CLAUDE.md << 'EOF'

## Shared Obsidian Memory

You have access to a shared persistent memory via an Obsidian vault mounted at `/workspace/extra/obsidian/`.

### Loading strategy (token-friendly ⚡)
1. If context is unknown or at the start of a new topic → read `/workspace/extra/obsidian/_index.md`
2. Follow only the `[[...]]` links relevant to the current context
3. Never load all files at once
4. After learning something important and durable → update the relevant file (or create a new one)

### Vault structure
- `_index.md` ← always start here (lightweight map)
- `/agents/` ← agent profiles and capabilities
- `/utilisateurs/` ← user profiles and preferences
- `/projets/` ← ongoing projects (one file per project)
- `/systeme/` ← NanoClaw architecture and conventions

### When to update memory
- New user preference discovered → `utilisateurs/[name].md`
- New project started → create `projets/[name].md` + add link in `_index.md`
- Important technical info → `systeme/` or dedicated file
- Update `updated:` frontmatter field on every modification
EOF
echo "Appended to global/CLAUDE.md"
```

## Phase 5: Create Vault Structure

Create the initial vault structure inside the user's vault path.

### _index.md

```bash
cat > "$VAULT_PATH/_index.md" << 'EOF'
---
updated: CURRENT_DATE
---

# Shared Memory — Index

> Entry point. Load this file first, then navigate to relevant links only.

## Agents
<!-- Add agent profiles here as they are created -->

## Users
<!-- Add user profiles here as they are created -->

## System
- [[systeme/nanoclaw]] — NanoClaw architecture
- [[systeme/memoire]] — How to use this memory system

## Active Projects
<!-- Add project links here as they are created -->

## Recent Notes
_(fill in over time)_
EOF
```

Replace `CURRENT_DATE` with today's date:

```bash
sed -i "s/CURRENT_DATE/$(date +%Y-%m-%d)/" "$VAULT_PATH/_index.md"
```

### systeme/memoire.md

```bash
mkdir -p "$VAULT_PATH/systeme" "$VAULT_PATH/agents" "$VAULT_PATH/utilisateurs" "$VAULT_PATH/projets"

cat > "$VAULT_PATH/systeme/memoire.md" << EOF
---
type: systeme
tags: [memoire, convention]
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
- **YAML frontmatter**: \`type\`, \`tags\`, \`updated\` (always required)
- **Links**: \`[[path/file]]\` (Obsidian wikilinks, no .md extension)
- **Max file size**: ~80 lines (split if larger)
- **Naming**: lowercase, hyphens, no spaces or accents

## Types
| Type | Folder | Description |
|------|--------|-------------|
| agent | /agents/ | Agent profile and capabilities |
| utilisateur | /utilisateurs/ | User profile and preferences |
| projet | /projets/ | Project tracking |
| systeme | /systeme/ | Architecture and conventions |

## Links
- [[_index]]
EOF
```

### Create initial user profile

Using the information collected in Phase 2, create a user profile:

```bash
cat > "$VAULT_PATH/utilisateurs/$USER_NAME.md" << EOF
---
type: utilisateur
tags: [utilisateur]
updated: $(date +%Y-%m-%d)
---

# $USER_NAME

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

Then add the user link to `_index.md`:

```bash
sed -i "s|<!-- Add user profiles here as they are created -->|- [[$USER_NAME]] — $USER_DESC|" "$VAULT_PATH/_index.md" 2>/dev/null || true
```

If `sed -i` fails (macOS), use:

```bash
sed -i '' "s|<!-- Add user profiles here as they are created -->|- [[utilisateurs\/$USER_NAME]] — $USER_DESC|" "$VAULT_PATH/_index.md"
```

## Phase 6: Restart NanoClaw

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Wait 3–5 seconds for the service to restart.

## Phase 7: Verify

### Confirm vault is accessible

Check the logs:

```bash
tail -20 logs/nanoclaw.log | grep -i "obsidian\|mount\|allowlist"
```

### Tell the user

> ✅ Obsidian memory is now configured!
>
> Your vault at `$VAULT_PATH` is mounted in all agent containers at `/workspace/extra/obsidian/`.
>
> Agents will now:
> - Read `_index.md` when starting a new topic or session
> - Navigate to relevant files via `[[links]]`
> - Update memory after important interactions
>
> You can open your vault in Obsidian and see the memory evolve over time. The graph view will show connections between files.

## Troubleshooting

### Mount not appearing in container

1. Verify allowlist: `cat ~/.config/nanoclaw/mount-allowlist.json`
2. Verify DB: `node -e "const db = require('better-sqlite3')('./store/messages.db'); console.log(db.prepare('SELECT folder, container_config FROM groups').all());"`
3. Check NanoClaw logs: `tail -50 logs/nanoclaw.log`
4. Ensure NanoClaw was restarted after changes

### "Path not under any allowed root" in logs

The vault path's parent directory is not in the allowlist. Re-run Phase 3 to add it.

### Vault already has content

The skill will not overwrite existing files. It only creates files that don't exist yet.
