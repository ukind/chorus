/**
 * Buffered append-writer for live LLM streaming.
 *
 * Why this exists: the previous implementation called fs.appendFileSync on
 * every text_delta event from the CLI shim. A typical Opus run emits ~5
 * deltas/sec for ~5 minutes = ~1500 sync disk writes per doer, each one
 * blocking the daemon event loop. Worse, the cockpit polls answer.md every
 * 8s — it doesn't benefit from per-delta granularity.
 *
 * Now we flush whenever the buffer crosses 4KB OR a 750ms quiet timer
 * fires, whichever comes first. Cockpit poll cadence is unchanged but
 * the daemon does ~50 writes per run instead of ~1500.
 *
 * Caller MUST call flushNow() before any direct read of `path` or before
 * fs.writeFileSync overwrites it — the buffer is otherwise lost.
 */
import * as fs from 'fs';

export class StreamFileWriter {
  private buf = '';
  private flushTimer: NodeJS.Timeout | null = null;
  constructor(
    private readonly filePath: string,
    private readonly flushBytes = 4096,
    private readonly flushMs = 750,
  ) {}

  write(chunk: string): void {
    if (!chunk) return;
    this.buf += chunk;
    if (this.buf.length >= this.flushBytes) {
      this.flushNow();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushNow(), this.flushMs);
    }
  }

  flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buf.length === 0) return;
    try {
      fs.appendFileSync(this.filePath, this.buf);
    } finally {
      this.buf = '';
    }
  }
}
