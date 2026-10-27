import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FakeAgent, type FakeCtx } from "../src/agent/fake.ts";
import { findCandidates, removeIssue } from "../src/clean.ts";
import { EXIT, runIssue } from "../src/loop.ts";
import { Store } from "../src/state.ts";
import { ScriptedUI } from "../src/ui.ts";
import { fakeIssue, question, sandbox, sh, validPlan } from "./helpers.ts";

const BRANCH = "vfs-1350-add-csv-export";

/** A typical plan phase: read, ask, propose a plan. */
const planScript = async (ctx: FakeCtx) => {
  ctx.shell("cat .cwf/issue.json");
  assert.equal(ctx.write("api/x.txt", "must be denied"), false, "the plan phase must be read-only");
  ctx.usage(10_000, 1_000);
  const a = await ctx.call("ask_user", { questions: [question()] });
  if (a.text === "paused") return;
  await ctx.call("submit_plan", { plan: validPlan() });
};

/** A typical build phase: change, forget to commit, fix, signal done. */
const buildScript = async (ctx: FakeCtx) => {
  ctx.write("api/app.txt", "v2\n");
  ctx.write("api/csv.txt", "export\n");
  assert.equal(ctx.shell("cd api && git push"), null, "push must be denied");
  const gate = await ctx.call("run_gate", {});
  assert.match(gate.text, /green/);
  const early = await ctx.call("ready_for_pr", { prs: [{ repo: "api", title: "CSV export", body: "Adds export." }] });
  assert.equal(early.ok, false);
  assert.match(early.text, /uncommitted/);
  ctx.shell("cd api && git add -A && git commit -q -m \"feat: csv export\"");
  await ctx.call("record_decision", { decision: "Uses semicolons", why: "Excel in Sweden", deviatesFromPlan: true });
  const r = await ctx.call("ready_for_pr", { prs: [{ repo: "api", title: "CSV export", body: "Adds export." }] });
  assert.equal(r.ok, true, r.text);
};

test("the full flow: question, plan, build, draft PR", async () => {
  const sb = sandbox();
  // Replies in order: question (No), plan (approve), publishing (draft)
  const ui = new ScriptedUI(["opt1", "approve", "draft"]);
  const agent = new FakeAgent([planScript, buildScript]);
  const code = await runIssue({ key: "vfs-1350", repos: [] }, { cfg: sb.cfg, ui, agent, fetchIssue: fakeIssue() });

  assert.equal(code, EXIT.done, ui.output.join("\n"));
  const store = Store.forIssue(join(sb.cfg.projectsDir, "vfs-1350"));
  const state = store.load();
  assert.equal(state.phase, "done");
  assert.equal(state.branch, BRANCH);
  assert.equal(state.answers[0]?.answer, "No");
  assert.equal(state.publish.api?.prUrl, "https://github.com/acme/api/pull/7");
  assert.ok(state.aic.total > 0);
  assert.ok(existsSync(store.path("plan/v1.md")));
  assert.ok(existsSync(store.path("plan/approved.md")));

  // The branch is pushed to origin with the commit
  const remoteLog = sh(`git --git-dir=${sb.origin("api")} log --oneline ${BRANCH}`);
  assert.match(remoteLog, /feat: csv export/);
  // The local branch pushes to the same-named branch on origin
  const upstream = sh(`git -C ${join(sb.cfg.projectsDir, "vfs-1350", "api")} config branch.${BRANCH}.merge`).trim();
  assert.equal(upstream, `refs/heads/${BRANCH}`);
  // PR created as a draft with a Jira link; the agent did no push or PR itself
  const gh = sb.ghLog();
  assert.ok(gh.some((l) => l.startsWith("pr create --draft")));
  assert.equal(agent.denied.some((d) => /git push/.test(d.tool)), true);
  // The deviation was shown at publish time
  assert.ok(ui.output.some((l) => l.includes("Uses semicolons")));
});

test("pause at a question and resume without losing anything", async () => {
  const sb = sandbox();
  // First run: no answers → timeout → pause
  const ui1 = new ScriptedUI([]);
  const code1 = await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: ui1, agent: new FakeAgent([planScript]), fetchIssue: fakeIssue() },
  );
  assert.equal(code1, EXIT.paused);
  const store = Store.forIssue(join(sb.cfg.projectsDir, "vfs-1350"));
  assert.equal(store.load().pendingQuestions.length, 1);
  assert.ok(!existsSync(store.path("lock")), "the lock must be released on pause");

  // Second run: cwf asks the pending question first, then the plan phase again
  let secondPrompt = "";
  const ui2 = new ScriptedUI(["opt0", "pause"]);
  const code2 = await runIssue(
    { key: "VFS-1350", repos: [], note: "The customer wants UTF-8" },
    {
      cfg: sb.cfg,
      ui: ui2,
      agent: new FakeAgent([
        async (ctx) => {
          secondPrompt = ctx.prompts[0] ?? "";
          await ctx.call("submit_plan", { plan: validPlan() });
        },
      ]),
      fetchIssue: fakeIssue(),
    },
  );
  assert.equal(code2, EXIT.paused);
  const state = store.load();
  assert.equal(state.pendingQuestions.length, 0);
  assert.equal(state.answers[0]?.answer, "Yes");
  assert.match(secondPrompt, /Answer: Yes/);
  assert.match(secondPrompt, /UTF-8/);

  // Third run: the waiting plan is shown directly without a new session; feedback gives a revision
  const ui3 = new ScriptedUI(["feedback", "- Add a heading row\n", "approve", "draft"]);
  let revisionPrompt = "";
  const agent3 = new FakeAgent([
    async (ctx) => {
      revisionPrompt = ctx.prompts[0] ?? "";
      const missing = await ctx.call("submit_plan", { plan: validPlan("v2") });
      assert.match(missing.text, /No response for feedback point 1/);
      await ctx.call("submit_plan", {
        plan: validPlan("v2"),
        responses: [{ feedback: 1, status: "addressed", why: "Heading row added" }],
      });
    },
    buildScript,
  ]);
  const code3 = await runIssue({ key: "VFS-1350", repos: [] }, { cfg: sb.cfg, ui: ui3, agent: agent3, fetchIssue: fakeIssue() });
  assert.equal(code3, EXIT.done, ui3.output.join("\n"));
  assert.match(revisionPrompt, /Add a heading row/);
  assert.equal(store.load().plan?.version, 2);
});

