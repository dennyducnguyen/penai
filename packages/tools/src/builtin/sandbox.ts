import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const schema = z.object({
  code: z.string().min(1).describe("Mã cần chạy."),
  language: z.enum(["python", "node", "bash"]).default("python"),
});

/* eslint-disable @typescript-eslint/no-explicit-any */
interface DockerLike {
  ping(): Promise<unknown>;
  createContainer(opts: any): Promise<any>;
}

const IMAGES: Record<string, { image: string; cmd: (code: string) => string[] }> = {
  python: { image: "python:3.12-slim", cmd: (c) => ["python", "-c", c] },
  node: { image: "node:22-slim", cmd: (c) => ["node", "-e", c] },
  bash: { image: "debian:stable-slim", cmd: (c) => ["bash", "-c", c] },
};

/**
 * Chạy code trong container Docker cô lập (dockerode). Cần Docker daemon.
 * Không có mạng, giới hạn thời gian, tự xóa container. Cần approval.
 * Nếu không có Docker → trả lỗi rõ ràng (không crash).
 */
export const sandboxTool: ToolHandler<typeof schema> = {
  name: "sandbox_exec",
  description:
    "Chạy đoạn code (python/node/bash) trong sandbox Docker cô lập, không có mạng.",
  schema,
  async execute(args, toolCtx) {
    if (toolCtx.requestApproval) {
      const ok = await toolCtx.requestApproval({
        tool: "sandbox_exec",
        summary: `chạy ${args.language}`,
        detail: args.code.slice(0, 200),
      });
      if (!ok) throw new Error("Chưa được phê duyệt");
    } else {
      throw new Error("sandbox_exec cần phê duyệt");
    }

    // dockerode không có type declaration → dùng any (dynamic import)
    let Docker: new () => DockerLike;
    try {
      Docker = ((await import("dockerode")) as { default: unknown }).default as new () => DockerLike;
    } catch {
      throw new Error("dockerode không nạp được");
    }
    const docker = new Docker();
    try {
      await docker.ping();
    } catch {
      throw new Error("Docker daemon không chạy — không dùng được sandbox");
    }

    const spec = IMAGES[args.language]!;
    const chunks: Buffer[] = [];
    const container = await docker.createContainer({
      Image: spec.image,
      Cmd: spec.cmd(args.code),
      HostConfig: {
        NetworkMode: "none",
        Memory: 256 * 1024 * 1024,
        AutoRemove: false,
      },
      Tty: false,
    });
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      stream.on("data", (d: Buffer) => chunks.push(d));
      await container.start();
      const timeout = setTimeout(() => container.kill().catch(() => {}), 20_000);
      await container.wait();
      clearTimeout(timeout);
      const out = Buffer.concat(chunks).toString("utf8").replace(/[^\x09\x0a\x0d\x20-\x7e -￿]/g, "");
      return out.slice(0, 16_000).trim() || "(không có output)";
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  },
};
