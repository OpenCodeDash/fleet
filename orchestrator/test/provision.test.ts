import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContainerProvisioner,
  NixosContainerBackend,
  ProvisionError,
  renderContainerConfig,
  type CommandResult,
  type CommandRunner,
  type ContainerBackend,
  type ContainerSpec,
  type FetchLike,
} from "../src/provision/index.ts";

const spec: ContainerSpec = {
  name: "fleet-1",
  modulePath: "/etc/nixos/image/fleet-agent.nix",
  configFiles: [
    { path: "opencode.json", contents: "{}" },
    { path: "prompts/author.md", contents: "You are the author." },
  ],
  port: 4096,
};

interface Call {
  command: string;
  args: string[];
  input: string | undefined;
}

function recordingRunner(results: CommandResult[] = []): {
  runner: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, input: options?.input });
      const result =
        results[Math.min(index, results.length - 1)] ?? { code: 0, stdout: "", stderr: "" };
      index += 1;
      return result;
    },
  };
  return { runner, calls };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

function fakeBackend(): { backend: ContainerBackend; stopped: string[] } {
  const stopped: string[] = [];
  const backend: ContainerBackend = {
    async start(s) {
      return { name: s.name, spec: s, address: "http://10.0.0.9:4096" };
    },
    async stop(handle) {
      stopped.push(handle.name);
    },
  };
  return { backend, stopped };
}

function fakeFetch(responses: Array<{ ok: boolean } | "throw">): {
  impl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const impl = (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input.toString());
    const response = responses[Math.min(index, responses.length - 1)] ?? { ok: false };
    index += 1;
    if (response === "throw") throw new Error("connection refused");
    return new Response("", { status: response.ok ? 200 : 503 });
  }) as FetchLike;
  return { impl, calls };
}

const noSleep = async (): Promise<void> => {};

test("renderContainerConfig imports the module and bakes config under /etc/fleet/opencode", () => {
  const rendered = renderContainerConfig(spec);
  assert.match(rendered, /imports = \[ \/etc\/nixos\/image\/fleet-agent\.nix \];/);
  assert.match(rendered, /"fleet\/opencode\/opencode\.json"\.text = "\{\}";/);
  assert.match(rendered, /"fleet\/opencode\/prompts\/author\.md"\.text = "You are the author\.";/);
});

test("renderContainerConfig rejects a too-long or malformed name", () => {
  assert.throws(() => renderContainerConfig({ ...spec, name: "way-too-long-name" }), ProvisionError);
  assert.throws(() => renderContainerConfig({ ...spec, name: "bad_name" }), ProvisionError);
});

test("start creates, starts, and resolves the address from show-ip", async () => {
  const { runner, calls } = recordingRunner([ok(), ok(), ok(), ok(), ok("10.233.1.2\n")]);
  const handle = await new NixosContainerBackend(runner).start(spec);

  assert.equal(handle.address, "http://10.233.1.2:4096");
  assert.deepEqual(
    calls.map((call) => call.command),
    ["mkdir", "tee", "nixos-container", "nixos-container", "nixos-container"],
  );
  assert.deepEqual(calls[2]?.args, ["create", "fleet-1", "--config-file", "/run/fleet/fleet-1.nix"]);
  assert.deepEqual(calls[3]?.args, ["start", "fleet-1"]);
  assert.deepEqual(calls[4]?.args, ["show-ip", "fleet-1"]);
  assert.match(calls[1]?.input ?? "", /environment\.etc/);
});

test("start surfaces a create failure", async () => {
  const { runner } = recordingRunner([ok(), ok(), { code: 1, stdout: "", stderr: "boom" }]);
  await assert.rejects(
    () => new NixosContainerBackend(runner).start(spec),
    (error: unknown) =>
      error instanceof ProvisionError && /create container/.test((error as Error).message),
  );
});

test("stop terminates then destroys, tolerating an absent container", async () => {
  const { runner, calls } = recordingRunner([ok(), ok()]);
  await new NixosContainerBackend(runner).stop({ name: "fleet-1", spec, address: "http://x" });
  assert.deepEqual(calls[0]?.args, ["terminate", "fleet-1"]);
  assert.deepEqual(calls[1]?.args, ["destroy", "fleet-1"]);

  const gone = recordingRunner([
    ok(),
    { code: 1, stdout: "", stderr: "container 'fleet-1' does not exist" },
  ]);
  await new NixosContainerBackend(gone.runner).stop({ name: "fleet-1", spec, address: "http://x" });
});

test("provision waits for health at the handle address", async () => {
  const backend = fakeBackend();
  const fetch = fakeFetch([{ ok: true }]);
  const provisioner = new ContainerProvisioner(backend.backend, {
    fetchImpl: fetch.impl,
    sleep: noSleep,
  });
  const handle = await provisioner.provision(spec);
  assert.equal(handle.address, "http://10.0.0.9:4096");
  assert.deepEqual(fetch.calls, ["http://10.0.0.9:4096/global/health"]);
});

test("provision retries readiness then times out", async () => {
  const retry = fakeFetch(["throw", { ok: false }, { ok: true }]);
  await new ContainerProvisioner(fakeBackend().backend, {
    fetchImpl: retry.impl,
    sleep: noSleep,
  }).provision(spec);
  assert.equal(retry.calls.length, 3);

  const dead = fakeFetch([{ ok: false }]);
  await assert.rejects(
    () =>
      new ContainerProvisioner(fakeBackend().backend, {
        fetchImpl: dead.impl,
        readyTimeoutMs: 0,
        sleep: noSleep,
      }).provision(spec),
    (error: unknown) =>
      error instanceof ProvisionError && /did not become ready/.test((error as Error).message),
  );
});

test("opens a tunnel for a remote orchestrator and closes it on stop", async () => {
  const { runner } = recordingRunner([ok(), ok(), ok(), ok(), ok("10.233.1.2\n")]);
  let closed = false;
  const backend = new NixosContainerBackend(runner, {
    tunnel: () => ({
      localPort: 41500,
      close: () => {
        closed = true;
      },
    }),
  });
  const handle = await backend.start(spec);
  assert.equal(handle.address, "http://127.0.0.1:41500");
  await backend.stop(handle);
  assert.equal(closed, true);
});

test("destroy delegates to the backend", async () => {
  const backend = fakeBackend();
  await new ContainerProvisioner(backend.backend).destroy({
    name: "fleet-1",
    spec,
    address: "http://x",
  });
  assert.deepEqual(backend.stopped, ["fleet-1"]);
});
