/**
 * repomap-parse.mjs — 仓库依赖图解析（零依赖，纯 regex）
 * 从 code_chunks 取已知文件列表，实时解析每个文件的 import/export 关系，
 * 构建正向依赖图 + 反向引用图。被 repomap.mjs 的 buildSummary / buildOutline 共用。
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * 扫描全量文件，构建正向依赖图 + 反向引用图。
 * 返回 { deps, importers, fileCount } 供 buildOutline / buildSummary 共用。
 */
export function buildDepGraph(db, cwd) {
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

// ---------------------------------------------------------- 内部实现

function normalizeExt(p) {
  return p.replace(/\.(m?js|jsx|tsx?)$/i, "")
}

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
