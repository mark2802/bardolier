# Phase specs

One small scoped spec per unit of work, in landing order. Each describes the
plan as it stood when written — later phases sometimes supersede earlier ones,
and that supersession is left visible rather than edited away; `INTENT.md`
and `../retrospective.md` are where the corrected picture lives.

**Done-check paths are historical.** Phases up to and including 19 name a
per-phase test file (`test/phaseN-done-check.sh`, `test/phaseN.test.ts`,
`regression.sh`'s `LAST=N`). That ladder was replaced by function-named checks
(`c8f3304`, `b84af2c`, `e63c648`): a suite or done-check is now named for what
it covers, and `test/regression.sh` runs all of them, cheapest first, with no
ladder and no `--through`. See `test/` for what a phase's check actually landed
as.
