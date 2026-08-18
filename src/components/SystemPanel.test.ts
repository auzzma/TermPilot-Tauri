import { describe, expect, it } from "vitest";

import {
  dockerImageSelectionId,
  dockerInspectKey,
  dockerInteractiveCommand,
  nextDockerInspectKey,
  parseDocker,
  parseDockerInspect,
  parseOverview,
  parseProcesses,
  sanitizeContainerName,
  sanitizeDockerId,
  sanitizeImageReference,
  shouldUseWindowsSystemCommands,
} from "./SystemPanel";

describe("Docker commands", () => {
  it("toggles inline inspect rows like the Swift implementation", () => {
    const containerKey = dockerInspectKey("container", "container-1");
    const imageKey = dockerInspectKey(
      "image",
      dockerImageSelectionId({
        id: "image-1",
        repository: "app",
        tag: "latest",
      }),
    );

    expect(nextDockerInspectKey(undefined, containerKey)).toBe(containerKey);
    expect(nextDockerInspectKey(containerKey, containerKey)).toBeUndefined();
    expect(nextDockerInspectKey(containerKey, imageKey)).toBe(imageKey);
  });

  it("sanitizes Docker identifiers and names like the Swift implementation", () => {
    expect(sanitizeDockerId("sha256:abc-123")).toBe("abc123");
    expect(sanitizeDockerId("---")).toBeUndefined();
    expect(sanitizeContainerName(" api server! ")).toBe("apiserver");
    expect(sanitizeImageReference("registry:5000/app:")).toBe(
      "registry:5000/app:latest",
    );
  });

  it("builds normal, sudo, and su interactive commands", () => {
    const normal = dockerInteractiveCommand("abc123", "logs", {
      username: "deploy",
      serverToolsUseRoot: false,
      serverToolsElevationMethod: "sudo",
    });
    expect(normal).toContain("exec docker logs -f --tail 200 abc123");

    const sudo = dockerInteractiveCommand("abc123", "shell", {
      username: "deploy",
      serverToolsUseRoot: true,
      serverToolsElevationMethod: "sudo",
    });
    expect(sudo).toContain("sudo -H -S -k");
    expect(sudo).toContain("docker exec -it abc123");

    const su = dockerInteractiveCommand("abc123", "logs", {
      username: "deploy",
      serverToolsUseRoot: true,
      serverToolsElevationMethod: "su",
    });
    expect(su).toContain("su - root -c");
  });
});

describe("system overview", () => {
  it("uses Windows probes only for local Windows sessions", () => {
    expect(shouldUseWindowsSystemCommands("windows", false)).toBe(true);
    expect(shouldUseWindowsSystemCommands("windows", true)).toBe(false);
    expect(shouldUseWindowsSystemCommands("macos", false)).toBe(false);
  });

  it("calculates CPU and network rates from consecutive samples", () => {
    const first = parseOverview(
      [
        "server",
        "Linux",
        "6.8",
        "up 1 hour",
        "CPU",
        "1 2 3",
        "1000 400",
        "1000 400 300 100 4",
        "10000 20000",
        "__DISK__|/|500|1000|50",
        "__NETIF__|eth0|10000|20000",
        "__SWAP__|10 MB / 100 MB",
        "__TOPPROC__|42|12.5|node",
      ].join("\n"),
      undefined,
      1_000,
    );
    const second = parseOverview(
      [
        "server",
        "Linux",
        "6.8",
        "up 1 hour",
        "CPU",
        "1 2 3",
        "1000 400",
        "1200 450 350 120 4",
        "12000 23000",
        "__DISK__|/|600|1000|60",
        "__NETIF__|eth0|12000|23000",
        "__SWAP__|20 MB / 100 MB",
        "__TOPPROC__|42|13.5|node",
      ].join("\n"),
      first.sample,
      3_000,
    );

    expect(second.overview.cpuUsage).toBe(75);
    expect(second.overview.cpuUserUsage).toBe(25);
    expect(second.overview.cpuSystemUsage).toBe(10);
    expect(second.overview.cpuCoreCount).toBe(4);
    expect(second.overview.networkRxPerSecond).toBe(1000);
    expect(second.overview.networkTxPerSecond).toBe(1500);
    expect(second.overview.disks[0]).toEqual({
      mount: "/",
      used: 600,
      total: 1000,
      percent: 60,
    });
    expect(second.overview.networkInterfaces[0]).toEqual({
      name: "eth0",
      rxPerSecond: 1000,
      txPerSecond: 1500,
    });
    expect(second.overview.swap).toBe("20 MB / 100 MB");
    expect(second.overview.topMemoryProcesses[0]).toEqual({
      pid: 42,
      memoryPercent: 13.5,
      command: "node",
    });
  });

  it("ignores empty interface names and starts a new sample at zero", () => {
    const parsed = parseOverview(
      [
        "server",
        "Linux",
        "6.8",
        "up 1 hour",
        "arm64",
        "0 0 0",
        "1000 400",
        "1000 400",
        "999999 888888",
        "__NETIF__||999999|888888",
        "__NETIF__|eth0|999999|888888",
      ].join("\n"),
      undefined,
      1_000,
    );

    expect(parsed.overview.networkRxPerSecond).toBe(0);
    expect(parsed.overview.networkTxPerSecond).toBe(0);
    expect(parsed.overview.networkInterfaces).toEqual([
      { name: "eth0", rxPerSecond: 0, txPerSecond: 0 },
    ]);
  });

  it("parses full process rows and preserves commands with spaces", () => {
    expect(
      parseProcesses(
        "42 1 deploy R 12.5 3.2 2048 4096 01:02 node server.js --port 80\ninvalid",
      ),
    ).toEqual([
      {
        pid: 42,
        ppid: 1,
        user: "deploy",
        stat: "R",
        cpuPercent: 12.5,
        memPercent: 3.2,
        rssKB: 2048,
        vszKB: 4096,
        elapsed: "01:02",
        command: "node server.js --port 80",
      },
    ]);
  });
});

describe("Docker parsing", () => {
  it("parses container and image rows while ignoring invalid lines", () => {
    const result = parseDocker(
      [
        "__CONTAINERS__",
        '{"id":"c1","name":"api","image":"app","status":"Up","state":"running","ports":""}',
        "invalid",
        "__IMAGES__",
        '{"id":"i1","repository":"app","tag":"latest","size":"10MB","createdAt":"2 days ago"}',
      ].join("\n"),
    );

    expect(result.containers).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      id: "i1",
      createdAt: "2 days ago",
    });
  });

  it("extracts structured container inspect details", () => {
    const details = parseDockerInspect(
      JSON.stringify([
        {
          Id: "sha256:abcdef1234567890",
          State: { Status: "running", StartedAt: "today" },
          Config: {
            Image: "app:latest",
            Env: ["NODE_ENV=production"],
            Labels: { service: "api" },
          },
          HostConfig: { RestartPolicy: { Name: "always" } },
          Path: "node",
          Args: ["server.js"],
          NetworkSettings: {
            Ports: { "80/tcp": [{ HostPort: "8080" }] },
            Networks: { bridge: {} },
          },
          Mounts: [
            {
              Source: "/data",
              Destination: "/app/data",
              Type: "bind",
            },
          ],
        },
      ]),
      "container",
    );

    expect(details.fields).toContainEqual({
      label: "ID",
      value: "abcdef123456",
      monospaced: true,
    });
    expect(details.fields).toContainEqual({
      label: "Command",
      value: "node server.js",
      monospaced: true,
    });
    expect(details.lists.find((item) => item.label === "Networks")?.values)
      .toEqual(["bridge"]);
  });
});
