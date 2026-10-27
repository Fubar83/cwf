import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/exec.ts";

// Windows only: npm-installed tools are .cmd shims, which spawn cannot start directly.
test("a .cmd shim on PATH runs, with arguments that contain spaces", { skip: process.platform !== "win32" }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "exec-test-")), "bin");
  mkdirSync(dir);
  // Like npm's shims: hand %* to node, which parses the quoted arguments.
  writeFileSync(join(dir, "zzcmdstub.cmd"), "@echo off\r\nnode -e \"console.log(JSON.stringify(process.argv.slice(1)))\" %*\r\n");
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir};${oldPath}`;
  try {
    const r = await run("zzcmdstub", ["one", "two words"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ["one", "two words"]);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("a missing command reports an error code instead of throwing", async () => {
  const r = await run("cwf-no-such-command-xyz", []);
  assert.notEqual(r.code, 0);
});
