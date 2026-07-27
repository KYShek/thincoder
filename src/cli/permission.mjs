import { createInterface } from "node:readline"

/** CLI 版工具参数摘要（截断长 JSON） */
export function summarize(toolArgs) {
  const s = JSON.stringify(toolArgs)
  return s.length > 120 ? s.slice(0, 120) + "..." : s
}

/** 权限请求的关键信息（按工具定制），与 TUI 的 formatPermission 对齐。name 可能带子 agent 前缀（"coder/bash"），取基名匹配 */
export function formatPermission(name, args) {
  const cap = (s, n = 1000) => (s.length > n ? `${s.slice(0, n)}…(共 ${s.length} 字符)` : s)
  const base = name.includes("/") ? name.split("/").pop() : name
  if (base === "bash") return cap(args.command ?? "")
  if (base === "write") return `${args.path}（写入 ${(args.content ?? "").length} 字符）\n${cap(args.content ?? "", 1000)}`
  if (base === "edit") {
    const oldLines = cap(args.old_string ?? "", 500).split("\n").map((l) => `- ${l}`).join("\n")
    const newLines = cap(args.new_string ?? "", 500).split("\n").map((l) => `+ ${l}`).join("\n")
    return `${args.path}\n${oldLines}\n  ↓\n${newLines}`
  }
  if (base === "delete") return `${args.path}${args.force ? "（force：跟踪文件也删）" : ""}`
  if (base === "subagent") return cap(args.task ?? "", 500)
  if (base === "memory_put") return `[${args.type ?? ""}] ${args.title ?? ""}\n${cap(args.content ?? "", 500)}`
  return cap(summarize(args), 300)
}

/** 权限确认：TTY 下交互询问 y/n；非交互环境默认拒绝（安全优先） */
export async function askPermission(name, toolArgs) {
  if (!process.stdin.isTTY) {
    console.error(`\n[deny] ${name} (non-interactive, side-effect tools require a TTY)`)
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise((resolve) => {
      rl.question(`\n[allow?] ${name}\n${formatPermission(name, toolArgs)}\n(y/N) `, resolve)
    })
    return answer.trim().toLowerCase() === "y"
  } finally {
    rl.close()
  }
}
