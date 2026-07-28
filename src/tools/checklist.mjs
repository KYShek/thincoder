import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { DESC } from "./shared.mjs"

const CHECKLIST = "checklist.md"
const DONE = "checklist-done.md"

function checklistPath(cwd) { return join(cwd, ".thincoder", CHECKLIST) }
function donePath(cwd) { return join(cwd, ".thincoder", DONE) }

/** Parse checklist file into array of { index, status, text } */
function parse(filePath) {
  if (!existsSync(filePath)) return []
  const lines = readFileSync(filePath, "utf-8").split("\n")
  const items = []
  let idx = 0
  for (const line of lines) {
    const m = line.match(/^- \[(.)\] (.+)$/)
    if (m) {
      idx++
      const raw = m[1]
      const status = raw === "x" ? "done" : raw === "~" ? "in_progress" : "pending"
      items.push({ index: idx, status, text: m[2].trim() })
    }
  }
  return items
}

/** Write items back to file */
function write(filePath, items) {
  mkdirSync(dirname(filePath), { recursive: true })
  const lines = []
  for (const item of items) {
    const mark = item.status === "done" ? "x" : item.status === "in_progress" ? "~" : " "
    lines.push(`- [${mark}] ${item.text}`)
  }
  writeFileSync(filePath, lines.join("\n") + "\n")
}

/** Parse pending items only (for context injection) */
export function pendingItems(cwd) {
  return parse(checklistPath(cwd)).filter(i => i.status !== "done")
}

export const checklistTool = {
  name: "checklist",
  description: DESC("checklist"),
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "mark", "list"],
        description: "add a new item / mark item status / list all items"
      },
      item: {
        type: "string",
        description: "Item text (required for add)"
      },
      index: {
        type: "number",
        description: "1-based item index (required for mark)"
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "done"],
        description: "New status (required for mark)"
      },
    },
    required: ["action"],
  },
  readonly: false,
  execute(args, ctx) {
    switch (args.action) {
      case "add": {
        if (!args.item || typeof args.item !== "string") return "Error: 'item' is required for add"
        const items = parse(checklistPath(ctx.cwd))
        items.push({ index: items.length + 1, status: "pending", text: args.item })
        write(checklistPath(ctx.cwd), items)
        return `Added: [ ] ${args.item}`
      }
      case "mark": {
        if (args.index == null) return "Error: 'index' is required for mark"
        const status = args.status
        if (!status || !["pending", "in_progress", "done"].includes(status)) return "Error: 'status' is required (pending|in_progress|done)"
        const cp = checklistPath(ctx.cwd)
        const items = parse(cp)
        if (args.index < 1 || args.index > items.length) return `Error: index ${args.index} out of range (1-${items.length})`
        const item = items[args.index - 1]
        const old = item.status
        if (old === status) return `Already ${status}: ${item.text}`
        item.status = status
        if (status === "done") {
          // Move to done file
          const dp = donePath(ctx.cwd)
          const doneItems = parse(dp)
          doneItems.push(item)
          write(dp, doneItems)
          items.splice(args.index - 1, 1)
        }
        write(cp, items)
        return `Marked #${args.index} ${old} → ${status}: ${item.text}`
      }
      case "list": {
        const items = parse(checklistPath(ctx.cwd))
        if (items.length === 0) return "(checklist is empty)"
        const marks = { pending: " ", in_progress: "~", done: "x" }
        return items.map(i => `- [${marks[i.status]}] ${i.text}`).join("\n")
      }
      default:
        return `Error: unknown action '${args.action}'`
    }
  },
}
