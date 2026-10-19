# Phase 40 — follow-ups from the phase 36–39 post-merge review

**Goal:** fix what phases 36–39 (PRs #4–#7, merged through cross-merged branches) left behind:
`--root` writing into the dev user's home, an `up` hint that lands in a different directory than
`shell`, spec text that phases 39 promised but never wrote, and untested zsh/Playwright claims.

**Deliverables:**
- `cli/src/commands/shell.ts`: `--root` adds `-e HOME=/root` beside `-u root`. The images set
  `ENV HOME=/state/home` and `docker exec -u root` keeps it, so root's first zsh would create
  root-owned `~/.zshrc`, `~/.cache/oh-my-zsh` and `~/.zsh_history` in the dev user's home,
  breaking the dev user's history and `~/.cache`. Update `test/shell.test.ts`, the `--root`
  checks in `test/shell-done-check.sh`, and `cli-spec.md` §6 Shell.
- `cli/src/commands/up.ts`: the hint (a plain `docker exec … sh -c '…'` line since fab40d3) omits
  `-w /work/<work_folder>`, which `shell` adds, so the two land in different directories. Add
  it (reuse `runShell`'s workdir logic) and say in the hint that `bardolier shell` only prints.
  Do not use `$(bardolier shell --print)`: word-splitting breaks the quoted `sh -c` script.
- `cli-spec.md`: §9 `$HOME` documents `home/.claude/settings.json` and the `attribution` default
  (phase 39 listed §9; only §6 `up` points to it); §6 `delete` notes the unedited default does not
  count as data (`layout.ts` `holdsData`).
- `37-zsh-shell.md`: its line that `up`'s hint says `bardolier shell <name>` is wrong; fix it.
- Tests:
  - `test/shell.test.ts`: `quoted` / `renderShellPrint` / the `up` hint, including a word containing `'`.
  - `test/lifecycle.test.ts`: web and library `env.md` list `Playwright (Chromium only)` (phase 38
    named this check; none exists).
  - `test/images-done-check.sh`: zsh really starts for the dev user, with oh-my-zsh loaded, no
    first-run menu, `~/.zshrc` created and `compaudit` silent. Today only argv strings are compared.

**Non-goals:** no Dockerfile change beyond adding `xauth` (headed Chromium's `xvfb-run` needs it; found by the first real run of phase 38's check); no Swift change (`BardolierTerminal.swift` quotes each argv word).

**Done-check:** `npm run test:quiet`; `test/shell-done-check.sh`, `test/disk-done-check.sh` and
`test/images-done-check.sh` (full, no `IMAGES_QUICK`), which need Docker. Phases 37 and 38 shipped
their Docker checks unrun, so this is their first real run. Manual: in a fresh project run
`bardolier shell --root` first, then a plain shell; nothing in `/state/home` should be owned by root.
