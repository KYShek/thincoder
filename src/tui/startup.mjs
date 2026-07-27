import { listSlots } from "../session.mjs"
import { sliceByWidth } from "./render.mjs"
import { ansi, C } from "./ansi.mjs"

/** 启动画面 + 会话恢复 + 后台索引。
 *  从 index.mjs 抽出。
 *  ctx: { agent, state, opts, pushLine, pushLabel, render, startWizard } */
export function showStartup(ctx) {
  const { agent, state, opts, pushLine, pushLabel, render, startWizard } = ctx

  // 启动画面
  if (!agent.provider.apiKey) {
    pushLabel(`Welcome to ThinCoder!`, ansi.bold + C.tool)
    pushLine("No API key configured yet — entering initial setup (Esc to skip anytime)", C.text)
    startWizard()
  } else {
    pushLine(`Welcome to ThinCoder. Provider: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
  }
  pushLine(`Tools: ${agent.tools.map((t) => t.name).join(", ")}`, C.dim)

  // 恢复上次会话：重建对话区显示 (tool 结果行省略，保持清爽）
  if (opts.restored?.display?.length) {
    // 用户视角的恢复：display 是退出前对话区的原样快照，所见即所得
    state.lines = [...opts.restored.display.map((l) => ({ text: l.text, color: l.color })), ...state.lines]
    pushLabel(`── Restored previous session; /new for a fresh session ──`, C.warn)
  } else if (opts.restored?.history?.length) {
    // 重建对话区：user/assistant 消息逐条展示，tool 结果行只保留首行摘要
    for (let i = 0; i < opts.restored.history.length; i++) {
      const m = opts.restored.history[i]
      if (m.role === "user") {
        if (typeof m.content === "string" && m.content.startsWith("[System reminder:")) continue
        pushLabel(`❯ You:`, ansi.bold + C.user)
        if (typeof m.content === "string" && m.content) pushLine(m.content, C.text)
      } else if (m.role === "assistant") {
        pushLabel(`❯ ThinCoder:`, ansi.bold + C.assistant)
        if (typeof m.content === "string" && m.content) pushLine(m.content, C.text)
        for (const tc of m.tool_calls ?? []) {
          // 找到下一条对应的 tool 结果，显示首行摘要
          const toolResult = opts.restored.history[i + 1]
          const hasResult = toolResult?.role === "tool" && toolResult?.tool_call_id === tc.id
          const summary = hasResult ? " → " + sliceByWidth(String(toolResult.content).split("\n")[0], 80) : ""
          pushLine(`  [tool] ${tc.function?.name ?? "?"}${summary}`, C.tool)
        }
      }
      // tool 消息本身不单独渲染——已在 assistant 的 tool_calls 后以摘要形式展示
    }
    pushLabel(`── Restored previous session (${opts.restored.history.length} messages); /new for a fresh session ──`, C.warn)
  }

  // 有归档槽位时给个提示
  if (listSlots(agent.cwd).length > 0) {
    pushLine("Tip: archived sessions available — /session to view/switch", C.dim)
  }
  render()
}

/** 后台索引 (进界面后再跑，不阻塞启动）；进度走底部状态栏，不往对话区塞行。
 *  优先用 git diff 增量（快），git 不可用或首次运行时退到全量扫描。 */
export async function backgroundIndex(ctx) {
  const { agent, state, render } = ctx
  const { codeSync, docSync, gitSync } = await import("../memory.mjs")
  const cwd = agent.cwd
  let codeFiles = 0, docFiles = 0

  state.status = "Indexing..."
  render()

  const gitRes = await gitSync(agent.memory, cwd, {
    onProgress: (p) => {
      if (p.phase === "index" && p.current % 5 === 0) {
        state.status = `Indexing... ${p.current}/${p.total}`
        render()
      }
    }
  })

  if (gitRes !== null) {
    // git 增量成功，直接统计
    codeFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM code_chunks`).get()?.n ?? 0
    docFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM doc_chunks`).get()?.n ?? 0
  } else {
    // 退到全量扫描（codeSync 和 docSync 并行——读写不同表，SQLite WAL 天然支持）
    const [codeRes, docRes] = await Promise.allSettled([
      codeSync(agent.memory, cwd, {
        onProgress: (p) => {
          if (p.phase === "index" && p.current % 30 === 0) {
            state.status = `Indexing code... ${p.current}/${p.total}`
            render()
          }
        }
      }),
      docSync(agent.memory, cwd, {
        onProgress: (p) => {
          if (p.phase === "index" && p.current % 10 === 0) {
            state.status = `Indexing docs... ${p.current}/${p.total}`
            render()
          }
        }
      }),
    ])
    if (codeRes.status === "fulfilled") {
      codeFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM code_chunks`).get()?.n ?? 0
    }
    if (docRes.status === "fulfilled") {
      docFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM doc_chunks`).get()?.n ?? 0
    }
  }

  state.status = codeFiles || docFiles
    ? `Ready — idx code ${codeFiles} doc ${docFiles}`
    : "Ready"
  render()
}
