import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { computerUser, ensureComputer, type Computer } from "./computers";

const exec = promisify(execFile);
const OS = "Ubuntu 26.04" as const;
const DEFAULT_IMAGE = "cit-dots-desktop:latest";
const pending = new Map<string, Promise<unknown>>();
const relays = new Map<
  string,
  { target: string; port: number; server: net.Server; sockets: Set<net.Socket> }
>();

export interface DesktopStatus {
  dotId: string;
  state: "stopped" | "starting" | "running" | "error";
  url: string | null;
  os: typeof OS;
  error?: string;
}

export interface DesktopManagerOptions {
  dataDir: string;
  image?: string | (() => string);
}

interface DesktopMetadata {
  dotId: string;
  owner: string;
  password: string;
}

interface ContainerInfo {
  Id: string;
  Image: string;
  Config: { Labels: Record<string, string>; Image: string; User: string };
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
    Error: string;
    Health?: { Status: string };
  };
  Mounts: Array<{ Source: string; Destination: string; RW: boolean }>;
  HostConfig: {
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    SecurityOpt: string[];
    NetworkMode: string;
    PortBindings: Record<
      string,
      Array<{ HostIp: string; HostPort: string }> | null
    >;
  };
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
    Networks: Record<string, { IPAddress: string }>;
  };
}

interface NetworkInfo {
  Id: string;
  Internal: boolean;
  Labels: Record<string, string>;
}

/** Scope ownership to this installation, including backup safety checks. */
export function desktopOwner(dataDir: string): string {
  return createHash("sha256")
    .update(path.resolve(dataDir))
    .digest("hex")
    .slice(0, 24);
}

function validateId(dotId: string) {
  if (
    typeof dotId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(dotId)
  )
    throw new Error("Invalid Dot ID.");
}

