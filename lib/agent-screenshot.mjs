/**
 * Is this path a screenshot the AGENT took of its own work? `see_page` saves one at
 * `.acuvo/render-<ms>.png` through the ordinary write path (`media.mjs`), so every place
 * that lists "what this run changed" sees it as a file the user asked for.
 *
 * ⭐ ONE predicate, asked by the summary (`turn.mjs`) and the plan reconciliation
 * (`plan-coherence.mjs`) alike — two copies of one opinion is how the same run
 * reported the screenshot as work in one place and not the other.
 */
const AGENT_SCREENSHOT = /^\.acuvo[\\/]render-\d+\.png$/;

export function isAgentScreenshot(path) {
  return AGENT_SCREENSHOT.test(String(path ?? ''));
}
