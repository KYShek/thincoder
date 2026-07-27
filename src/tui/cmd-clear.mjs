/** /clear 命令：清屏（二次确认防误触）。
 *  ctx: { state, openPicker, render } */
export async function handleClearCommand(ctx) {
  const { state, openPicker, render } = ctx
  if (state.lines.length > 0) {
    openPicker({
      title: "Clear screen?",
      entries: [
        { type: "item", text: "Yes, clear all conversation output", action: "yes" },
        { type: "item", text: "Cancel", action: "no" },
      ],
      defaultIndex: 1,
      onSelect: (e) => {
        if (e.action === "yes") {
          state.lines = []
          state.streaming = ""
          render()
        }
      },
    })
    return
  }
  state.lines = []
  state.streaming = ""
  render()
}
