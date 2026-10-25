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

test("ett avslutande verktyg avslutar sessionen", async () => {
  const agent = new FakeAgent([async (ctx) => void (await ctx.call("finish", { reason: "klart" }))]);
  const end = await runSession(agent, spec, (c) => [finishTool(c)], { prompt: "kör", budget: budget(), idleMs: 1000 });
  assert.deepEqual(end, { kind: "blocked", reason: "klart" });
});

test("ogiltiga argument returneras till modellen, som kan rätta sig", async () => {
  let firstError = "";
  const agent = new FakeAgent([
    async (ctx) => {
      firstError = (await ctx.call("finish", { reason: 42 })).text;
      await ctx.call("finish", { reason: "rättat" });
    },
  ]);
  const end = await runSession(agent, spec, (c) => [finishTool(c)], { prompt: "kör", budget: budget(), idleMs: 1000 });
  assert.match(firstError, /Ogiltiga argument/);
  assert.equal(end.kind, "blocked");
});

test("tystnad räknas som hängning", async () => {
  const agent = new FakeAgent([() => new Promise(() => {})]);
  const end = await runSession(agent, spec, () => [], { prompt: "kör", budget: budget(), idleMs: 50 });
  assert.equal(end.kind, "hung");
});

test("vakten står still medan en dialog är öppen", async () => {
  const slowDialog = (c: Control): ToolDef => defineTool({
    name: "ask",
    description: "",
    schema: z.object({}),
    handler: async () => {
      await c.dialog(() => new Promise((r) => setTimeout(r, 150)));
      c.end({ kind: "paused", reason: "svarat" });
      return { ok: true, text: "ok" };
    },
  });
  const agent = new FakeAgent([async (ctx) => void (await ctx.call("ask", {}))]);
  const end = await runSession(agent, spec, (c) => [slowDialog(c)], { prompt: "kör", budget: budget(), idleMs: 50 });
  assert.equal(end.kind, "paused");
});

test("AIC-taket stoppar sessionen", async () => {
  const agent = new FakeAgent([
    async (ctx) => {
      ctx.usage(1_000_000, 1_000_000);
      await new Promise(() => {});
    },
  ]);
  const end = await runSession(agent, spec, () => [], { prompt: "kör", budget: budget(), idleMs: 1000 });
  assert.equal(end.kind, "budget");
});

test("modellen påminns om den slutar utan avslutande verktyg, sedan ger cwf upp", async () => {
  const agent = new FakeAgent([async () => {}]);
  const end = await runSession(agent, spec, () => [], { prompt: "kör", budget: budget(), idleMs: 1000, maxNudges: 2 });
  assert.equal(end.kind, "gave-up");
});
