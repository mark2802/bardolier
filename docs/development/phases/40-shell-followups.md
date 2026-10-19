# Phase 40 — shell follow-ups from the phase 37 review

**Goal:** fix what phase 37 (zsh shell, PR #5) left behind: a stale done-check, `--root` writing
into the dev user's home, and a misleading `up` hint.

**Deliverables:**
- `test/disk-done-check.sh` (~line 254): the expected `shell --print` output becomes the
  `sh -c 'command -v zsh … exec zsh || exec bash'` form; it still expects the old `… bash`.
- `cli/src/commands/shell.ts`: `--root` adds `-e HOME=/root` beside `-u root`. The images set
  `ENV HOME=/state/home` and `docker exec -u root` keeps it, so root's first zsh would create
  root-owned `~/.zshrc`, `~/.cache/oh-my-zsh` and `~/.zsh_history` in the dev user's home,
  breaking the dev user's history and `~/.cache`. Update `test/shell.test.ts`, the `--root`
  checks in `test/shell-done-check.sh`, and `cli-spec.md` §6 Shell.
- `cli/src/commands/up.ts`: the hint becomes `$(bardolier shell <name> --print)`;
  `bardolier shell` only prints the command, it does not open a shell.

**Non-goals:** no Dockerfile change; no Swift change.

**Done-check:** `test/shell.test.ts`, `test/shell-done-check.sh`, `test/disk-done-check.sh`
(the last two need Docker). Manual: in a fresh project run `bardolier shell --root` first, then
a plain shell; nothing in `/state/home` should be owned by root.
