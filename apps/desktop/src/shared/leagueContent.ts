// Features that need hand-made content every league are switched off: their code and data
// stay, but nothing in the app, the main process or the AI's tool list reaches them. Same pattern as
// renderer/areaGate.ts (SOCIAL_AREAS). Flip a switch to true to bring that feature back; renderer and main both read it.

/** League starts on the Start screen (cards, Follow), the Library's "League starts" buttons, the palette entry, and
 * main's starter pack wiring (main/mastery/starters.ts, resources/mastery-starters/). */
export const LEAGUE_STARTERS = false;

/** Everything built on the hand-curated Atlas mechanic taxonomy (resources/atlas/reviews/taxonomy-*.json): Optimize
 * mechanics (button, A key), Plan with AI, Suggestions, the mechanic tiles in New plan, and the mechanic names main
 * serves to the renderer. Atlas plans, the tree and Quick plan's map support and fill stay. */
export const ATLAS_MECHANICS = false;

/** The leveling guide and everything that reads resources/leveling/<league>/: the Builds > Leveling tab (Ctrl+Alt+9),
 * Journey and its live follow-along, the leveling stage and leveling skill of the Loot Filter's build filter, and the
 * assistant's leveling tools (getLevelingGuide, explainGuideStep, proposeLevelingSkill). */
export let LEVELING_GUIDE = false; // eslint-disable-line prefer-const -- tests flip it below

/** Tests only: run the leveling guide's code with the switch on (or off), so the unparked behaviour stays covered. Values
 * computed once at import (the AI's tool list, the build tabs, main's IPC wiring) do not follow; code that reads the switch
 * when it runs (stage planning, the build filter) does. */
export function setLevelingGuideForTests(on: boolean): void {
  LEVELING_GUIDE = on;
}
