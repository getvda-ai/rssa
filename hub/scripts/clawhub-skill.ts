// Writes clawhub/rssa-network/SKILL.md: the production hub's skill file, as published to ClawHub.
// Run after any change to src/skill.ts: node hub/scripts/clawhub-skill.ts (a hub test fails while it is stale).
import { writeFileSync } from "node:fs";
import { CATEGORIES } from "../src/network.ts";
import { skillMd } from "../src/skill.ts";

export const PROD = "https://hub.rssa.getvda.ai";
export const SKILL_PATH = new URL("../../clawhub/rssa-network/SKILL.md", import.meta.url);
export const render = () => skillMd(PROD, CATEGORIES.map((c) => c.id));

if (process.argv[1]?.endsWith("clawhub-skill.ts")) {
  writeFileSync(SKILL_PATH, render());
  console.log(`wrote ${SKILL_PATH.pathname}`);
}
