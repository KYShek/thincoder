import { DESC, truncate, resolveInCwd, globToRegex, IGNORED_DIRS } from "./shared.mjs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

export const globTool = {
  name: "glob",
  description: DESC("glob"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search in (default cwd)" },
    },
    required: ["pattern"],
  },
  readonly: true,
  async execute(args, ctx) {
    const base = resolveInCwd(ctx, args.path ?? ".")
    const regex = globToRegex(args.pattern)
    const results = []
    for await (const relPath of walkFiles(base)) {
      if (regex.test(relPath)) {
        results.push(relPath)
        if (results.length >= 1000) break
      }
    }
    if (results.length === 0) return "(no matches)"
    return truncate(results.sort().join("\n"))
  },
}

// ---------------------------------------------------------- 内部实现

/** 递归遍历文件，产出相对路径（跳过 IGNORED_DIRS） */
async function* walkFiles(dir, rel = "") {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      yield* walkFiles(join(dir, e.name), relPath)
    } else {
      yield relPath
    }
  }
}
