// tools/index.mjs — backend-compatible re-export
export { toOpenAISchema } from "./shared.mjs";

import { readTool, writeTool, editTool, insertAfterTool, readImageTool, hashlineEditTool } from "./file.mjs";
import { applyPatchTool, syntaxCheckTool, deleteTool } from "./patch.mjs";
import { bashTool, globTool, grepTool, lsTool } from "./system.mjs";
import { websearchTool, fetchTool } from "./web.mjs";
import { gitDiffTool, gitStatusTool, gitLogTool, questionTool, checkpointTool } from "./git.mjs";
import { checklistTool } from "./checklist.mjs";
import { linterTool } from "./linter.mjs";

export const builtinTools = [
  readTool, writeTool, editTool, insertAfterTool, hashlineEditTool, applyPatchTool,
  syntaxCheckTool, readImageTool, bashTool, globTool, grepTool,
  websearchTool, lsTool, fetchTool, deleteTool,
  gitDiffTool, gitStatusTool, gitLogTool, questionTool, checkpointTool,
  checklistTool, linterTool,
];

export {
  readTool, writeTool, editTool, insertAfterTool, hashlineEditTool, applyPatchTool,
  syntaxCheckTool, readImageTool, bashTool, globTool, grepTool,
  websearchTool, lsTool, fetchTool, deleteTool,
  gitDiffTool, gitStatusTool, gitLogTool, questionTool, checkpointTool,
  checklistTool, linterTool,
};
