import assert from "node:assert/strict";
import { test } from "node:test";
import { afterTool, makePolicy, splitCommand } from "../src/policy.ts";

const dir = "/w/projects/vfs-1350";
const plan = makePolicy({ phase: "plan", issueDir: dir });
const build = makePolicy({ phase: "build", issueDir: dir });
const sh = (p: typeof plan, command: string) => p({ toolName: "bash", args: { command }, kind: "shell" }).allow;
const write = (p: typeof plan, path: string) => p({ toolName: "edit", args: { path }, kind: "write" }).allow;

test("delkommandon delas upp", () => {
  assert.deepEqual(splitCommand("git add -A && FOO=1 git commit -m x | cat; ls"), [
    "git add -A",
    "git commit -m x",
    "cat",
    "ls",
  ]);
});

test("planläget är skrivskyddat", () => {
  for (const ok of ["git log --oneline", "rg Invoice api/", "cat api/AGENTS.md", "twg context jira workitem VFS-1350 -o json", "twg confluence pages get 123 -o json", "gh search code Foo --owner acme", "git diff 2>&1"]) {
    assert.equal(sh(plan, ok), true, ok);
  }
  for (const bad of ["git commit -m x", "npm install", "echo x > fil.txt", "dotnet build", "rm api/app.txt"]) {
    assert.equal(sh(plan, bad), false, bad);
  }
  assert.equal(write(plan, `${dir}/api/app.txt`), false);
});

test("alltid nekat, även i Bygga", () => {
  for (const bad of [
    "git push origin HEAD",
    "git add -A && git push",
    "git rebase develop",
    "git reset --hard HEAD~1",
    "git checkout main",
    "git stash",
    "git commit --no-verify -m x",
    "gh pr create --fill",
    "gh pr merge 7",
    "gh api repos/x -X DELETE",
    "cdk deploy",
    "npx cdk destroy",
    "aws s3 ls",
    "curl https://example.com",
    "twg jira workitem update VFS-1 --comment hej",
    "cat .env",
    "cat ~/.config/gh/hosts.yml",
    "echo $(cat secret)",
    "rm -rf .wf/state.json",
  ]) {
    assert.equal(sh(build, bad), false, bad);
  }
});

test("Bygga tillåter vanligt utvecklingsarbete", () => {
  for (const ok of ["git add -A", "git commit -m 'feat: x'", "git commit --amend --no-edit", "git restore app.txt", "dotnet test --no-restore", "npm ci", "cdk synth", "twg confluence pages get 9 -o json"]) {
    assert.equal(sh(build, ok), true, ok);
  }
});

test("filskrivning bara i worktrees, aldrig i .wf", () => {
  assert.equal(write(build, `${dir}/api/src/x.cs`), true);
  assert.equal(write(build, "api/src/x.cs"), true);
  assert.equal(write(build, `${dir}/.wf/state.json`), false);
  assert.equal(write(build, "/etc/passwd"), false);
  assert.equal(write(build, `${dir}/../vfs-9/api/x`), false);
  assert.equal(build({ toolName: "view", args: { path: `${dir}/api/.env.local` }, kind: "read" }).allow, false);
});

test("skrivande GitHub MCP-verktyg och webb nekas", () => {
  assert.equal(build({ toolName: "github-mcp-server-create_pull_request", args: {} }).allow, false);
  assert.equal(build({ toolName: "web_fetch", args: { url: "https://x" } }).allow, false);
  assert.equal(build({ toolName: "github-mcp-server-get_file_contents", args: {} }).allow, true);
});

test("varning vid undantag från kontroller", () => {
  assert.match(afterTool({ toolName: "edit", args: { new_str: "// @ts-ignore\nfoo()" } }) ?? "", /undantag/);
  assert.match(afterTool({ toolName: "edit", args: { content: "it.skip('x')" } }) ?? "", /överhoppade/);
  assert.equal(afterTool({ toolName: "edit", args: { content: "vanlig kod" } }), undefined);
});
