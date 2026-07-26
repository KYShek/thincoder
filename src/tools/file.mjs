import {
  DESC,
  truncate,
  MAX_READ_LINES,
  gitDiffOne,
  autoSyntaxCheck,
  resolveInCwd
} from "./shared.mjs";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { join, relative, dirname } from "node:path";

export const readTool = {
  name: "read",
  description: DESC("read"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to cwd or absolute)" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: `Max lines to return (default ${MAX_READ_LINES})` },
    },
    required: ["path"],
  },
  readonly: true,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    // 大文件保护：先查大小，超 10MB 拒绝整文件读入（offset/limit 只影响返回切片，不影响缓冲）
    const st = await stat(abs).catch(() => null)
    if (st && st.size > 10_000_000) throw new Error(`File too large (${Math.round(st.size / 1_000_000)}MB > 10MB limit). Use bash with head/tail or grep for targeted extraction.`)
    const content = await readFile(abs, "utf8")
    const lines = content.split("\n")
    const offset = Math.max(1, args.offset ?? 1)
    const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n")
    const suffix = offset - 1 + limit < lines.length ? `\n... (${lines.length} lines total, use offset to continue)` : ""
    return truncate(numbered + suffix)
  },
}

// ---------------------------------------------------------------- read_image

const IMAGE_EXTENSIONS = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" }

export const readImageTool = {
  name: "read_image",
  description: DESC("read_image"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to image file (relative to cwd or absolute). Supports png, jpg, gif, webp, bmp, svg." },
    },
    required: ["path"],
  },
  readonly: true,
  /** 返回 JSON：{ text, images }，供 agent 层转为多模态 user 消息 */
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase()
    const mime = IMAGE_EXTENSIONS[ext]
    if (!mime) throw new Error(`Unsupported image format: .${ext}. Supported: ${Object.keys(IMAGE_EXTENSIONS).join(", ")}`)
    // 先查大小再读入——防超大图片撑爆内存（20MB base64 ≈ 15MB 原始）
    const imgStat = await stat(abs).catch(() => null)
    if (imgStat && imgStat.size > 15_000_000) throw new Error(`Image too large: ${Math.round(imgStat.size / 1_000_000)}MB (max 15MB)`)
    const buf = await readFile(abs) // raw buffer, no encoding
    const b64 = buf.toString("base64")
    const bytes = buf.length
    const result = JSON.stringify({
      text: `[read_image: ${args.path} (${mime}, ${bytes} bytes)]`,
      images: [{ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }],
    })
    // 粘贴产生的临时文件用完即删，不留垃圾
    const basename = abs.includes("/") ? abs.slice(abs.lastIndexOf("/") + 1) : abs.slice(abs.lastIndexOf("\\") + 1)
    if (basename.startsWith(".thincoder-paste-")) {
      try { await unlink(abs) } catch { /* 删不掉就算了 */ }
    }
    return result
  },
}

// ---------------------------------------------------------------- write

export const writeTool = {
  name: "write",
  description: DESC("write"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to cwd or absolute)" },
      content: { type: "string", description: "Full content to write" },
    },
    required: ["path", "content"],
  },
  readonly: false,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    await mkdir(dirname(abs), { recursive: true })
    const st = await stat(abs).catch(() => null)
    if (st?.isDirectory()) throw new Error(`Path is a directory: ${args.path}`)
    await writeFile(abs, args.content, "utf8")
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Wrote ${args.content.length} chars to ${args.path}${diff ? "\n" + diff : ""}${autoSyntaxCheck(abs)}`
  },
}

// ---------------------------------------------------------------- edit

export const editTool = {
  name: "edit",
  description: DESC("edit"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  readonly: false,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    if (!args.old_string) {
      throw new Error("old_string must not be empty (empty string matches everywhere and would corrupt the file)")
    }
    const content = await readFile(abs, "utf8")
    const occurrences = content.split(args.old_string).length - 1
    if (occurrences === 0) {
      // 给出线索帮模型定位：首行预览 + 常见原因
      const preview = args.old_string.slice(0, 100).split("\n")[0]
      throw new Error(
        `old_string not found in ${args.path}\n` +
        `  searched: "${preview}${args.old_string.length > 100 ? "…" : ""}"\n` +
        `  hints: whitespace mismatch? file already changed? try reading the file first`
      )
    }
    if (occurrences > 1 && !args.replace_all) {
      throw new Error(`old_string matches ${occurrences} times in ${args.path}; provide more context or set replace_all`)
    }
    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      // 函数式替换：避免 new_string 里的 $ 替换模式（匹配串/前后文引用）被展开
      : content.replace(args.old_string, () => args.new_string)
    await writeFile(abs, updated, "utf8")
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Edited ${args.path}: replaced ${args.replace_all ? occurrences : 1} occurrence(s)${diff ? "\n" + diff : ""}${autoSyntaxCheck(abs)}`
  },
}

// ---------------------------------------------------------------- insert_after

export const insertAfterTool = {
  name: "insert_after",
  description: DESC("insert_after"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      after_line: { type: "number", description: "Line number to insert after (1-based). Takes priority over after_regex." },
      after_regex: { type: "string", description: "JavaScript regex to find the line to insert after (must match exactly one line)" },
      content: { type: "string", description: "Text to insert (with leading newline if you need a blank line)" },
    },
    required: ["path", "content"],
  },
  readonly: false,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    const text = await readFile(abs, "utf8")
    const lines = text.split("\n")

    let targetLine
    if (args.after_line != null) {
      targetLine = args.after_line
      if (!Number.isInteger(targetLine)) {
        throw new Error(`after_line must be an integer, got: ${args.after_line}`)
      }
      if (targetLine < 1 || targetLine > lines.length) {
        throw new Error(`after_line ${targetLine} out of range (file has ${lines.length} lines)`)
      }
    } else if (args.after_regex) {
      const regex = new RegExp(args.after_regex)
      const matches = []
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) matches.push(i + 1)
      }
      if (matches.length === 0) throw new Error(`after_regex /${args.after_regex}/ matched no lines in ${args.path}`)
      if (matches.length > 1) throw new Error(`after_regex /${args.after_regex}/ matched ${matches.length} lines (${matches.slice(0, 5).join(", ")}${matches.length > 5 ? "…" : ""}); use a more specific pattern or after_line instead`)
      targetLine = matches[0]
    } else {
      throw new Error("Either after_line or after_regex is required")
    }

    lines.splice(targetLine, 0, args.content)
    const updated = lines.join("\n")
    await writeFile(abs, updated, "utf8")
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Inserted after line ${targetLine} in ${args.path}${diff ? "\n" + diff : ""}${autoSyntaxCheck(abs)}`
  },
}

