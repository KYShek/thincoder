/**
 * repomap.mjs — 仓库依赖大纲（零依赖，纯 regex）
 * 实时解析 import/export 关系，生成紧凑文本给 LLM 理解代码结构。
 * 不存索引——每次调用读文件解析，~50ms 完成。
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/** 提取 JS/TS 文件的 import 路径（去掉 .ts/.js/.mjs 后缀统一） */
function parseImports(lines, ext) {
  const imports = []
  const text = lines.join("\n")
  // 普通 import
  const re = /import\s+(?:{[^}]*}|\*\s+as\s+\w+|\w+\s*,?\s*(?:{[^}]*})?)\s*from\s*['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(text))) {
    const raw = m[1] || m[2]
    if (!raw || raw.startsWith("node:") || !raw.startsWith(".")) continue
    imports.push(normalizeExt(raw))
  }
  // re-export: export { x } from './module'
  const reExportRe = /export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g
  while ((m = reExportRe.exec(text))) {
    const raw = m[1]
    if (!raw || raw.startsWith("node:") || !raw.startsWith(".")) continue
    imports.push(normalizeExt(raw))
  }
  return [...new Set(imports)]
}

/** 提取 JS/TS 文件的 export 符号 */
function parseExports(lines, ext) {
  const exports = []
  const text = lines.join("\n")
  // export function/class/const/let/var name
  const namedRe = /export\s+(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+))/g
  let m
  while ((m = namedRe.exec(text))) {
    exports.push(m[1] || m[2] || m[3])
  }
  // export default function/class name / export default expression
  const defaultRe = /export\s+default\s+(?:(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+))|(\w+))/g
  while ((m = defaultRe.exec(text))) {
    const name = m[1] || m[2] || m[3]
    if (name) exports.push(name)
    else if (!exports.some((e) => e === "default")) exports.push("default")
  }
  // export { a, b as c } —— 优先取 as 后的导出名
  const braceRe = /export\s*\{([^}]+)\}/g
  while ((m = braceRe.exec(text))) {
    for (const name of m[1].split(",")) {
      const parts = name.trim().split(/\s+/)
      // "a as b" → b（导出名），"a" → a
      const exported = parts.length >= 3 ? parts[2] : parts[0]
      if (exported) exports.push(exported)
    }
  }
  // export const { a, b } = ...（解构导出）
  const destructRe = /export\s+(?:const|let|var)\s*\{([^}]+)\}\s*=/g
  while ((m = destructRe.exec(text))) {
    for (const name of m[1].split(",")) {
      const parts = name.trim().split(/\s*:\s*/)
      const n = parts[0].trim()
      if (n) exports.push(n)
    }
  }
  return [...new Set(exports)]
}

/** 提取 Python 的 import 和顶层 def/class */
function parsePyOutline(lines) {
  const imports = []
  const symbols = []
  for (const line of lines) {
    const fromRe = line.match(/^from\s+(\S+)\s+import\s+(.+)/)
    if (fromRe) {
      const rel = pyRelPath(fromRe[1])
      if (rel) imports.push(rel)
      continue
    }
    const impRe = line.match(/^import\s+(.+)/)
    if (impRe) {
      for (const mod of impRe[1].split(",")) {
        const rel = pyRelPath(mod.trim().split(/\s+/)[0])
        if (rel) imports.push(rel)
      }
      continue
    }
    const defRe = line.match(/^(?:async\s+)?(?:def|class)\s+(\w+)/)
    if (defRe) symbols.push(defRe[1])
  }
  return { imports: [...new Set(imports)], symbols: [...new Set(symbols)] }
}

/**
 * Python 相对导入 → 相对文件路径：
 * 前导 n 个点表示上溯 n-1 层（"."=当前包），模块点号转路径分隔符。
 * 非相对导入（不以 . 开头）或纯包导入（"from . import x"）返回 null。
 */