export function desktopContainerName(dataDir: string, dotId: string): string {
  validateId(dotId);
  return `cit-dots-desktop-${createHash("sha256")
    .update(`${desktopOwner(dataDir)}:${dotId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function desktopNetworkName(dataDir: string, dotId: string): string {
  return `${desktopContainerName(dataDir, dotId)}-net`;
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete env[key];
  return env;
}

async function docker(args: string[], timeout = 10_000): Promise<string> {
  const { stdout } = await exec(
    "docker",
    ["--host=unix:///var/run/docker.sock", ...args],
    {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: dockerEnvironment(),
    },
  );
  return stdout;
}

async function inspect<T>(
  kind: "container" | "network",
  name: string,
): Promise<T | null> {
  try {
    const values = JSON.parse(await docker([kind, "inspect", name])) as T[];
    return values[0] ?? null;
  } catch (error) {
    const output = `${(error as { stderr?: string }).stderr ?? ""}`;
    if (/No such (object|container|network)|network .+ not found/i.test(output))
      return null;
    throw new Error(
      "Cannot inspect the local graphical desktop. Check that Docker is running and this user can access its local socket.",
    );
  }
}

async function exclusive<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pending.set(key, current);
  try {
    return await current;
  } finally {
    if (pending.get(key) === current) pending.delete(key);
  }
}

function closeRelay(key: string) {
  const relay = relays.get(key);
  if (!relay) return;
  relays.delete(key);
  for (const socket of relay.sockets) socket.destroy();
  relay.server.close();
}

/** Docker internal networks suppress published ports. Publish only this inbound
 * display connection on host loopback; the guest receives no outbound network. */
async function openRelay(
  key: string,
  info: ContainerInfo,
  networkName: string,
): Promise<number> {
  const host = info.NetworkSettings.Networks[networkName]?.IPAddress;
  if (!host || net.isIP(host) !== 4)
    throw new Error("The owned desktop has no internal display address.");
  const target = `${info.Id}:${host}`;
  const existing = relays.get(key);
  if (existing?.target === target) return existing.port;
  closeRelay(key);
  await new Promise<void>((resolve, reject) => {
    const probe = net.connect({ host, port: 6080 });
    const fail = () => {
      probe.destroy();
      reject(
        new Error(
          "The host cannot reach this owned desktop's internal display. Use the local Docker Engine on Ubuntu and check its bridge networking.",
        ),
      );
    };
    probe.once("error", fail);
    probe.setTimeout(2000, fail);
    probe.once("connect", () => {
      probe.destroy();
      resolve();
    });
  });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((incoming) => {
    const outgoing = net.connect({ host, port: 6080 });
    sockets.add(incoming);
    sockets.add(outgoing);
    incoming.on("error", () => outgoing.destroy());
    outgoing.on("error", () => incoming.destroy());
    incoming.on("close", () => {
      sockets.delete(incoming);
      outgoing.destroy();
    });
    outgoing.on("close", () => {
      sockets.delete(outgoing);
      incoming.destroy();
    });
    incoming.pipe(outgoing).pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.unref();
  server.on("error", () => closeRelay(key));
  const port = (server.address() as net.AddressInfo).port;
  relays.set(key, { target, port, server, sockets });
  return port;
}

async function relayPort(
  key: string,
  info: ContainerInfo,
  networkName: string,
): Promise<number> {
  return exclusive(`${key}:relay`, () => openRelay(key, info, networkName));
}

async function realDirectory(directory: string) {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Desktop metadata must use a real private directory.");
  await fs.chmod(directory, 0o700);
}

async function readPrivate(filename: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile())
      throw new Error("Desktop metadata must be a regular file.");
    return await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writePrivate(
  filename: string,
  contents: string,
  guestReadable = false,
) {
  const temporary = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
    if (guestReadable) {
      const user = computerUser();
      if (process.getuid?.() === 0) await handle.chown(user.uid, user.gid);
      await handle.chmod(0o400);
    }
  } finally {
    await handle.close();
  }
  try {
    // Rename replaces an unexpected link itself rather than following its target.
    await fs.rename(temporary, filename);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export class DesktopManager {
  readonly dataDir: string;
  private readonly owner: string;
  private readonly configuredImage: string | (() => string);
  private readonly relayKeys = new Set<string>();

  constructor(options: DesktopManagerOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.owner = desktopOwner(this.dataDir);
    this.configuredImage = options.image ?? DEFAULT_IMAGE;
  }

  /** Release the broker's display connections while preserving guest computers. */
  async close(): Promise<void> {
    for (const key of relays.keys()) {
      // Container names encode both data-directory owner and Dot ID.
      const relay = relays.get(key);
      if (relay && this.relayKeys.has(key)) closeRelay(key);
    }
    this.relayKeys.clear();
  }

  private image(): string {
    const image =
      typeof this.configuredImage === "function"
        ? this.configuredImage()
        : this.configuredImage;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image))
      throw new Error("Invalid graphical desktop image.");
    return image;
  }

  private labels(dotId: string): Record<string, string> {
    return {
      "cit-dots.managed": "true",
      "cit-dots.desktop": "true",
      "cit-dots.kind": "desktop",
      "cit-dots.desktop.owner": this.owner,
      "cit-dots.dot": dotId,
      "cit-dots.dot-id": dotId,
    };
  }

  private assertLabels(
    dotId: string,
    labels: Record<string, string> | undefined,
  ) {
    for (const [key, value] of Object.entries(this.labels(dotId)))
      if (labels?.[key] !== value)
        throw new Error(
          "A Docker resource with this desktop name belongs to another owner; refusing to attach or change it.",
        );
  }

  private metadataDirectory(computer: Computer): string {
    return path.join(path.dirname(computer.root), "desktop");
  }

  private async metadata(
    computer: Computer,
    create = false,
  ): Promise<DesktopMetadata | null> {
    const directory = this.metadataDirectory(computer);
    await realDirectory(directory);
    const filename = path.join(directory, "metadata.json");
    const raw = await readPrivate(filename);
    if (raw !== null) {
      let metadata: DesktopMetadata;
      try {
        metadata = JSON.parse(raw) as DesktopMetadata;
      } catch {
        throw new Error(
          "Desktop credentials are damaged; restore this Dot's private metadata before starting it.",
        );
      }
      if (
        metadata.dotId !== computer.dotId ||
        metadata.owner !== this.owner ||
        !/^[A-Za-z0-9_-]{8}$/.test(metadata.password)
      )
        throw new Error(
          "Desktop credential ownership does not match this Dot.",
        );
      return metadata;
    }
    if (!create) return null;
    const metadata: DesktopMetadata = {
      dotId: computer.dotId,
      owner: this.owner,
      password: randomBytes(6).toString("base64url"),
    };
    await writePrivate(filename, JSON.stringify(metadata));
    await writePrivate(
      path.join(directory, "vnc-password"),
      `${metadata.password}\n`,
      true,
    );
    return metadata;
  }

  private async ownedNetwork(dotId: string): Promise<NetworkInfo | null> {
    const info = await inspect<NetworkInfo>(
      "network",
      desktopNetworkName(this.dataDir, dotId),
    );
    if (info) {
      this.assertLabels(dotId, info.Labels);
      if (!info.Internal)
        throw new Error(
          "Desktop network is not internal; refusing an internet-enabled desktop.",
        );
    }
    return info;
  }

  private async ownedContainer(
    computer: Computer,
  ): Promise<ContainerInfo | null> {
    const info = await inspect<ContainerInfo>(
      "container",
      desktopContainerName(this.dataDir, computer.dotId),
    );
    if (!info) return null;
    this.assertLabels(computer.dotId, info.Config.Labels);
    const networkName = desktopNetworkName(this.dataDir, computer.dotId);
    const networks = Object.keys(info.NetworkSettings.Networks);
    if (
      info.HostConfig.NetworkMode !== networkName ||
      networks.length !== 1 ||
      networks[0] !== networkName
    )
      throw new Error("Desktop network ownership changed; refusing to attach.");
    if (!(await this.ownedNetwork(computer.dotId)))
      throw new Error("The desktop's owned internal network is missing.");
    if (
      !info.HostConfig.ReadonlyRootfs ||
      !info.HostConfig.CapDrop?.some((cap) => cap.toUpperCase() === "ALL") ||
      !info.HostConfig.SecurityOpt?.some((option) =>
        option.startsWith("no-new-privileges"),
      )
    )
      throw new Error(
        "Desktop isolation settings changed; refusing to attach.",
      );
    const { uid, gid } = computerUser();
    if (info.Config.User !== `${uid}:${gid}` || uid === 0)
      throw new Error(
        "Desktop must run as the private computer's non-root user.",
      );
    const expected = new Map([
      ["/home/cit", computer.home],
      ["/workspace", computer.workspace],
      ["/artifacts", computer.artifacts],
      [
        "/run/cit-secret/vnc-password",
        path.join(this.metadataDirectory(computer), "vnc-password"),
      ],
    ]);
    if (info.Mounts.length !== expected.size)
      throw new Error("Desktop mounts changed; refusing to attach.");
    for (const mount of info.Mounts) {
      if (
        expected.get(mount.Destination) !== mount.Source ||
        mount.RW !== (mount.Destination !== "/run/cit-secret/vnc-password")
      )
        throw new Error("Desktop mount ownership changed; refusing to attach.");
    }
    for (const bindings of [
      info.HostConfig.PortBindings,
      info.NetworkSettings.Ports,
    ]) {
      for (const [port, values] of Object.entries(bindings)) {
        if (
          values?.length &&
          (port !== "6080/tcp" ||
            values.some((binding) => binding.HostIp !== "127.0.0.1"))
        )
          throw new Error("Desktop port must be published only on localhost.");
      }
    }
    return info;
  }

  private async present(
    computer: Computer,
    info: ContainerInfo | null,
    metadata: DesktopMetadata | null,
  ): Promise<DesktopStatus> {
    const base = { dotId: computer.dotId, os: OS, url: null };
    if (!info || !info.State.Running) {
      closeRelay(desktopContainerName(this.dataDir, computer.dotId));
      if (info && info.State.ExitCode !== 0 && info.State.Status === "exited")
        return {
          ...base,
          state: "error",
          error:
            "The desktop stopped unexpectedly. Start it again or inspect the owned container's logs.",
        };
      return { ...base, state: "stopped" };
    }
    if (info.State.Health?.Status === "unhealthy")
      return {
        ...base,
        state: "error",
        error:
          "The graphical desktop is not responding. Stop it and start it again.",
      };
    if (info.State.Health?.Status !== "healthy")
      return { ...base, state: "starting" };
    if (!metadata)
      return {
        ...base,
        state: "error",
        error:
          "This running desktop's private credentials are missing. Restore its metadata.",
      };
    const relayKey = desktopContainerName(this.dataDir, computer.dotId);
    this.relayKeys.add(relayKey);
    const port = await relayPort(
      relayKey,
      info,
      desktopNetworkName(this.dataDir, computer.dotId),
    );
    const url = new URL(`http://127.0.0.1:${port}/vnc.html`);
    url.search = new URLSearchParams({
      autoconnect: "true",
      resize: "remote",
      path: "websockify",
    }).toString();
    // noVNC reads fragment options too. The password never enters HTTP access logs.
    url.hash = new URLSearchParams({ password: metadata.password }).toString();
    return {
      dotId: computer.dotId,
      os: OS,
      state: "running",
      url: url.toString(),
    };
  }

  private failure(dotId: string, error: unknown): DesktopStatus {
    const key = desktopContainerName(this.dataDir, dotId);
    closeRelay(key);
    this.relayKeys.delete(key);
    return {
      dotId,
      os: OS,
      state: "error",
      url: null,
      error:
        error instanceof Error
          ? error.message
          : "The graphical desktop could not be started.",
    };
  }

  async status(dotId: string): Promise<DesktopStatus> {
    validateId(dotId);
    try {
      const computer = await ensureComputer(this.dataDir, dotId);
      return await this.present(
        computer,
        await this.ownedContainer(computer),
        await this.metadata(computer),
      );
    } catch (error) {
      return this.failure(dotId, error);
    }
  }

  /** Return only a validated owned running container for broker-issued tools. */
  async containerName(dotId: string): Promise<string | null> {
    validateId(dotId);
    const computer = await ensureComputer(this.dataDir, dotId);
    const info = await this.ownedContainer(computer);
    return info?.State.Running && info.State.Health?.Status === "healthy"
      ? desktopContainerName(this.dataDir, dotId)
      : null;
  }

  async start(dotId: string): Promise<DesktopStatus> {
    validateId(dotId);
    return exclusive(desktopContainerName(this.dataDir, dotId), async () => {
      try {
        const computer = await ensureComputer(this.dataDir, dotId);
        if (
          [
            computer.home,
            computer.workspace,
            computer.artifacts,
            this.dataDir,
          ].some((value) => value.includes(","))
        )
          throw new Error(
            "Computer paths contain an unsupported Docker mount delimiter.",
          );
        const image = this.image();
        let info = await this.ownedContainer(computer);
        const metadata = await this.metadata(computer, !info);
        if (!metadata)
          throw new Error(
            "Desktop credentials are missing; restore this Dot's private metadata before restarting it.",
          );
        if (info && !info.State.Running) {
          let imageId: string;
          try {
            imageId = (
              await docker(["image", "inspect", "--format", "{{.Id}}", image])
            ).trim();
          } catch {
            throw new Error(
              `The desktop image ${image} is unavailable. Build it with: docker build -t ${image} -f desktop/Dockerfile .`,
            );
          }
          // A rebuilt tag takes effect after an explicit stop/start; active
          // desktops are reattached intact rather than destroyed by an update.
          if (info.Config.Image !== image || info.Image !== imageId) {
            await docker(["container", "rm", info.Id]);
            info = null;
          }
        }
        if (!info) {
          try {
            await docker(["image", "inspect", image]);
          } catch {
            throw new Error(
              `The desktop image ${image} is unavailable. Build it with: docker build -t ${image} -f desktop/Dockerfile .`,
            );
          }
          if (!(await this.ownedNetwork(dotId))) {
            const args = [
              "network",
              "create",
              "--internal",
              "--driver",
              "bridge",
            ];
            for (const [key, value] of Object.entries(this.labels(dotId)))
              args.push("--label", `${key}=${value}`);
            args.push(desktopNetworkName(this.dataDir, dotId));
            await docker(args);
          }
          const { uid, gid } = computerUser();
          const args = [
            "container",
            "create",
            "--name",
            desktopContainerName(this.dataDir, dotId),
            "--init",
            "--restart",
            "unless-stopped",
            "--network",
            desktopNetworkName(this.dataDir, dotId),
            "--dns",
            "127.0.0.1",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--pids-limit",
            "512",
            "--memory",
            "4g",
            "--memory-swap",
            "4g",
            "--cpus",
            "2",
            "--shm-size",
            "256m",
            "--ulimit",
            "nofile=4096:4096",
            "--user",
            `${uid}:${gid}`,
            "--mount",
            `type=bind,src=${computer.home},dst=/home/cit`,
            "--mount",
            `type=bind,src=${computer.workspace},dst=/workspace`,
            "--mount",
            `type=bind,src=${computer.artifacts},dst=/artifacts`,
            "--mount",
            `type=bind,src=${path.join(this.metadataDirectory(computer), "vnc-password")},dst=/run/cit-secret/vnc-password,readonly`,
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
            "--tmpfs",
            "/run:rw,nosuid,nodev,size=32m,mode=755",
            "--env",
            "CIT_ARTIFACTS_DIR=/artifacts",
          ];
          for (const key of [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
          ])
            args.push("--env", `${key}=`);
          for (const [key, value] of Object.entries(this.labels(dotId)))
            args.push("--label", `${key}=${value}`);
          args.push(image);
          await docker(args);
        }
        const name = desktopContainerName(this.dataDir, dotId);
        if (!info?.State.Running) await docker(["container", "start", name]);
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          const current = await this.ownedContainer(computer);
          const state = await this.present(computer, current, metadata);
          if (
            state.state === "running" ||
            state.state === "error" ||
            !current?.State.Running
          )
            return state;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { dotId, os: OS, state: "starting", url: null };
      } catch (error) {
        return this.failure(dotId, error);
      }
    });
  }

  async stop(dotId: string): Promise<DesktopStatus> {
    validateId(dotId);
    return exclusive(desktopContainerName(this.dataDir, dotId), async () => {
      try {
        const computer = await ensureComputer(this.dataDir, dotId);
        const info = await this.ownedContainer(computer);
        if (info?.State.Running)
          await docker(["container", "stop", "--time", "10", info.Id], 15_000);
        closeRelay(desktopContainerName(this.dataDir, dotId));
        return { dotId, os: OS, state: "stopped", url: null };
      } catch (error) {
        return this.failure(dotId, error);
      }
    });
  }

  /** Remove Docker runtime resources only; the broker owns Dot/file deletion. */
  async remove(dotId: string): Promise<DesktopStatus> {
    validateId(dotId);
    return exclusive(desktopContainerName(this.dataDir, dotId), async () => {
      try {
        const computer = await ensureComputer(this.dataDir, dotId);
        const info = await this.ownedContainer(computer);
        const network = await this.ownedNetwork(dotId);
        if (info) await docker(["container", "rm", "--force", info.Id], 15_000);
        if (network) await docker(["network", "rm", network.Id]);
        closeRelay(desktopContainerName(this.dataDir, dotId));
        return { dotId, os: OS, state: "stopped", url: null };
      } catch (error) {
        return this.failure(dotId, error);
      }
    });
  }
}
