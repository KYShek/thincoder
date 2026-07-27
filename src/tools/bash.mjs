import {
  DESC,
  sanitizeOutput,
  truncate,
  makeDecoder,
  BASH_TIMEOUT_MS,
  hasFileRedirection,
  shellSegments,
  isDestructiveGitSegment,
  isDestructiveCommand,
  insideGitRepo,
} from "./shared.mjs"
import { spawn, execFileSync } from "node:child_process"

/** 子进程环境变量白名单：只透传安全变量，隔离 API key 等敏感信息 */
const SAFE_ENV_KEYS = new Set([
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL",
  "ComSpec", "PATHEXT", "SystemRoot", "windir",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "PYTHONIOENCODING", "GIT_EDITOR", "EDITOR", "VISUAL",
  "GIT_PAGER", "PAGER", "TERM",
])

export const bashTool = {
  name: "bash",
  description: DESC("bash"),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: `Timeout in ms (default ${BASH_TIMEOUT_MS})` },
    },
    required: ["command"],
  },
  readonly: false,
  sideEffectExempt: true, // may-or-may-not-write: scope of file modification is opaque to agent loop
  async execute(args, ctx) {
    // 安全预检：禁止 shell 重定向（> >> <）——应改用 write/edit/insert_after 工具
    if (hasFileRedirection(args.command)) {
      throw new Error("File redirection via bash is not allowed — use the write/edit/insert_after tools instead")
    }
    // 安全预检：破坏性非 git 命令（rm -rf / DROP TABLE 等）直接拒绝
    if (shellSegments(args.command).some(isDestructiveCommand)) {
      throw new Error("Destructive command blocked — use specific tools or confirm with the user first. (If work was already destroyed, recover from auto-snapshot: checkpoint action=list then action=rewind.)")
    }
    // 安全预检：销毁性 git 操作先检查未提交改动，有则拒绝——防一键清掉几小时工作
    if (shellSegments(args.command).some(isDestructiveGitSegment)) {
      if (!insideGitRepo(ctx.cwd)) {
        throw new Error(`Refusing destructive git command: not a git repository: ${ctx.cwd}`)
      }
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      if (status) {
        throw new Error(
          `Refusing destructive git command: uncommitted changes exist. Commit or stash first.\n` +
          `(If uncommitted work was already lost, the checkpoint tool can restore the auto-snapshot: action=list, then action=rewind.)\n\n${status}`
        )
      }
    }

    return new Promise((resolve) => {
      // detached: 让子进程成为进程组组长，超时/中断时才能整树杀掉（POSIX 用负 pid 组杀，
      // Windows 用 taskkill /T）——只 kill 壳进程会把孙进程（如 npm test）留在后台继续跑。
      // Windows 上 detached 必须为 false：detached:true 在 cmd.exe spawn 时无实际效果，
      // taskkill /T 已覆盖进程树清理，且部分场景下 detached 会阻止 taskkill 遍历子进程。
      const killTree = () => {
        if (process.platform === "win32") {
          try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }) } catch {}
        } else {
          try { process.kill(-child.pid, "SIGKILL") } catch {}
          try { child.kill("SIGKILL") } catch {} // 组杀失败时兜底杀本体
        }
      }
      // Windows 中文系统默认代码页是 GBK (CP936)，cmd.exe 重定向写文件时用 ANSI 代码页，
      // chcp 65001 也改不了重定向的编码。bash 工具写含 CJK 的文件会产生 GBK——
      // 提示词层已禁止用 bash 写文件（用 write/edit 工具替代），这里设 PYTHONIOENCODING
      // 覆盖 Python 脚本的 stdout 编码（Python 是唯一可能正确响应环境变量的子进程）
      const winCmd = process.platform === "win32"
      const child = spawn(args.command, {
        cwd: ctx.cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) => SAFE_ENV_KEYS.has(k))
          ),
          GIT_EDITOR: "true",
          EDITOR: "true",
          VISUAL: "true",
          GIT_PAGER: "cat",
          PAGER: "cat",
          TERM: "dumb",
          ...(winCmd ? { PYTHONIOENCODING: "utf-8" } : {}),
        },
      })
      // stdout / stderr 各自独立解码（同进程通常同编码，但分开收集更干净，
      // 且允许模型按 stderr 快速定位错误）
      const outDecoder = makeDecoder()
      const errDecoder = makeDecoder()
      let outBuf = ""
      let errBuf = ""
      let truncatedNote = ""

      const onStdout = (d) => {
        const s = sanitizeOutput(outDecoder(d))
        if (s) {
          ctx.onOutput?.(s)
          if (outBuf.length < 2_000_000) outBuf += s
          else if (!truncatedNote) truncatedNote = "\n[... output exceeded 2MB, remainder discarded]"
        }
      }
      const onStderr = (d) => {
        const s = sanitizeOutput(errDecoder(d)) // 始终解码，防 pending 无限累积
        if (errBuf.length < 2_000_000) errBuf += s
      }

      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)

      const timer = setTimeout(killTree, args.timeout ?? BASH_TIMEOUT_MS)
      if (ctx.signal) {
        ctx.signal.addEventListener("abort", killTree, { once: true })
      }
      child.on("error", (error) => {
        clearTimeout(timer)
        resolve(truncate(`Command failed: ${error.message}\n[stdout]:\n${outBuf || "(empty)"}`))
      })
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        // 冲刷解码器尾部
        outBuf += sanitizeOutput(outDecoder(Buffer.alloc(0), true))
        errBuf += sanitizeOutput(errDecoder(Buffer.alloc(0), true))
        const status = signal
          ? `killed: ${ctx.signal?.aborted ? "user interrupted" : "timeout"}`
          : `exit code ${code}`
        const parts = [`[stdout]:\n${outBuf.trim() || "(empty)"}`]
        if (errBuf.trim()) parts.push(`[stderr]:\n${errBuf.trim()}`)
        parts.push(`(${status})`)
        resolve(truncate(parts.join("\n\n") + truncatedNote))
      })
    })
  },
}
