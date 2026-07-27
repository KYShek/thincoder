#!/usr/bin/env node
// Thin shim — npm's "bin" field doesn't accept .mjs entries.
// Delegates to the real entry point.
import "./thincoder.mjs"
