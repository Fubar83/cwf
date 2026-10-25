import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, resolveIssue, rulesFor } from "../src/config.ts";
import { mergeBody, orderByDependencies } from "../src/publish.ts";
import { Budget } from "../src/runner.ts";
import { parseFeedback, validatePlan } from "../src/tools.ts";
import { slugify } from "../src/workspace.ts";
import { validPlan } from "./helpers.ts";

const cfg = ConfigSchema.parse({
  projectsDir: "/tmp/p",
  jira: { site: "x.atlassian.net", projects: [{ key: "vfs", repos: ["api", "infra"] }] },
  github: { org: "acme" },
  repos: {
    defaults: { setup: ["npm ci"], gate: [{ name: "test", run: "npm test" }] },
    api: { setup: ["dotnet restore"] },
  },
});

test("config: standardvärden och regler per repo", () => {
  assert.equal(cfg.models.main, "gpt-6.1-sol");
  assert.equal(cfg.limits.aicPerRun, 1000);
  assert.deepEqual(rulesFor(cfg, "api").setup, ["dotnet restore"]);
  assert.deepEqual(rulesFor(cfg, "api").gate.map((g) => g.name), ["test"]);
  assert.deepEqual(rulesFor(cfg, "infra").setup, ["npm ci"]);
});

test("config: nyckel tolkas skiftlägesokänsligt", () => {
  assert.equal(resolveIssue(cfg, "vfs-1350").key, "VFS-1350");
  assert.equal(resolveIssue(cfg, "VFS-1350").slug, "vfs-1350");
  assert.throws(() => resolveIssue(cfg, "ABC-1"), /finns inte/);
  assert.throws(() => resolveIssue(cfg, "hej"), /Jira-nyckel/);
});

test("slugify: svenska tecken och längd", () => {
  assert.equal(slugify("Lägg till CSV-export för fakturor"), "lagg-till-csv-export-for-fakturor");
  assert.ok(slugify("a".repeat(100)).length <= 40);
  assert.equal(slugify("!!!"), "arende");
});

test("plan: rubriker och längd kontrolleras", () => {
  assert.deepEqual(validatePlan(validPlan()), []);
  assert.match(validatePlan("## Angreppssätt\nx").join(), /Tolkade acceptanskriterier/);
  assert.match(validatePlan(validPlan("x".repeat(7000))).join(), /6000/);
});

test("feedback: en punkt per rad, kommentarer ignoreras", () => {
  const items = parseFeedback("# hjälptext\n- Första\n  fortsätter\n- Andra\n");
  assert.deepEqual(items, ["Första fortsätter", "Andra"]);
  assert.deepEqual(parseFeedback("# bara hjälptext\n-\n"), []);
});

test("PR-text: bara cwf:s del ersätts", () => {
  const first = mergeBody(undefined, "Ny text");
  const edited = `Handskrivet först\n${first}\nHandskrivet sist`;
  const updated = mergeBody(edited, "Uppdaterad");
  assert.match(updated, /^Handskrivet först/);
  assert.match(updated, /Handskrivet sist$/);
  assert.match(updated, /Uppdaterad/);
  assert.doesNotMatch(updated, /Ny text/);
  assert.ok(mergeBody(undefined, "x".repeat(70_000)).length <= 60_000);
});

test("PR-ordning följer beroenden", () => {
  const order = orderByDependencies([
    { repo: "web", title: "", body: "", dependsOn: ["api"] },
    { repo: "api", title: "", body: "", dependsOn: ["infra"] },
    { repo: "infra", title: "", body: "", dependsOn: [] },
  ]).map((p) => p.repo);
  assert.deepEqual(order, ["infra", "api", "web"]);
  assert.throws(() =>
    orderByDependencies([
      { repo: "a", title: "", body: "", dependsOn: ["b"] },
      { repo: "b", title: "", body: "", dependsOn: ["a"] },
    ]),
  );
});

test("AIC: GPT-6.1 Sol kostar 200 AIC per miljon in och 1000 per miljon ut", () => {
  const b = new Budget(1000, { "gpt-6.1-sol": { input: 2, output: 10 } });
  b.add("gpt-6.1-sol", 1_000_000, 0);
  assert.equal(b.spentAic, 200);
  b.add("gpt-6.1-sol", 0, 1_000_000);
  assert.equal(b.spentAic, 1200);
  assert.ok(b.exceeded());
});
