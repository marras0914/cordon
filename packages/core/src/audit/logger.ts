import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import type { AuditConfig, AuditOutputType } from 'cordon-sdk';

// ── Audit entry types ─────────────────────────────────────────────────────────

export type AuditEventType =
  | 'gateway_started'
  | 'gateway_stopped'
  | 'upstream_connected'
  | 'upstream_error'
  | 'tool_call_received'
  | 'tool_call_blocked'
  | 'tool_call_allowed'
  | 'approval_requested'
  | 'tool_call_approved'
  | 'tool_call_denied'
  | 'tool_call_completed'
  | 'tool_call_errored';

export interface AuditEntry {
  event: AuditEventType;
  timestamp: number;
  callId?: string;
  serverName?: string;
  toolName?: string;
  proxyName?: string;
  args?: unknown;
  isError?: boolean;
  reason?: string;
  error?: string;
  servers?: string[];
  durationMs?: number;
}

// ── Output implementations ────────────────────────────────────────────────────

interface AuditOutput {
  write(entry: AuditEntry): void;
  close?(): void;
}

class StderrAuditOutput implements AuditOutput {
  write(entry: AuditEntry): void {
    // Always write to stderr — stdout belongs to the MCP transport
    process.stderr.write(JSON.stringify(entry) + '\n');
  }
}

class HostedAuditOutput implements AuditOutput {
  private queue: AuditEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly flushIntervalMs = 2000;
  private readonly maxBatchSize = 100;

  constructor(endpoint: string, apiKey: string) {
    this.endpoint = endpoint.replace(/\/$/, '') + '/events';
    this.apiKey = apiKey;
  }

  write(entry: AuditEntry): void {
    this.queue.push(entry);
    if (this.queue.length >= this.maxBatchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cordon-Key': this.apiKey,
      },
      body: JSON.stringify(batch),
    }).catch((err) => {
      process.stderr.write(`[cordon] hosted audit error: ${err.message}\n`);
    });
  }

  close(): void {
    this.flush();
  }
}

class FileAuditOutput implements AuditOutput {
  private stream: WriteStream;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', (err) => {
      process.stderr.write(`[cordon] audit file error: ${err.message}\n`);
    });
  }

  write(entry: AuditEntry): void {
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  close(): void {
    this.stream.end();
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────

export class AuditLogger {
  private outputs: AuditOutput[];

  constructor(config: AuditConfig | undefined) {
    if (!config?.enabled) {
      this.outputs = [];
      return;
    }

    const targets = config.output
      ? Array.isArray(config.output)
        ? config.output
        : [config.output]
      : (['stdout'] as AuditOutputType[]);

    this.outputs = targets.map((t) => this.buildOutput(t, config));
  }

  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    const full: AuditEntry = { ...entry, timestamp: Date.now() };
    for (const output of this.outputs) {
      output.write(full);
    }
  }

  close(): void {
    for (const output of this.outputs) {
      output.close?.();
    }
  }

  private buildOutput(type: AuditOutputType, config: AuditConfig): AuditOutput {
    switch (type) {
      case 'stdout':
        return new StderrAuditOutput();
      case 'file':
        return new FileAuditOutput(config.filePath ?? './cordon-audit.log');
      case 'hosted': {
        const { endpoint, apiKey } = config;
        if (!endpoint || !apiKey) {
          process.stderr.write(
            `[cordon] warn: audit output 'hosted' requires endpoint and apiKey — falling back to stdout\n`,
          );
          return new StderrAuditOutput();
        }
        return new HostedAuditOutput(endpoint, apiKey);
      }
      case 'otlp':
      case 'webhook':
        // v2 — fall back to stderr for now
        process.stderr.write(
          `[cordon] warn: audit output '${type}' not yet implemented, falling back to stdout\n`,
        );
        return new StderrAuditOutput();
    }
  }
}