function pyRelPath(mod) {
  if (!mod?.startsWith(".")) return null
  const dots = mod.match(/^\.+/)[0].length
  const rest = mod.slice(dots).replaceAll(".", "/")
  if (!rest) return null
  return normalizeExt("../".repeat(dots - 1) + rest)
}

function normalizeExt(p) {
  return p.replace(/\.(m?js|jsx|tsx?)$/i, "")
}

/** 从 code_chunks 取已知文件列表（复用索引），按路径解析生成大纲文本 */
export function buildOutline(db, cwd, focusPath) {
  const allFiles = db.prepare(`SELECT DISTINCT path FROM code_chunks ORDER BY path`).all().map((r) => r.path)

  if (allFiles.length === 0) return "(no indexed source files; run codeSync or /reindex first)"

  // 构建正向（谁 import 谁）+ 反向（被谁 import）图——总是全量扫描，
  // 因为聚焦一个文件也需要知道别的文件是否 import 了它
  const deps = new Map()      // path → { imports: Set, exports: Set, size: number }
  const importers = new Map() // importee → Set<importer>

  for (const rel of allFiles) {
    const abs = join(cwd, ...rel.split("/"))
    if (!existsSync(abs)) continue
    const text = readFileSync(abs, "utf8")
    const lines = text.split("\n")
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase()

    let imports, exports
    if (ext === ".py") {
      const py = parsePyOutline(lines)
      imports = py.imports
      exports = py.symbols
    } else {
      imports = parseImports(lines, ext)
      exports = parseExports(lines, ext)
    }

    // 把 import 路径解析成相对路径（处理 ./ ../）
    const resolved = []
    for (let imp of imports) {
      // 去掉 ./ 前缀
      if (imp.startsWith("./")) imp = imp.slice(2)
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""
      const parts = imp.split("/")
      if (parts[0] === "..") {
        const up = dir.split("/").filter(Boolean)
        let i = 0
        while (parts[i] === ".." && up.length > 0) { up.pop(); i++ }
        resolved.push([...up, ...parts.slice(i)].join("/"))
      } else {
        resolved.push(dir ? `${dir}/${imp}` : imp)
      }
    }

    deps.set(rel, { imports: new Set(resolved), exports: new Set(exports), size: Math.floor(text.length / 1024) })

    for (const r of resolved) {
      if (!importers.has(r)) importers.set(r, new Set())
      importers.get(r).add(rel)
    }
  }

  // 生成文本
  const files = focusPath ? [focusPath] : [...deps.keys()]
  const out = []
  const sorted = files.sort()
  for (const rel of sorted) {
    const d = deps.get(rel)
    if (!d) continue
    const parts = []
    // imported by（匹配时去掉扩展名，因为 import 路径通常不含 .mjs/.js 后缀）
    const key = rel.replace(/\.(m?js|jsx|tsx?)$/i, "")
    const rev = importers.get(key)
    if (rev?.size) parts.push(`← imported by: ${[...rev].join(", ")}`)
    // imports
    if (d.imports.size) parts.push(`→ imports: ${[...d.imports].join(", ")}`)
    // exports
    if (d.exports.size) parts.push(`→ exports: ${[...d.exports].join(", ")}`)

    const kb = d.size > 0 ? ` (${d.size} KB)` : ""
    if (parts.length) {
      out.push(`${rel}${kb}\n  ${parts.join("\n  ")}`)
    } else {
      out.push(`${rel}${kb}`)
    }
  }

  return out.join("\n")
}

/**
 * 生成 repo_outline 工具（只读）。
 * 需要 memory.db（复用 code_chunks 文件列表）和 cwd。
 */
export function repoOutlineTool(db, cwd) {
  return {
    name: "repo_outline",
    description:
      "Show the project's file dependency outline: which files import/export from which, and what symbols they export. Use when you need to understand the project structure, find where a function is defined, or see what files depend on a module. Pass a path to focus on a single file's relationships.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional: focus on a specific file path (relative to project root)" },
      },
      required: [],
    },
    readonly: true,
    async execute(args) {
      const outline = buildOutline(db, cwd, args.path ?? null)
      return outline
    },
  }
}
