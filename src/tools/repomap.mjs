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

/**
 * 内部：扫描全量文件，构建正向依赖图 + 反向引用图。
 * 返回 { deps, importers, fileCount } 供 buildOutline / buildSummary 共用。
 */
function _buildDepGraph(db, cwd) {
  const allFiles = db.prepare(`SELECT DISTINCT path FROM code_chunks ORDER BY path`).all().map((r) => r.path)
  if (allFiles.length === 0) return null

  const deps = new Map()      // path → { imports: Set, exports: Set, size: number, dir: string }
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

    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "."
    deps.set(rel, { imports: new Set(resolved), exports: new Set(exports), size: Math.floor(text.length / 1024), dir })

    for (const r of resolved) {
      if (!importers.has(r)) importers.set(r, new Set())
      importers.get(r).add(rel)
    }
  }

  return { deps, importers, fileCount: allFiles.length }
}

/**
 * 生成紧凑架构摘要（替换旧的全量注入）。
 * 三层信息，每层信息密度递减：
 *  1. 目录级依赖（多目录项目才有意义，单目录跳过）
 *  2. 枢纽文件 Top-12（被 import 最多的文件——架构骨架）
 *  3. 入口文件（无人 import 的文件——启动/顶层入口）
 * 输出天然有界（~1000-2000 字符），不再需要 OUTLINE_INJECT_MAX 硬截断。
 */
export function buildSummary(db, cwd) {
  const graph = _buildDepGraph(db, cwd)
  if (!graph) return "(no indexed source files; run codeSync or /reindex first)"
  const { deps, importers, fileCount } = graph

  const out = []
  out.push(`${fileCount} source files indexed.`)

  // 1) 目录级依赖
  const dirDeps = new Map() // dir → Set<imported-dir>
  const dirSet = new Set()
  for (const [rel, d] of deps) {
    dirSet.add(d.dir)
    if (!dirDeps.has(d.dir)) dirDeps.set(d.dir, new Set())
    for (const imp of d.imports) {
      const targetDir = imp.includes("/") ? imp.slice(0, imp.lastIndexOf("/")) : "."
      if (targetDir !== d.dir) dirDeps.get(d.dir).add(targetDir)
    }
  }
  if (dirSet.size > 1) {
    out.push("Directory dependencies:")
    for (const dir of [...dirSet].sort()) {
      const targets = dirDeps.get(dir)
      if (targets?.size) {
        out.push(`  ${dir}/ → ${[...targets].sort().join(", ")}/`)
      } else {
        out.push(`  ${dir}/ (leaf)`)
      }
    }
  }

  // 2) 枢纽文件 Top-12：按被 import 次数降序
  const HUB_LIMIT = 12
  const hubScores = []
  for (const [rel] of deps) {
    const key = rel.replace(/\.(m?js|jsx|tsx?)$/i, "")
    const rev = importers.get(key)
    if (rev?.size) hubScores.push({ path: rel, count: rev.size })
  }
  hubScores.sort((a, b) => b.count - a.count)
  if (hubScores.length > 0) {
    out.push(`Hub files (by inbound dependencies, top ${Math.min(hubScores.length, HUB_LIMIT)}):`)
    for (const h of hubScores.slice(0, HUB_LIMIT)) {
      const d = deps.get(h.path)
      const kb = d?.size ? ` (${d.size} KB)` : ""
      const key = h.path.replace(/\.(m?js|jsx|tsx?)$/i, "")
      const rev = importers.get(key)
      const shortRefs = rev.size <= 5
        ? [...rev].join(", ")
        : [...rev].slice(0, 4).join(", ") + ` +${rev.size - 4} more`
      out.push(`  ${h.path}${kb} — imported by: ${shortRefs}`)
    }
  }

  // 3) 入口文件：无人 import 的（叶子/入口）
  const entries = []
  for (const [rel] of deps) {
    const key = rel.replace(/\.(m?js|jsx|tsx?)$/i, "")
    if (!importers.has(key) || importers.get(key).size === 0) {
      entries.push(rel)
    }
  }
  if (entries.length > 0 && entries.length < fileCount) {
    const limit = 8
    const shown = entries.slice(0, limit)
    out.push(`Entry points (not imported by others):`)
    for (const e of shown) out.push(`  ${e}`)
    if (entries.length > limit) out.push(`  ... +${entries.length - limit} more`)
  }

  out.push("For detailed per-file relationships, call repo_outline with a file path.")
  return out.join("\n")
}

/** 从 code_chunks 取已知文件列表（复用索引），按路径解析生成大纲文本 */
export function buildOutline(db, cwd, focusPath) {
  const graph = _buildDepGraph(db, cwd)
  if (!graph) return "(no indexed source files; run codeSync or /reindex first)"
  const { deps, importers } = graph

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
