import { EventEmitter } from "node:events";
import { JsonlEventLog } from "../shared/logging.js";
import type { ConductorEvent } from "../shared/types.js";

export type SessionEvent = ConductorEvent;

export interface SessionEventSink {
  readonly path?: string;
  append(event: SessionEvent): Promise<void>;
}

export class JsonlSessionEventSink implements SessionEventSink {
  constructor(private readonly log: JsonlEventLog) {}

  get path(): string {
    return this.log.path;
  }

  async append(event: SessionEvent): Promise<void> {
    await this.log.append(event);
  }
}

export class CompositeSessionEventSink implements SessionEventSink {
  constructor(private readonly sinks: SessionEventSink[]) {}

  get path(): string | undefined {
    return this.sinks.find((sink) => sink.path)?.path;
  }

  async append(event: SessionEvent): Promise<void> {
    for (const sink of this.sinks) await sink.append(event);
  }
}

/** In-process "something happened" doorbell; the JSONL log is the source of truth. */
export class SessionEventBus extends EventEmitter implements SessionEventSink {
  append(event: SessionEvent): Promise<void> {
    this.emit("event", event);
    return Promise.resolve();
  }
}
