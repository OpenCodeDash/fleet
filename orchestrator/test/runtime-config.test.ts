import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeConfigError, loadRuntimeConfig } from "../src/runtime-config.ts";

function write(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-rc-"));
  const file = join(dir, "orchestrator.yaml");
  writeFileSync(file, contents);
  return file;
}

const minimal = `
board:
  url: http://board
  id: b1
hosts:
  - name: h1
    ssh: { host: 10.0.0.1, user: root }
repos:
  default: { url: https://x/r.git, dir: /r }
container:
  modulePath: /etc/nixos/image/fleet-agent.nix
model: { provider: router, id: basic }
catalog: /c.json
`;

const withToken = `
board:
  url: http://board
  id: b1
  token: \${env:KANBAN_TOKEN}
hosts:
  - name: h1
    ssh: { host: 10.0.0.1 }
repos:
  default: { url: https://x/r.git, dir: /r }
container:
  modulePath: /m.nix
model: { provider: router, id: basic }
catalog: /c.json
`;

test("loads a minimal config with defaults", () => {
  const config = loadRuntimeConfig({ filePath: write(minimal), env: {} });
  assert.equal(config.boards.length, 1);
  assert.equal(config.boards[0]?.url, "http://board");
  assert.deepEqual(config.boards[0]?.queues.author, ["Todo", "Changes Requested"]);
  assert.deepEqual(config.boards[0]?.queues.reviewer, ["Code Review"]);
  assert.equal(config.boards[0]?.done, "Done");
  assert.deepEqual(config.boards[0]?.blocked, ["Need Help"]);
  assert.equal(config.hosts.length, 1);
  assert.equal(config.hosts[0]?.maxContainers, 10);
  assert.deepEqual(config.container.dns, ["1.1.1.1", "8.8.8.8"]);
  assert.equal(config.container.port, 4096);
  assert.equal(config.review.maxRounds, 3);
  assert.equal(config.observability.statusPort, 4000);
});

test("parses multiple boards, each with its own queues", () => {
  const file = write(`
boards:
  - url: http://a
    id: b1
    queues: { author: [Todo], reviewer: [Review] }
    done: Shipped
    blocked: [Stuck]
  - url: http://b
    id: b2
hosts:
  - name: h1
    ssh: { host: 10.0.0.1 }
repos:
  default: { url: https://x/r.git, dir: /r }
container: { modulePath: /m.nix }
model: { provider: router, id: basic }
catalog: /c.json
`);
  const config = loadRuntimeConfig({ filePath: file, env: {} });
  assert.equal(config.boards.length, 2);
  assert.deepEqual(config.boards[0]?.queues.author, ["Todo"]);
  assert.deepEqual(config.boards[0]?.queues.reviewer, ["Review"]);
  assert.equal(config.boards[0]?.done, "Shipped");
  assert.deepEqual(config.boards[0]?.blocked, ["Stuck"]);
  assert.equal(config.boards[1]?.id, "b2");
  assert.deepEqual(config.boards[1]?.queues.author, ["Todo", "Changes Requested"]);
});

test("parses multiple hosts with egress", () => {
  const file = write(`
board:
  url: http://board
  id: b1
hosts:
  - name: h1
    ssh: { host: 10.0.0.1, user: root }
  - name: h2
    ssh: { host: 10.0.0.2 }
    maxContainers: 3
    egress: { adminUrl: http://10.0.0.2:3129, proxyUrl: http://10.233.0.1:3128, base: [10.0.0.9], noProxy: [localhost] }
repos:
  default: { url: https://x/r.git, dir: /r }
container:
  modulePath: /m.nix
model: { provider: router, id: basic }
catalog: /c.json
`);
  const config = loadRuntimeConfig({ filePath: file, env: {} });
  assert.equal(config.hosts.length, 2);
  assert.equal(config.hosts[1]?.maxContainers, 3);
  assert.equal(config.hosts[1]?.egress?.adminUrl, "http://10.0.0.2:3129");
  assert.equal(config.hosts[1]?.egress?.proxyUrl, "http://10.233.0.1:3128");
  assert.deepEqual(config.hosts[1]?.egress?.base, ["10.0.0.9"]);
  assert.deepEqual(config.hosts[1]?.egress?.noProxy, ["localhost"]);
});

test("fails when host egress is missing proxyUrl", () => {
  const file = write(`
board: { url: http://board, id: b1 }
hosts:
  - name: h1
    ssh: { host: 10.0.0.1 }
    egress: { adminUrl: http://10.0.0.1:3129 }
repos:
  default: { url: https://x/r.git, dir: /r }
container: { modulePath: /m.nix }
model: { provider: router, id: basic }
catalog: /c.json
`);
  assert.throws(
    () => loadRuntimeConfig({ filePath: file, env: {} }),
    (error: unknown) =>
      error instanceof RuntimeConfigError && /hosts\[0\]\.egress\.proxyUrl/.test((error as Error).message),
  );
});

test("accepts a co-located host (local: true) with no ssh", () => {
  const file = write(`
board: { url: http://board, id: b1 }
hosts:
  - name: local
    local: true
    egress: { adminUrl: http://127.0.0.1:3129, proxyUrl: http://192.168.68.106:3128 }
repos:
  default: { url: https://x/r.git, dir: /r }
container: { modulePath: /m.nix }
model: { provider: router, id: basic }
catalog: /c.json
`);
  const config = loadRuntimeConfig({ filePath: file, env: {} });
  assert.equal(config.hosts[0]?.local, true);
  assert.equal(config.hosts[0]?.ssh, undefined);
});

test("fails when a non-local host has no ssh", () => {
  const file = write(`
board: { url: http://board, id: b1 }
hosts:
  - name: h1
repos:
  default: { url: https://x/r.git, dir: /r }
container: { modulePath: /m.nix }
model: { provider: router, id: basic }
catalog: /c.json
`);
  assert.throws(
    () => loadRuntimeConfig({ filePath: file, env: {} }),
    (error: unknown) =>
      error instanceof RuntimeConfigError && /hosts\[0\]\.ssh\.host/.test((error as Error).message),
  );
});

test("substitutes environment references", () => {
  const config = loadRuntimeConfig({ filePath: write(withToken), env: { KANBAN_TOKEN: "bdsk_x" } });
  assert.equal(config.boards[0]?.token, "bdsk_x");
});

test("fails when a referenced env var is unset", () => {
  assert.throws(
    () => loadRuntimeConfig({ filePath: write(withToken), env: {} }),
    (error: unknown) => error instanceof RuntimeConfigError && /KANBAN_TOKEN/.test((error as Error).message),
  );
});

test("fails on a missing required field", () => {
  const file = write(
    "hosts:\n  - name: h\n    ssh: { host: x }\nrepos:\n  default: { url: u, dir: d }\ncontainer: { modulePath: m }\nmodel: { provider: p, id: i }\n",
  );
  assert.throws(
    () => loadRuntimeConfig({ filePath: file, env: {} }),
    (error: unknown) => error instanceof RuntimeConfigError && /boards/.test((error as Error).message),
  );
});

test("fails on invalid yaml", () => {
  assert.throws(
    () => loadRuntimeConfig({ filePath: write("foo: [unclosed\n"), env: {} }),
    RuntimeConfigError,
  );
});
