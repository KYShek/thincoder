/**
 * memory.mjs — 记忆系统（重新导出中心）
 * 子模块在 src/memory/ 目录下，按职责拆分。
 */

// schema + constants
export { createMemory, migrate, segmentCJK, VALID_TYPES, SCHEMA_VERSION, CODE_EXTS, DOC_EXTS, SKIP_DIRS, BIG_FILE_LINES } from "./memory/schema.mjs"

// CRUD + search + ensureEmbeddings
export { put, search, ftsSearch, fetchEntry, ensureEmbeddings, putMarkdown, syncDir, indexMarkdownFile, list, remove, buildFtsQuery } from "./memory/core.mjs"

// code chunking + markdown chunking
export { detectLanguage, extractSymbols, extractPySymbols, chunkCode, extractLeadingDoc, yieldTick, _upsertCodeFile, chunkMarkdown, _upsertDocFile } from "./memory/code-index.mjs"

// code sync + search + reindex
export { gitSync, codeSync, markIndexedCommit, codeSearch, ensureCodeEmbeddings, codeSearchTool, reindexFile } from "./memory/code-sync.mjs"

// doc sync + search + memoryTools
export { docSync, docSearch, ensureDocEmbeddings, docSearchTool, memoryTools } from "./memory/docs.mjs"
