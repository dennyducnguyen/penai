export * from "./registry.js";
export * from "./workspace-paths.js";
export * from "./exec-sandbox.js";
export * from "./skill-frontmatter.js";
export { currentTimeTool } from "./builtin/current-time.js";
export { readFileTool } from "./builtin/read-file.js";
export {
  listFilesTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  deleteFileTool,
  makeDirTool,
  sendFileTool,
  isMemoryPath,
} from "./builtin/fs-tools.js";
export { httpFetchTool } from "./builtin/http-fetch.js";
export { execTool, commandHeads } from "./builtin/exec.js";
export { webSearchTool } from "./builtin/web-search.js";
export { memoryAddTool, memorySearchTool, memoryGetTool } from "./builtin/memory.js";
export { skillSearchTool, useSkillTool, publishSkillTool, updateSkillTool } from "./builtin/skills.js";
export {
  saveLandingPageTool,
  listLandingPagesTool,
  getLandingPageTool,
} from "./builtin/landing-pages.js";
export { readDocumentTool, extractDocumentText } from "./builtin/read-document.js";
export {
  delegateTool,
  teamAddTaskTool,
  teamNextTaskTool,
  teamFinishTaskTool,
  teamListTasksTool,
} from "./builtin/teams.js";
export {
  vaultSearchTool,
  vaultGetTool,
  vaultWriteTool,
  kgSearchTool,
} from "./builtin/knowledge.js";
export { ttsTool } from "./builtin/tts.js";
export { sandboxTool } from "./builtin/sandbox.js";
export { browserTool } from "./builtin/browser.js";
export { imageGenTool } from "./builtin/image-gen.js";
export { publishFileTool } from "./builtin/publish-file.js";
export { approvalCardTool } from "./builtin/approval-card.js";
export * from "./custom-tool.js";

import { ToolRegistry } from "./registry.js";
import { currentTimeTool } from "./builtin/current-time.js";
import { readFileTool } from "./builtin/read-file.js";
import {
  listFilesTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  deleteFileTool,
  makeDirTool,
  sendFileTool,
} from "./builtin/fs-tools.js";
import { httpFetchTool } from "./builtin/http-fetch.js";
import { execTool } from "./builtin/exec.js";
import { webSearchTool } from "./builtin/web-search.js";
import { memoryAddTool, memorySearchTool, memoryGetTool } from "./builtin/memory.js";
import { skillSearchTool, useSkillTool, publishSkillTool, updateSkillTool } from "./builtin/skills.js";
import {
  saveLandingPageTool,
  listLandingPagesTool,
  getLandingPageTool,
} from "./builtin/landing-pages.js";
import { readDocumentTool } from "./builtin/read-document.js";
import {
  delegateTool,
  teamAddTaskTool,
  teamNextTaskTool,
  teamFinishTaskTool,
  teamListTasksTool,
} from "./builtin/teams.js";
import {
  vaultSearchTool,
  vaultGetTool,
  vaultWriteTool,
  kgSearchTool,
} from "./builtin/knowledge.js";
import { ttsTool } from "./builtin/tts.js";
import { sandboxTool } from "./builtin/sandbox.js";
import { browserTool } from "./builtin/browser.js";
import { imageGenTool } from "./builtin/image-gen.js";
import { publishFileTool } from "./builtin/publish-file.js";
import { approvalCardTool } from "./builtin/approval-card.js";

/** Registry với toàn bộ tool built-in mặc định. */
export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(currentTimeTool)
    .register(readFileTool)
    .register(listFilesTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(moveFileTool)
    .register(deleteFileTool)
    .register(makeDirTool)
    .register(sendFileTool)
    .register(httpFetchTool)
    .register(execTool)
    .register(webSearchTool)
    .register(memoryAddTool)
    .register(memorySearchTool)
    .register(memoryGetTool)
    .register(skillSearchTool)
    .register(useSkillTool)
    .register(publishSkillTool)
    .register(updateSkillTool)
    .register(saveLandingPageTool)
    .register(listLandingPagesTool)
    .register(getLandingPageTool)
    .register(readDocumentTool)
    .register(delegateTool)
    .register(teamAddTaskTool)
    .register(teamNextTaskTool)
    .register(teamFinishTaskTool)
    .register(teamListTasksTool)
    .register(vaultSearchTool)
    .register(vaultGetTool)
    .register(vaultWriteTool)
    .register(kgSearchTool)
    .register(ttsTool)
    .register(sandboxTool)
    .register(browserTool)
    .register(imageGenTool)
    .register(publishFileTool)
    .register(approvalCardTool);
}
