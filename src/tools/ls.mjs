import { DESC, truncate, resolveInCwd } from "./shared.mjs"
import { readdir } from "node:fs/promises"
import { stat } from "node:fs/promises"
import { join } from "node:path"

export const lsTool = {
  name: "ls",
  description: DESC("ls"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default cwd)" },
    },
  },
  readonly: true,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path ?? ".")
    const entries = await readdir(abs, { withFileTypes: true })
    const rows = await Promise.all(
      entries.slice(0, 500).map(async (e) => {
        const s = await stat(join(abs, e.name)).catch(() => null)
        const isDir = e.isDirectory()
        return {
          dir: isDir,
          name: e.name + (isDir ? "/" : ""),
          size: s?.size ?? 0,
          mtime: s ? s.mtime.toISOString().slice(0, 16).replace("T", " ") : "?",
        }
      }),
    )
    rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    if (rows.length === 0) return "(empty directory)"
    const out = rows.map((r) => `${r.dir ? "d" : "-"}  ${r.name.padEnd(40)} ${String(r.size).padStart(10)}  ${r.mtime}`)
    return truncate(out.join("\n"))
  },
}
