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

test("config: defaults and per-repo rules", () => {
  assert.equal(cfg.models.main, "gpt-6.1-sol");
  assert.equal(cfg.limits.aicPerRun, 1000);
  assert.deepEqual(rulesFor(cfg, "api").setup, ["dotnet restore"]);
  assert.deepEqual(rulesFor(cfg, "api").gate.map((g) => g.name), ["test"]);
  assert.deepEqual(rulesFor(cfg, "infra").setup, ["npm ci"]);
});

test("config: the key is parsed case-insensitively", () => {
  assert.equal(resolveIssue(cfg, "vfs-1350").key, "VFS-1350");
  assert.equal(resolveIssue(cfg, "VFS-1350").slug, "vfs-1350");
  assert.throws(() => resolveIssue(cfg, "ABC-1"), /not in the settings/);
  assert.throws(() => resolveIssue(cfg, "hello"), /Jira key/);
});

test("slugify: diacritics and length", () => {
  assert.equal(slugify("Add CSV export for invoices"), "add-csv-export-for-invoices");
  assert.equal(slugify("Förändring och åtgärd"), "forandring-och-atgard");
  assert.ok(slugify("a".repeat(100)).length <= 40);
  assert.equal(slugify("!!!"), "issue");
});

test("plan: headings and length are checked", () => {
  assert.deepEqual(validatePlan(validPlan()), []);
  assert.match(validatePlan("## Approach\nx").join(), /Interpreted acceptance criteria/);
  assert.match(validatePlan(validPlan("x".repeat(7000))).join(), /6000/);
});

test("feedback: one point per line, comments ignored", () => {
  const items = parseFeedback("# help text\n- First\n  continued\n- Second\n");
  assert.deepEqual(items, ["First continued", "Second"]);
  assert.deepEqual(parseFeedback("# only help text\n-\n"), []);
});

test("PR text: only cwf's part is replaced", () => {
  const first = mergeBody(undefined, "New text");
  const edited = `Handwritten first\n${first}\nHandwritten last`;
  const updated = mergeBody(edited, "Updated");
  assert.match(updated, /^Handwritten first/);
  assert.match(updated, /Handwritten last$/);
  assert.match(updated, /Updated/);
  assert.doesNotMatch(updated, /New text/);
  assert.ok(mergeBody(undefined, "x".repeat(70_000)).length <= 60_000);
});

test("PR order follows dependencies", () => {
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

test("AIC: GPT-6.1 Sol costs 200 AIC per million input and 1000 per million output", () => {
  const b = new Budget(1000, { "gpt-6.1-sol": { input: 2, output: 10 } });
  b.add("gpt-6.1-sol", 1_000_000, 0);
  assert.equal(b.spentAic, 200);
  b.add("gpt-6.1-sol", 0, 1_000_000);
  assert.equal(b.spentAic, 1200);
  assert.ok(b.exceeded());
});
