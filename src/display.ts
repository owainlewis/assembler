import { stripVTControlCharacters } from "node:util";
import { createLogUpdate } from "log-update";
import type { Row, RunRecord } from "./index.js";

export const plain = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export function formatRow(row: Row, now = Date.now()): string {
  const icon = row.status === "passed" ? "✓" : row.status === "failed" ? "✗" : "↻";
  const seconds = Math.floor((row.durationMs ?? now - row.started) / 1000);
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return `${icon} ${plain(row.name).replace(/[\r\n]/g, " ").slice(0, 60).padEnd(24)} ${duration}`;
}

export function progress(enabled: boolean, live = Boolean(process.stderr.isTTY)) {
  const render = createLogUpdate(process.stderr, { showCursor: true });
  const seen = new Map<string, string>();
  let rows: Row[] = [];
  const draw = () => {
    if (enabled && live && rows.length) render(rows.map(row => {
      const color = row.status === "passed" ? "\x1b[32m" : row.status === "failed" ? "\x1b[31m" : "\x1b[36m";
      return color + formatRow(row) + "\x1b[0m";
    }).join("\n"));
  };
  const timer = enabled && live ? setInterval(draw, 1000) : undefined;
  return {
    update(next: Row[]) {
      rows = next;
      if (!enabled) return;
      if (live) draw();
      else for (const row of rows) {
        if (seen.get(row.id) !== row.status) { process.stderr.write(formatRow(row) + "\n"); seen.set(row.id, row.status); }
      }
    },
    message(text: string) {
      if (enabled && live) render.clear();
      process.stderr.write(plain(text) + "\n");
      draw();
    },
    finish() { if (timer) clearInterval(timer); if (enabled && live) render.done(); },
  };
}

export function formatOutputs(record: RunRecord): string {
  return record.outputs.map(output => {
    const text = plain(typeof output.value === "string" ? output.value : JSON.stringify(output.value, null, 2));
    const lines = text.split("\n");
    const excerpt = lines.slice(0, 20).join("\n").slice(0, 2000);
    return `\n${plain(output.name).replace(/[\r\n]/g, " ")}\n${excerpt}${excerpt.length < text.length ? `\n… Full output: ${output.path}` : ""}\n`;
  }).join("");
}
