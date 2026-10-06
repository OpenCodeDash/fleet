import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContainerProvisioner,
  NspawnBackend,
  ProvisionError,
  buildNspawnArgs,
  buildSystemdRunArgs,
  type CommandResult,
  type CommandRunner,
  type ContainerBackend,
  type ContainerSpec,
  type FetchLike,
} from "../src/provision/index.ts";

const spec: ContainerSpec = {
  name: "fleet-1",
  systemPath: "/nix/store/xxx-nixos-system-nixos-26.11",
  configDir: "/run/fleet/fleet-1",
  port: 4096,
};

function recordingRunner(results: CommandResult[] = []): {
  runner: CommandRunner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  let index = 0;
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      const result =
        results[Math.min(index, results.length - 1)] ?? { code: 0, stdout: "", stderr: "" };
      index += 1;
      return result;
    },
  };
  return { runner, calls };
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

function fakeBackend(): {
  backend: ContainerBackend;
  started: ContainerSpec[];
  stopped: string[];
} {
  const started: ContainerSpec[] = [];
  const stopped: string[] = [];
  const backend: ContainerBackend = {
    async start(s) {
      started.push(s);
      return { name: s.name, spec: s };
    },
    async stop(handle) {
      stopped.push(handle.name);
    },
    address(handle) {
      return `http://${handle.name}:${handle.spec.port}`;
    },
  };
  return { backend, started, stopped };
}

const noSleep = async (): Promise<void> => {};

test("nspawn args: ephemeral rootfs, read-only config bind, machine + system", () => {
  const args = buildNspawnArgs(spec);
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--machine=fleet-1"));
  assert.ok(args.includes(`--directory=${spec.systemPath}`));
  assert.ok(args.includes(`--bind-ro=${spec.configDir}:/etc/fleet/opencode`));
  assert.ok(args.includes("--network-veth"));
  assert.ok(args.includes(`${spec.systemPath}/init`));
});

test("systemd-run wrapper launches nspawn as a collectable transient unit", () => {
  const args = buildSystemdRunArgs(spec);
  assert.deepEqual(args.slice(0, 4), ["--collect", "--unit=fleet-fleet-1", "systemd-nspawn", "--quiet"]);
});

test("NspawnBackend.start runs systemd-run and returns a handle", async () => {
  const { runner, calls } = recordingRunner([{ code: 0, stdout: "", stderr: "" }]);
  const backend = new NspawnBackend(runner);
  const handle = await backend.start(spec);
  assert.equal(handle.name, "fleet-1");
  assert.equal(calls[0]?.command, "systemd-run");
  assert.ok(calls[0]?.args.includes("--ephemeral"));
});

test("NspawnBackend.start throws ProvisionError when systemd-run fails", async () => {
  const { runner } = recordingRunner([{ code: 1, stdout: "", stderr: "boom" }]);
  const backend = new NspawnBackend(runner);
  await assert.rejects(
    () => backend.start(spec),
    (error: unknown) => error instanceof ProvisionError && /boom/.test((error as Error).message),
  );
});

test("NspawnBackend.stop terminates the machine and tolerates an absent one", async () => {
  const { runner, calls } = recordingRunner([{ code: 0, stdout: "", stderr: "" }]);
  const backend = new NspawnBackend(runner);
  await backend.stop({ name: "fleet-1", spec });
  assert.deepEqual(calls[0], { command: "machinectl", args: ["terminate", "fleet-1"] });

  const gone = recordingRunner([{ code: 1, stdout: "", stderr: "Machine fleet-1 is not running." }]);
  await new NspawnBackend(gone.runner).stop({ name: "fleet-1", spec });
});

test("NspawnBackend.stop surfaces a real failure", async () => {
  const { runner } = recordingRunner([{ code: 1, stdout: "", stderr: "permission denied" }]);
  await assert.rejects(
    () => new NspawnBackend(runner).stop({ name: "fleet-1", spec }),
    (error: unknown) => error instanceof ProvisionError,
  );
});

test("provision starts the container and returns once health is ok", async () => {
  const backend = fakeBackend();
  const fetch = fakeFetch([{ ok: true }]);
  const provisioner = new ContainerProvisioner(backend.backend, {
    fetchImpl: fetch.impl,
    sleep: noSleep,
  });
  const handle = await provisioner.provision(spec);
  assert.equal(handle.name, "fleet-1");
  assert.equal(backend.started.length, 1);
  assert.deepEqual(fetch.calls, ["http://fleet-1:4096/global/health"]);
});

test("provision retries the health check until the server answers", async () => {
  const backend = fakeBackend();
  const fetch = fakeFetch(["throw", { ok: false }, { ok: true }]);
  const provisioner = new ContainerProvisioner(backend.backend, {
    fetchImpl: fetch.impl,
    sleep: noSleep,
  });
  await provisioner.provision(spec);
  assert.equal(fetch.calls.length, 3);
});

test("provision times out when the server never becomes healthy", async () => {
  const backend = fakeBackend();
  const fetch = fakeFetch([{ ok: false }]);
  const provisioner = new ContainerProvisioner(backend.backend, {
    fetchImpl: fetch.impl,
    readyTimeoutMs: 0,
    sleep: noSleep,
  });
  await assert.rejects(
    () => provisioner.provision(spec),
    (error: unknown) =>
      error instanceof ProvisionError && /did not become ready/.test((error as Error).message),
  );
  assert.equal(fetch.calls.length, 1);
});

test("destroy delegates to the backend", async () => {
  const backend = fakeBackend();
  const provisioner = new ContainerProvisioner(backend.backend);
  await provisioner.destroy({ name: "fleet-1", spec });
  assert.deepEqual(backend.stopped, ["fleet-1"]);
});
