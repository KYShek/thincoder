import { ansi, C } from "./ansi.mjs"

/** 交互原语：权限审批 + 问答输入。
 *  从 index.mjs 抽出，通过 createInteraction(ctx) 接收闭包依赖。
 *  ctx: { agent, state, pushLine, pushLabel, render, summarize } */
export function createInteraction(ctx) {
  const { agent, state, pushLine, pushLabel, render, summarize } = ctx

  /** 权限请求的关键信息 (按工具定制），返回行数组。name 可能带子 agent 前缀 ("coder/bash"），取基名匹配 */
  function formatPermission(name, args) {
    const cap = (s, n = 1000) => (s.length > n ? `${s.slice(0, n)}…(${s.length} chars total)` : s)
    const base = name.includes("/") ? name.split("/").pop() : name
    if (base === "bash") return cap(args.command ?? "").split("\n")
    if (base === "write") {
      // 批准写文件必须看得到要写什么：路径 + 内容预览
      return [`${args.path} (write ${(args.content ?? "").length} chars)`, ...cap(args.content ?? "", 1000).split("\n")]
    }
    if (base === "edit") {
      // 简易 diff：- 旧内容 / + 新内容
      return [
        `${args.path}`,
        ...cap(args.old_string ?? "", 500).split("\n").map((l) => `- ${l}`),
        "  ↓",
        ...cap(args.new_string ?? "", 500).split("\n").map((l) => `+ ${l}`),
      ]
    }
    if (base === "apply_patch") {
      // 补丁本身就是可读的 diff，直接预览
      return cap(args.patch ?? "", 1500).split("\n")
    }
    if (base === "delete") return [`${args.path}${args.force ? " (force: also delete tracked files)" : ""}`]
    if (base === "subagent") return cap(args.task ?? "", 500).split("\n")
    if (base === "memory_put") return [`[${args.type ?? ""}] ${args.title ?? ""}`, ...cap(args.content ?? "", 500).split("\n")]
    return [cap(summarize(args), 300)]
  }

  function askPermission(name, args) {
    // auto 模式：完全授权，不再询问
    if (agent.autoApprove) {
      pushLine(`  [auto] ${name} ${summarize(args)}`, C.warn)
      return Promise.resolve(true)
    }
    // 预览内容存到 permissionPreview，渲染在输入框上方紧挨"Allow?"提示
    state.permissionPreview = formatPermission(name, args)
    return new Promise((resolve) => {
      state.permission = { name, args, resolve }
      state.status = `Waiting: ${name}`
      render()
    })
  }

  function askQuestion(text, options = []) {
    // 一次只能问一个：question 是只读工具走并行通道，同批第二个直接驳回，
    // 否则后到的会覆盖 state.question，先到的 Promise 永远悬挂 (agent 死等）
    if (state.question) {
      return Promise.resolve("(error: another question is pending; ask one at a time and wait for the answer)")
    }
    if (!options.length) {
      // 自由文本：打开输入态让用户打字，Enter 提交
      pushLabel(`❯ Question`, ansi.bold + C.tool)
      for (const line of text.split("\n")) pushLine(`  ${line}`, C.text)
      return new Promise((resolve) => {
        state.question = { text, options: [], resolve }
        state.status = "Waiting for answer..."
        render()
      })
    }
    // 选项模式：输入框内显示列表，方向键选，Enter 确认
    pushLabel(`❯ Question`, ansi.bold + C.tool)
    for (const line of text.split("\n")) pushLine(`  ${line}`, C.text)
    return new Promise((resolve) => {
      state.question = { text, options, selected: 0, resolve }
      state.status = "Waiting for choice..."
      render()
    })
  }

  return { askPermission, askQuestion, formatPermission }
}
