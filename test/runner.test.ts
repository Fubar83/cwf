import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod/v4";
import { FakeAgent } from "../src/agent/fake.ts";
import { defineTool, type ToolDef } from "../src/agent/types.ts";
import { Budget, runSession, type Control } from "../src/runner.ts";

const spec = { model: "gpt-6.1-sol", cwd: "/tmp", systemPrompt: "", policy: () => ({ allow: true }) };
const budget = () => new Budget(1000, { "gpt-6.1-sol": { input: 2, output: 10 } });

const finishTool = (c: Control): ToolDef => defineTool({
  name: "finish",
  description: "",
  schema: z.object({ reason: z.string() }),
  handler: async ({ reason }) => {
    c.end({ kind: "blocked", reason });
    return { ok: true, text: "ok" };
  },
});

test("an ending tool ends the session", async () => {
  const agent = new FakeAgent([async (ctx) => void (await ctx.call("finish", { reason: "done" }))]);
  const end = await runSession(agent, spec, (c) => [finishTool(c)], { prompt: "run", budget: budget(), idleMs: 1000 });
  assert.deepEqual(end, { kind: "blocked", reason: "done" });
});

test("invalid arguments are returned to the model, which can correct itself", async () => {
  let firstError = "";
  const agent = new FakeAgent([
    async (ctx) => {
      firstError = (await ctx.call("finish", { reason: 42 })).text;
      await ctx.call("finish", { reason: "fixed" });
    },
  ]);
  const end = await runSession(agent, spec, (c) => [finishTool(c)], { prompt: "run", budget: budget(), idleMs: 1000 });
  assert.match(firstError, /Invalid arguments/);
  assert.equal(end.kind, "blocked");
});

test("silence counts as a hang", async () => {
  const agent = new FakeAgent([() => new Promise(() => {})]);
  const end = await runSession(agent, spec, () => [], { prompt: "run", budget: budget(), idleMs: 50 });
  assert.equal(end.kind, "hung");
});

test("the watchdog stands still while a dialog is open", async () => {
  const slowDialog = (c: Control): ToolDef => defineTool({
    name: "ask",
    description: "",
    schema: z.object({}),
    handler: async () => {
      await c.dialog(() => new Promise((r) => setTimeout(r, 150)));
      c.end({ kind: "paused", reason: "answered" });
      return { ok: true, text: "ok" };
    },
  });
  const agent = new FakeAgent([async (ctx) => void (await ctx.call("ask", {}))]);
  const end = await runSession(agent, spec, (c) => [slowDialog(c)], { prompt: "run", budget: budget(), idleMs: 50 });
  assert.equal(end.kind, "paused");
});

test("the AI-credit cap stops the session", async () => {
  const agent = new FakeAgent([
    async (ctx) => {
      ctx.usage(1_000_000, 1_000_000);
      await new Promise(() => {});
    },
  ]);
  const end = await runSession(agent, spec, () => [], { prompt: "run", budget: budget(), idleMs: 1000 });
  assert.equal(end.kind, "budget");
});

test("the model is reminded when it stops without an ending tool, then cwf gives up", async () => {
  const agent = new FakeAgent([async () => {}]);
  const end = await runSession(agent, spec, () => [], { prompt: "run", budget: budget(), idleMs: 1000, maxNudges: 2 });
  assert.equal(end.kind, "gave-up");
});
