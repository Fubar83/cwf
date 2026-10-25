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

const BRANCH = "vfs-1350-lagg-till-csv-export";

/** En typisk planfas: läs, fråga, föreslå plan. */
const planScript = async (ctx: FakeCtx) => {
  ctx.shell("cat .wf/issue.json");
  assert.equal(ctx.write("api/x.txt", "ska nekas"), false, "planläget ska vara skrivskyddat");
  ctx.usage(10_000, 1_000);
  const a = await ctx.call("ask_user", { questions: [question()] });
  if (a.text === "paused") return;
  await ctx.call("submit_plan", { plan: validPlan() });
};

/** En typisk Bygga-fas: ändra, glöm committa, rätta, signalera klart. */
const buildScript = async (ctx: FakeCtx) => {
  ctx.write("api/app.txt", "v2\n");
  ctx.write("api/csv.txt", "export\n");
  assert.equal(ctx.shell("cd api && git push"), null, "push ska nekas");
  const gate = await ctx.call("run_gate", {});
  assert.match(gate.text, /gröna/);
  const early = await ctx.call("ready_for_pr", { prs: [{ repo: "api", title: "CSV-export", body: "Lägger till export." }] });
  assert.equal(early.ok, false);
  assert.match(early.text, /ocommittade/);
  ctx.shell("cd api && git add -A && git commit -q -m 'feat: csv-export'");
  await ctx.call("record_decision", { decision: "Använder semikolon", why: "Excel i Sverige", deviatesFromPlan: true });
  const r = await ctx.call("ready_for_pr", { prs: [{ repo: "api", title: "CSV-export", body: "Lägger till export." }] });
  assert.equal(r.ok, true, r.text);
};

test("hela flödet: fråga, plan, bygga, draft-PR", async () => {
  const sb = sandbox();
  // Svar i ordning: fråga (Nej), plan (godkänn), publicering (draft)
  const ui = new ScriptedUI(["opt1", "approve", "draft"]);
  const agent = new FakeAgent([planScript, buildScript]);
  const code = await runIssue({ key: "vfs-1350", repos: [] }, { cfg: sb.cfg, ui, agent, fetchIssue: fakeIssue() });

  assert.equal(code, EXIT.done, ui.output.join("\n"));
  const store = Store.forIssue(join(sb.cfg.projectsDir, "vfs-1350"));
  const state = store.load();
  assert.equal(state.phase, "done");
  assert.equal(state.branch, BRANCH);
  assert.equal(state.answers[0]?.answer, "Nej");
  assert.equal(state.publish.api?.prUrl, "https://github.com/acme/api/pull/7");
  assert.ok(state.aic.total > 0);
  assert.ok(existsSync(store.path("plan/v1.md")));
  assert.ok(existsSync(store.path("plan/approved.md")));

  // Branchen är pushad till origin med commiten
  const remoteLog = sh(`git --git-dir=${sb.origin("api")} log --oneline ${BRANCH}`);
  assert.match(remoteLog, /feat: csv-export/);
  // PR skapad som draft med Jira-länk, ingen push/PR gjord av agenten
  const gh = sb.ghLog();
  assert.ok(gh.some((l) => l.startsWith("pr create --draft")));
  assert.equal(agent.denied.some((d) => /git push/.test(d.tool)), true);
  // Avvikelsen visades vid publiceringen
  assert.ok(ui.output.some((l) => l.includes("Använder semikolon")));
});

test("paus vid fråga och återupptagning utan att tappa något", async () => {
  const sb = sandbox();
  // Första körningen: inga svar → timeout → paus
  const ui1 = new ScriptedUI([]);
  const code1 = await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: ui1, agent: new FakeAgent([planScript]), fetchIssue: fakeIssue() },
  );
  assert.equal(code1, EXIT.paused);
  const store = Store.forIssue(join(sb.cfg.projectsDir, "vfs-1350"));
  assert.equal(store.load().pendingQuestions.length, 1);
  assert.ok(!existsSync(store.path("lock")), "låset ska släppas vid paus");

  // Andra körningen: wf ställer den väntande frågan först, sedan planfasen igen
  let secondPrompt = "";
  const ui2 = new ScriptedUI(["opt0", "pause"]);
  const code2 = await runIssue(
    { key: "VFS-1350", repos: [], note: "Kunden vill ha UTF-8" },
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
  assert.equal(state.answers[0]?.answer, "Ja");
  assert.match(secondPrompt, /Svar: Ja/);
  assert.match(secondPrompt, /UTF-8/);

  // Tredje körningen: planen som väntar visas direkt utan ny session; feedback ger revision
  const ui3 = new ScriptedUI(["feedback", "- Lägg till rubrikrad\n", "approve", "draft"]);
  let revisionPrompt = "";
  const agent3 = new FakeAgent([
    async (ctx) => {
      revisionPrompt = ctx.prompts[0] ?? "";
      const missing = await ctx.call("submit_plan", { plan: validPlan("v2") });
      assert.match(missing.text, /Svar saknas för feedbackpunkt 1/);
      await ctx.call("submit_plan", {
        plan: validPlan("v2"),
        responses: [{ feedback: 1, status: "addressed", why: "Rubrikrad tillagd" }],
      });
    },
    buildScript,
  ]);
  const code3 = await runIssue({ key: "VFS-1350", repos: [] }, { cfg: sb.cfg, ui: ui3, agent: agent3, fetchIssue: fakeIssue() });
  assert.equal(code3, EXIT.done, ui3.output.join("\n"));
  assert.match(revisionPrompt, /Lägg till rubrikrad/);
  assert.equal(store.load().plan?.version, 2);
});