test("a changed issue during a pause is detected", async () => {
  const sb = sandbox();
  await runIssue({ key: "VFS-1350", repos: [] }, { cfg: sb.cfg, ui: new ScriptedUI([]), agent: new FakeAgent([planScript]), fetchIssue: fakeIssue() });
  const ui = new ScriptedUI(["pause"]);
  const code = await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui, agent: new FakeAgent([]), fetchIssue: fakeIssue("New title") },
  );
  assert.equal(code, EXIT.paused);
  assert.ok(ui.output.some((l) => l.includes("has changed in Jira")));
});

test("a blocked issue needs a note to continue", async () => {
  const sb = sandbox();
  const blocked = async (ctx: FakeCtx) => void (await ctx.call("report_blocked", { reason: "The requirement contradicts itself." }));
  const code = await runIssue({ key: "VFS-1350", repos: [] }, { cfg: sb.cfg, ui: new ScriptedUI([]), agent: new FakeAgent([blocked]), fetchIssue: fakeIssue() });
  assert.equal(code, EXIT.blocked);
  const again = await runIssue({ key: "VFS-1350", repos: [] }, { cfg: sb.cfg, ui: new ScriptedUI([]), agent: new FakeAgent([]), fetchIssue: fakeIssue() });
  assert.equal(again, EXIT.blocked);
  const withNote = await runIssue(
    { key: "VFS-1350", repos: [], note: "BA confirms: option A" },
    { cfg: sb.cfg, ui: new ScriptedUI([]), agent: new FakeAgent([planScript]), fetchIssue: fakeIssue() },
  );
  assert.equal(withNote, EXIT.paused);
});

test("a new run after publishing creates no duplicate PR, and cleanup removes the issue", async () => {
  const sb = sandbox();
  await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: new ScriptedUI(["opt1", "approve", "draft"]), agent: new FakeAgent([planScript, buildScript]), fetchIssue: fakeIssue() },
  );
  // Mark the drafts as ready on the next run
  const code = await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: new ScriptedUI(["ready"]), agent: new FakeAgent([]), fetchIssue: fakeIssue() },
  );
  assert.equal(code, EXIT.done);
  const gh = sb.ghLog();
  assert.equal(gh.filter((l) => l.startsWith("pr create")).length, 1);
  assert.ok(gh.some((l) => l.startsWith("pr edit 7")));
  assert.ok(gh.some((l) => l.startsWith("pr ready")));

  const cands = await findCandidates(sb.cfg);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]?.suggest, true);
  await removeIssue(sb.cfg, cands[0]!, false);
  assert.ok(!existsSync(join(sb.cfg.projectsDir, "vfs-1350")));
  assert.ok(existsSync(join(sb.cfg.projectsDir, ".cwf-archive")));
  const branches = sh("git branch", join(sb.cfg.projectsDir, "api"));
  assert.doesNotMatch(branches, new RegExp(BRANCH));
});

test("a conflict with the default branch is sent back to build", async () => {
  const sb = sandbox();
  // Run up to the publish decision and pause there
  await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: new ScriptedUI(["opt1", "approve", "pause"]), agent: new FakeAgent([planScript, buildScript]), fetchIssue: fakeIssue() },
  );
  // Someone else changes the same line on develop
  const other = join(sb.root, "other");
  sh(`git clone -q ${sb.origin("api")} ${other}`);
  sh("echo conflict > app.txt && git commit -qam \"other change\" && git push -q origin develop", other);

  let prompt = "";
  const resolve = async (ctx: FakeCtx) => {
    prompt = ctx.prompts[0] ?? "";
    ctx.write("api/app.txt", "v2 and conflict\n");
    ctx.shell("cd api && git add -A && git commit -q -m \"merge: resolve conflict\"");
    await ctx.call("ready_for_pr", { prs: [{ repo: "api", title: "CSV export", body: "x" }] });
  };
  const code = await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: new ScriptedUI(["draft"]), agent: new FakeAgent([resolve]), fetchIssue: fakeIssue() },
  );
  assert.equal(code, EXIT.done);
  assert.match(prompt, /conflicts/);
  const file = readFileSync(join(sb.cfg.projectsDir, "vfs-1350", "api", "app.txt"), "utf8");
  assert.equal(file, "v2 and conflict\n");
});
