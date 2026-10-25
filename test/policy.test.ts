import assert from "node:assert/strict";
import { test } from "node:test";
import { afterTool, makePolicy, splitCommand } from "../src/policy.ts";

const dir = "/w/projects/vfs-1350";
const plan = makePolicy({ phase: "plan", issueDir: dir });
const build = makePolicy({ phase: "build", issueDir: dir });
const sh = (p: typeof plan, command: string) => p({ toolName: "bash", args: { command }, kind: "shell" }).allow;
const write = (p: typeof plan, path: string) => p({ toolName: "edit", args: { path }, kind: "write" }).allow;

test("sub-commands are split apart", () => {
  assert.deepEqual(splitCommand("git add -A && FOO=1 git commit -m x | cat; ls"), [
    "git add -A",
    "git commit -m x",
    "cat",
    "ls",
  ]);
});

test("the plan phase is read-only", () => {
  for (const ok of ["git log --oneline", "rg Invoice api/", "cat api/AGENTS.md", "twg context jira workitem VFS-1350 -o json", "twg confluence pages get 123 -o json", "gh search code Foo --owner acme", "git diff 2>&1"]) {
    assert.equal(sh(plan, ok), true, ok);
  }
  for (const bad of ["git commit -m x", "npm install", "echo x > fil.txt", "dotnet build", "rm api/app.txt"]) {
    assert.equal(sh(plan, bad), false, bad);
  }
  assert.equal(write(plan, `${dir}/api/app.txt`), false);
});

test("always denied, even in the build phase", () => {
  for (const bad of ["git push origin develop", "git rebase develop", "git commit --no-verify -m x", "gh pr create", "gh api repos", "curl https://example.com", "echo $(cat secret)"]) {
    assert.equal(sh(build, bad), false, bad);
  }
});

test("build allows ordinary development work", () => {
  for (const ok of ["git add -A", "git commit -m 'feat: x'", "git commit --amend --no-edit", "git restore app.txt", "dotnet test --no-restore", "npm ci", "npm test", "twg confluence pages get 9 -o json"]) {
    assert.equal(sh(build, ok), true, ok);
  }
});

test("writes only in worktrees, never in .cwf", () => {
  assert.equal(write(build, `${dir}/api/src/x.cs`), true);
  assert.equal(write(build, "api/src/x.cs"), true);
  assert.equal(write(build, `${dir}/.cwf/state.json`), false);
  assert.equal(write(build, "/etc/passwd"), false);
  assert.equal(write(build, `${dir}/../vfs-9/api/x`), false);
  assert.equal(build({ toolName: "view", args: { path: `${dir}/api/.env.local` }, kind: "read" }).allow, false);
});

test("writing GitHub MCP tools and the web are denied", () => {
  assert.equal(build({ toolName: "github-mcp-server-create_pull_request", args: {} }).allow, false);
  assert.equal(build({ toolName: "web_fetch", args: { url: "https://x" } }).allow, false);
  assert.equal(build({ toolName: "github-mcp-server-get_file_contents", args: {} }).allow, true);
});

test("afterTool warns about suppressions", () => {
  const warn = afterTool({ toolName: "edit", args: { new_str: "// @ts-ignore\nx()" }, kind: "write" });
  assert.match(warn ?? "", /type- or lint-check exemptions/);
  assert.equal(afterTool({ toolName: "edit", args: { new_str: "x()" }, kind: "write" }), undefined);
});