test("ändrat ärende under paus upptäcks", async () => {
  const sb = sandbox();
  await runIssue({ key: "VFS-1350", repos: [] }, { cfg: sb.cfg, ui: new ScriptedUI([]), agent: new FakeAgent([planScript]), fetchIssue: fakeIssue() });
  const ui = new ScriptedUI(["pause"]);
  const code = await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui, agent: new FakeAgent([]), fetchIssue: fakeIssue("Ny titel") },
  );
  assert.equal(code, EXIT.paused);
  assert.ok(ui.output.some((l) => l.includes("har ändrats i Jira")));
});

test("blockerat kräver en anteckning för att fortsätta", async () => {
  const sb = sandbox();
  const blocked = async (ctx: FakeCtx) => void (await ctx.call("report_blocked", { reason: "Kravet motsäger sig självt." }));
  const code = await runIssue({ key: "VFS-1350", repos: [] }, { cfg: sb.cfg, ui: new ScriptedUI([]), agent: new FakeAgent([blocked]), fetchIssue: fakeIssue() });
  assert.equal(code, EXIT.blocked);
  const again = await runIssue({ key: "VFS-1350", repos: [] }, { cfg: sb.cfg, ui: new ScriptedUI([]), agent: new FakeAgent([]), fetchIssue: fakeIssue() });
  assert.equal(again, EXIT.blocked);
  const withNote = await runIssue(
    { key: "VFS-1350", repos: [], note: "BA bekräftar: alternativ A" },
    { cfg: sb.cfg, ui: new ScriptedUI([]), agent: new FakeAgent([planScript]), fetchIssue: fakeIssue() },
  );
  assert.equal(withNote, EXIT.paused);
});

test("en ny körning efter publicering skapar ingen dubblett-PR, och städning tar bort ärendet", async () => {
  const sb = sandbox();
  await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: new ScriptedUI(["opt1", "approve", "draft"]), agent: new FakeAgent([planScript, buildScript]), fetchIssue: fakeIssue() },
  );
  // Markera drafts som redo vid nästa körning
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
  assert.ok(existsSync(join(sb.cfg.projectsDir, ".wf-archive")));
  const branches = sh("git branch", join(sb.cfg.projectsDir, "api"));
  assert.doesNotMatch(branches, new RegExp(BRANCH));
});

test("konflikt med standardbranchen skickas tillbaka till Bygga", async () => {
  const sb = sandbox();
  // Kör fram till publiceringsbeslutet och pausa där
  await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: new ScriptedUI(["opt1", "approve", "pause"]), agent: new FakeAgent([planScript, buildScript]), fetchIssue: fakeIssue() },
  );
  // Någon annan ändrar samma rad på develop
  const other = join(sb.root, "other");
  sh(`git clone -q ${sb.origin("api")} ${other}`);
  sh("echo konflikt > app.txt && git commit -qam 'annan ändring' && git push -q origin develop", other);

  let prompt = "";
  const resolve = async (ctx: FakeCtx) => {
    prompt = ctx.prompts[0] ?? "";
    ctx.write("api/app.txt", "v2 och konflikt\n");
    ctx.shell("cd api && git add -A && git commit -q -m 'merge: lös konflikt'");
    await ctx.call("ready_for_pr", { prs: [{ repo: "api", title: "CSV-export", body: "x" }] });
  };
  const code = await runIssue(
    { key: "VFS-1350", repos: [] },
    { cfg: sb.cfg, ui: new ScriptedUI(["draft"]), agent: new FakeAgent([resolve]), fetchIssue: fakeIssue() },
  );
  assert.equal(code, EXIT.done);
  assert.match(prompt, /konflikter/);
  const file = readFileSync(join(sb.cfg.projectsDir, "vfs-1350", "api", "app.txt"), "utf8");
  assert.equal(file, "v2 och konflikt\n");
});
