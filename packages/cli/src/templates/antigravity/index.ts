/**
 * Antigravity (AGY) plugin template module.
 *
 * Antigravity discovers workspace plugins under `.agents/plugins/<name>/`
 * (and supports global install via `agy plugin install`). Each plugin bundles:
 * - `plugin.json` — plugin manifest
 * - `hooks.json` — lifecycle hooks (`SessionStart`, `PreInvocation`, `PreToolUse`)
 * - `hooks/*.py` — shared Python hook scripts invoked relative to the plugin root
 * - `agents/*.md` — custom subagent definitions (`trellis-implement`, `trellis-check`, `trellis-research`)
 */

import {
  createTemplateReader,
  type AgentTemplate,
  type HookTemplate,
} from "../template-utils.js";

export type { AgentTemplate, HookTemplate };

const { listMdAgents, getConfig, getSettings } = createTemplateReader(
  import.meta.url,
);

/** Plugin manifest written to `.agents/plugins/trellis/plugin.json`. */
export function getPluginManifest(): string {
  return getConfig("plugin.json");
}

/** Lifecycle hook configuration written to `.agents/plugins/trellis/hooks.json`. */
export function getHooksConfig(): HookTemplate {
  return getSettings("hooks.json");
}

/** Subagent definitions (trellis-implement, trellis-check, trellis-research). */
export function getAllAgents(): AgentTemplate[] {
  return listMdAgents();
}
