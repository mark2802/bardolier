# Phase 37 — oh-my-zsh as the default shell

**Goal:** `bardolier shell` lands in zsh with oh-my-zsh in every base image.

**Deliverables:**
- All three `cli/images/*/Dockerfile`: `zsh`; oh-my-zsh at a pinned commit + sha256 under
  `/usr/local/share` (`$HOME` is a bind mount); global `/etc/zsh/zshrc` (no auto-update, history
  and cache in `$HOME`); `/etc/zsh/zshenv` touches `~/.zshrc` to skip the first-run menu;
  `useradd -s /bin/zsh`.
- `cli/src/commands/shell.ts`: argv `sh -c 'command -v zsh … exec zsh || exec bash'` (an
  un-rebuilt image still gets bash); `--print` quotes words so the line pastes. `up`'s hint
  prints the same `docker exec … sh -c '…'` line as `shell --print`.
- `cli-spec.md` §4.3, §6 Shell.

**Non-goals:** no image-staleness detection; no Swift change (the app quotes each argv word).

**Done-check:** `test/shell.test.ts`, `test/shell-done-check.sh` (needs Docker; unrun when written).
