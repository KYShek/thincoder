/**
 * repomap-parse.mjs — repo dependency graph parser (zero dependencies, pure regex)
 * Gets known file list from code_chunks, parses each file's import/export relationships in real time,
 * builds forward dependency graph + reverse reference graph. Shared by repomap.mjs's buildSummary / buildOutline.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Scan all files, build forward dependency graph + reverse reference graph.
 * Returns { deps, importers, fileCount } shared by buildOutline / buildSummary.
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

    // Resolve import paths to relative paths (handle ./ ../)
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

// ---------------------------------------------------------- internal implementation

function normalizeExt(p) {
  return p.replace(/\.(m?js|jsx|tsx?)$/i, "")
}

/** Extract JS/TS file import paths (normalize by stripping .ts/.js/.mjs suffixes) */
function parseImports(lines, ext) {
  const imports = []
  const text = lines.join("\n")
  // standard import
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

/** Extract JS/TS file export symbols */
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
  // export { a, b as c } — prefer the "as" alias as the exported name
  const braceRe = /export\s*\{([^}]+)\}/g
  while ((m = braceRe.exec(text))) {
    for (const name of m[1].split(",")) {
      const parts = name.trim().split(/\s+/)
      // "a as b" → b (exported name), "a" → a
      const exported = parts.length >= 3 ? parts[2] : parts[0]
      if (exported) exports.push(exported)
    }
  }
  // export const { a, b } = ... (destructured export)
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

/** Extract Python imports and top-level def/class */
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
 * Python relative import → relative file path:
 * Leading n dots mean go up n-1 levels ("." = current package), module dots become path separators.
 * Non-relative imports (not starting with .) or bare package imports ("from . import x") return null.
 */
function pyRelPath(mod) {
  if (!mod?.startsWith(".")) return null
  const dots = mod.match(/^\.+/)[0].length
  const rest = mod.slice(dots).replaceAll(".", "/")
  if (!rest) return null
  return normalizeExt("../".repeat(dots - 1) + rest)
}
