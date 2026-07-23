/**
 * embedding.mjs — 向量嵌入
 * OpenAI 兼容 /v1/embeddings（SiliconFlow bge-m3 / Ollama / OpenAI 均可），
 * 复用 provider.mjs 的 fetch + 重试模式，零依赖。
 * 向量在入库前归一化，之后点积即余弦相似度。
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const BATCH_SIZE = 32 // 单次请求的文本数上限（SiliconFlow 限制内）

/** 创建 embedder。config: { baseURL, apiKey, model } */
export function createEmbedder(config) {
  if (!config?.baseURL) throw new Error("embedding config: baseURL is required")
  if (!config?.apiKey) throw new Error("embedding config: apiKey is required (config file or SILICONFLOW_API_KEY env)")
  if (!config?.model) throw new Error("embedding config: model is required")
  return {
    baseURL: config.baseURL.replace(/\/+$/, ""),
    apiKey: config.apiKey,
    model: config.model,
  }
}

/**
 * 批量嵌入。texts: string[] → Float32Array[]（已归一化）
 * 自动分批，失败重试（指数退避）。
 */
export async function embed(embedder, texts, { signal } = {}) {
  if (texts.length === 0) return []
  const vectors = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const data = await requestWithRetry(embedder, batch, signal)
    // API 按 data[].embedding 返回，顺序与输入一致
    for (const item of data.data) {
      vectors.push(normalize(Float32Array.from(item.embedding)))
    }
  }
  return vectors
}

/** 余弦相似度（输入均已归一化，点积即余弦） */
export function cosine(a, b) {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) sum += a[i] * b[i]
  return sum
}

/** Float32Array → 可存 sqlite BLOB 的 Buffer */
export function toBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

/** sqlite BLOB → Float32Array */
export function fromBlob(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

// ---------------------------------------------------------------- 内部

async function requestWithRetry(embedder, input, signal) {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(2 ** (attempt - 1) * 1000)

    let response
    try {
      response = await fetch(`${embedder.baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${embedder.apiKey}`,
        },
        body: JSON.stringify({ model: embedder.model, input }),
        signal,
      })
    } catch (error) {
      if (error.name === "AbortError") throw error
      lastError = error
      continue
    }

    if (response.ok) return response.json()

    const text = await response.text().catch(() => "")
    const message = `Embedding API error ${response.status}: ${text}`
    if (RETRYABLE_STATUS.has(response.status)) {
      lastError = new Error(message)
      continue
    }
    throw new Error(message)
  }
  throw lastError
}

function normalize(vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  const norm = Math.sqrt(sum) || 1
  for (let i = 0; i < vec.length; i++) vec[i] /= norm
  return vec
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
