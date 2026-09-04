#!/usr/bin/env node
// Thin shim. Node ≥22.18 strips TypeScript types natively, so `bardolier` runs
// straight from source with no build step — see CLAUDE.md § Toolchain.
import '../src/main.ts'
