import { AI_TOOLS } from "../types/ai-tools.js";
import {
  getAllAgents,
  getHooksConfig,
  getPluginManifest,
} from "../templates/antigravity/index.js";
import {
  collectBothTemplates,
  collectSharedHooks,
  resolvePlaceholders,
} from "./shared.js";

const ANTIGRAVITY_PLUGIN_ROOT = ".agents/plugins/trellis";

/**
 * The Antigravity (AGY) file set — written at init and diffed by `trellis update`.
 * - `.agent/workflows/` — continue + finish-work as slash commands
 * - `.agent/skills/trellis-{name}/SKILL.md` — auto-triggered & bundled skills
 * - `.agents/plugins/trellis/` — native AGY plugin bundle:
 *   - `plugin.json` — manifest
 *   - `hooks.json` — SessionStart, PreInvocation, PreToolUse (run_command, invoke_subagent)
 *   - `hooks/*.py` — shared Python hook scripts
 *   - `agents/*.md` — custom subagents (trellis-implement, trellis-check, trellis-research)
 */
export function collectAntigravityTemplates(): Map<string, string> {
  const files = collectBothTemplates(
    AI_TOOLS.antigravity.templateContext,
    (n) => `.agent/workflows/${n}.md`,
    ".agent/skills",
  );

  files.set(`${ANTIGRAVITY_PLUGIN_ROOT}/plugin.json`, getPluginManifest());
  files.set(
    `${ANTIGRAVITY_PLUGIN_ROOT}/${getHooksConfig().targetPath}`,
    resolvePlaceholders(getHooksConfig().content),
  );
  for (const agent of getAllAgents()) {
    files.set(
      `${ANTIGRAVITY_PLUGIN_ROOT}/agents/${agent.name}.md`,
      agent.content,
    );
  }
  for (const [k, v] of collectSharedHooks(
    `${ANTIGRAVITY_PLUGIN_ROOT}/hooks`,
    "antigravity",
  )) {
    files.set(k, v);
  }

  return files;
}
