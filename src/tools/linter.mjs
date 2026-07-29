import { DESC, resolveInCwd } from "./shared.mjs"

export const linterTool = {
  name: "linter",
  description: DESC("linter"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (default: most recently modified file)" },
    },
  },
  readonly: true,
  async execute(args, ctx) {
    const { execFileSync } = await import("node:child_process")
    const { existsSync } = await import("node:fs")
    const { join, relative } = await import("node:path")
    const abs = args.path ? resolveInCwd(ctx, args.path) : (ctx.agent?._touchedFiles?.at(-1) || null)
    if (!abs) return "linter: no file specified and no recently modified file to check"

    const ext = abs.split(".").pop()?.toLowerCase()
    const checkers = LANG_CHECKERS[ext]
    if (!checkers) return `linter: no linter configured for .${ext} files. Supported: ${Object.keys(LANG_CHECKERS).map(e => `.${e}`).join(", ")}`

    for (const checker of checkers) {
      const result = await checker(abs, { cwd: ctx.cwd, existsSync, execFileSync, join, relative })
      if (result !== null) return result
    }
    return `linter: no linter available for ${args.path || abs}. Install one?`
  },
}

// ─── Checker definitions ──────────────────────

async function eslintCheck(file, { cwd, existsSync, execFileSync, join, relative }) {
  // Walk up to find eslint config
  let dir = file.split(/[\\/]/).slice(0, -1).join("/") || "."
  while (true) {
    for (const cfg of [".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yaml", ".eslintrc.yml", "eslint.config.js", "eslint.config.mjs"]) {
      if (existsSync(join(cwd, dir, cfg))) {
        try {
          const cfgDir = join(cwd, dir)
          const relPath = relative(cfgDir, file)
          execFileSync("npx", ["eslint", "--no-color", "--format", "compact", relPath], {
            cwd: cfgDir, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
          })
          return "✓ eslint: no issues"
        } catch (e) {
          const stdout = (e.stdout || "").trim()
          if (stdout) return stdout
          return `✗ eslint: ${(e.stderr || e.message).slice(0, 500)}`
        }
      }
    }
    const parent = dir.split("/").slice(0, -1).join("/")
    if (!parent || parent === dir) break
    dir = parent
  }
  return null
}

async function tscCheck(file, { cwd, existsSync, execFileSync, join }) {
  if (!existsSync(join(cwd, "tsconfig.json"))) return null
  if (!/\.(ts|tsx|mts|cts)$/.test(file)) return null
  try {
    execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
    })
    return "✓ tsc: no type errors"
  } catch (e) {
    const stdout = (e.stdout || "").trim()
    if (stdout) return stdout
    return `✗ tsc: ${(e.stderr || e.message).slice(0, 500)}`
  }
}

async function nodeCheck(file, { execFileSync, cwd }) {
  if (!/\.(m?js|cjs)$/.test(file)) return null
  try {
    execFileSync(process.execPath, ["--check", file], {
      cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    })
    return "✓ node --check: Syntax OK"
  } catch (e) {
    return `✗ node --check: ${(e.stderr || e.message).slice(0, 500)}`
  }
}

async function ruffCheck(file, { cwd, execFileSync }) {
  if (!/\.py$/.test(file)) return null
  try {
    execFileSync("ruff", ["check", "--output-format", "concise", file], {
      cwd, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    })
    return "✓ ruff: no issues"
  } catch (e) {
    if (e.code === "ENOENT") return "linter: ruff not installed. Run: pip install ruff"
    const stdout = (e.stdout || "").trim()
    if (stdout) return stdout
    return `✗ ruff: ${(e.stderr || e.message).slice(0, 500)}`
  }
}

async function cargoCheck(file, { cwd, existsSync, execFileSync, join }) {
  if (!/\.rs$/.test(file)) return null
  if (!existsSync(join(cwd, "Cargo.toml"))) return null
  const fname = file.split(/[\\/]/).pop()
  try {
    const out = execFileSync("cargo", ["check", "--message-format", "short"], {
      cwd, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
    })
    const errors = out.split("\n").filter(l => l.includes(fname))
    return errors.length > 0 ? errors.join("\n") : "✓ cargo check: no errors"
  } catch (e) {
    const combined = ((e.stdout || "") + "\n" + (e.stderr || "")).trim()
    const errors = combined.split("\n").filter(l => l.includes(fname) || l.startsWith("error"))
    return errors.length > 0 ? errors.join("\n") : `✗ cargo check failed:\n${combined.slice(0, 1000)}`
  }
}

async function goVet(file, { cwd, execFileSync }) {
  if (!/\.go$/.test(file)) return null
  try {
    execFileSync("go", ["vet", file], {
      cwd, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
    })
    return "✓ go vet: no issues"
  } catch (e) {
    return `✗ go vet: ${(e.stderr || e.message).slice(0, 500)}`
  }
}

// ─── Language → checkers (first available wins) ──

const LANG_CHECKERS = {
  js:  [eslintCheck, nodeCheck],
  mjs: [eslintCheck, nodeCheck],
  cjs: [eslintCheck, nodeCheck],
  jsx: [eslintCheck, nodeCheck],
  ts:  [eslintCheck, tscCheck],
  tsx: [eslintCheck, tscCheck],
  mts: [eslintCheck, tscCheck],
  cts: [eslintCheck, tscCheck],
  py:  [ruffCheck],
  rs:  [cargoCheck],
  go:  [goVet],
}
