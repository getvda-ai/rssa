// Every ClawHub package in clawhub/<name>/SKILL.md, held to what ClawHub's review enforced on rssa-network
// (2026-10-21): the name matches the folder, a description of at most 200 characters, every action disclosed
// up front, and no credential-file path (read as credential theft).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "clawhub");
const FRONT = /^---\nname: (\S+)\nversion: (\d+\.\d+\.\d+)\ndescription: (.+)\nhomepage: (https:\/\/\S+)\nmetadata: (\{.+\})\n---\n/;

for (const dir of readdirSync(ROOT)) {
  test(`clawhub/${dir}: frontmatter and disclosures`, () => {
    const text = readFileSync(join(ROOT, dir, "SKILL.md"), "utf8");
    const m = FRONT.exec(text);
    assert.ok(m, "frontmatter: name, version, description, homepage, metadata, in that order");
    assert.equal(m![1], dir, "the name matches the folder");
    assert.ok(m![3].length <= 200, `description is ${m![3].length} characters (ClawHub's limit is 200)`);
    const meta = JSON.parse(m![5]);
    assert.deepEqual(meta.openclaw.requires.bins, ["curl"]);
    assert.match(text, /\*\*What this skill does, all of it:\*\*/, "every action is disclosed up front");
    assert.doesNotMatch(text, /~\/\.[A-Za-z]+\/[^\s]*credentials/, "no credential-file path");
  });
}
