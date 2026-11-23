import fs from "node:fs";

import {
  parseDeliveryMode,
  sendMessage as coreSendMessage,
  type ChannelScope,
  type UndeliverableChannelEvent,
} from "@mindfoldhq/trellis-core/channel";

import { appendEvent, readChannelEvents } from "./store/events.js";
import { resolveExistingChannelRef, workerFile } from "./store/paths.js";
import { parseChannelScope, parseCsv } from "./store/schema.js";
import { resolveChannelTextBody } from "./text-body.js";

export interface SendOptions {
  as: string;
  text?: string;
  stdin?: boolean;
  textFile?: string;
  scope?: string;
  to?: string; // CSV
  deliveryMode?: string;
}

interface DeliveryFailure {
  targetWorker: string;
  reason: string;
  deadPid?: number;
}

export async function channelSend(
  channelName: string,
  opts: SendOptions,
): Promise<void> {
  const text = await resolveChannelTextBody(opts, {
    required: true,
    missingMessage:
      "No text provided (use <text> arg, --stdin, or --text-file)",
    emptyMessage: "Empty message",
  });
  const to = parseCsv(opts.to);
  const scope: ChannelScope | undefined = parseChannelScope(opts.scope);
  const deliveryMode = parseDeliveryMode(opts.deliveryMode);

  const event = await coreSendMessage({
    channel: channelName,
    by: opts.as,
    text: text as string,
    ...(scope !== undefined ? { scope } : {}),
    ...(to !== undefined ? { to: to.length === 1 ? to[0] : to } : {}),
    ...(deliveryMode !== undefined ? { deliveryMode } : {}),
    origin: "cli",
  });

  if (deliveryMode && deliveryMode !== "appendOnly" && event.to !== undefined) {
    const ref = resolveExistingChannelRef(channelName, { scope });
    const events = await readChannelEvents(channelName, ref.project);
    const failures: DeliveryFailure[] = events
      .filter(
        (ev): ev is UndeliverableChannelEvent =>
          ev.kind === "undeliverable" && ev.messageSeq === event.seq,
      )
      .map((ev) => ({
        targetWorker: ev.targetWorker,
        reason: ev.reason,
      }));

    if (deliveryMode === "requireRunningWorker") {
      const failedWorkers = new Set(failures.map((f) => f.targetWorker));
      const targets = Array.isArray(event.to) ? event.to : [event.to];
      for (const target of targets) {
        if (failedWorkers.has(target)) continue;
        const pid = readWorkerPid(channelName, target, ref.project);
        if (pid !== undefined && !processAlive(pid)) {
          await appendEvent(
            channelName,
            {
              kind: "undeliverable",
              by: opts.as,
              targetWorker: target,
              messageSeq: event.seq,
              reason: "worker-terminal",
              origin: "cli",
              detail: {
                cause: "supervisor-process-dead",
                supervisorPid: pid,
              },
            },
            ref.project,
          );
          failures.push({
            targetWorker: target,
            reason: "supervisor-process-dead",
            deadPid: pid,
          });
        }
      }
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) =>
          f.deadPid !== undefined
            ? `${f.targetWorker} (supervisor pid ${f.deadPid} is no longer running)`
            : `${f.targetWorker} (${f.reason})`,
        )
        .join(", ");
      const hasDeadSupervisor = failures.some((f) => f.deadPid !== undefined);
      const hint =
        hasDeadSupervisor && process.platform === "win32"
          ? " On Windows shells that reap detached processes when a command exits, run `trellis channel spawn --foreground` as a background task or use `trellis channel run`."
          : "";
      throw new Error(
        `Message #${event.seq} is undeliverable under delivery-mode '${deliveryMode}': ${summary}.${hint}`,
      );
    }
  }

  console.log(JSON.stringify(event));
}

function readWorkerPid(
  channelName: string,
  worker: string,
  project: string,
): number | undefined {
  let pidPath: string;
  try {
    pidPath = workerFile(channelName, worker, "pid", project);
  } catch {
    return undefined;
  }
  if (!fs.existsSync(pidPath)) return undefined;
  try {
    const raw = fs.readFileSync(pidPath, "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
