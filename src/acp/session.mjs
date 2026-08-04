/**
 * session.mjs — one ACP session = one thincoder agent instance.
 *
 * - `run(input)` serializes prompts through a per-session FIFO promise chain
 *   (concurrent prompts queue; each runs after the previous turn's end_turn).
 * - `cancel()` flips the agent signal — the in-flight turn aborts
 *   (runAgent handles `signal.reason.interrupt`).
 * - `run` is injectable for tests (defaults to the real runAgent).
 */
import { runAgent } from "../agent.mjs"
import { buildAcpCallbacks } from "./bridge.mjs"

export function createAcpSession({ id, agent, notify, log = () => {}, run = runAgent }) {
  const signal = { aborted: false, reason: null }
  const callbacks = buildAcpCallbacks({ sessionId: id, notify, log })
  let queue = Promise.resolve()
  let busy = false

  return {
    id,
    agent,
    get busy() { return busy },
    run(input) {
      const task = queue.then(async () => {
        busy = true
        try {
          return await run(agent, input, callbacks, { signal })
        } finally {
          busy = false
        }
      })
      // Keep the chain alive even when a turn rejects (the next prompt still runs).
      queue = task.then(() => {}, () => {})
      return task
    },
    cancel() {
      signal.aborted = true
      signal.reason = { interrupt: true, message: "cancelled by client" }
    },
  }
}
