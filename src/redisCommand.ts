export interface CommandLine {
  text: string;
  start: number;
  end: number;
}

/** Non-blank, non-comment lines (# or //), each one command like redis-cli. */
export function splitCommands(text: string): CommandLine[] {
  const out: CommandLine[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
      const start = offset + line.indexOf(trimmed);
      out.push({ text: trimmed, start, end: start + trimmed.length });
    }
    offset += raw.length + 1;
  }
  return out;
}

/** Command under the cursor: the one on its line, else the closest one before it. */
export function commandAt(commands: CommandLine[], text: string, offset: number): CommandLine | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const nl = text.indexOf('\n', offset);
  const lineEnd = nl < 0 ? text.length : nl;
  const onLine = commands.find((c) => c.start >= lineStart && c.start <= lineEnd);
  if (onLine) return onLine;
  let found: CommandLine | undefined;
  for (const c of commands) {
    if (c.start < offset) found = c;
    else break;
  }
  return found ?? commands[0];
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07', '"': '"', '\\': '\\' };

/**
 * Splits a command into arguments with redis-cli quoting rules. Typed text is
 * UTF-8; "\xHH" inside double quotes is one raw byte, so binary values can be written.
 */
export function tokenizeBuffers(line: string): Buffer[] {
  const args: Buffer[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const parts: Buffer[] = [];
    let text = '';
    const flush = () => {
      if (text) parts.push(Buffer.from(text, 'utf8'));
      text = '';
    };
    const q = line[i];
    if (q === '"' || q === "'") {
      i++;
      let closed = false;
      while (i < line.length) {
        const c = line[i];
        if (q === '"' && c === '\\' && i + 1 < line.length) {
          const n = line[i + 1];
          if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            flush();
            parts.push(Buffer.from([parseInt(line.slice(i + 2, i + 4), 16)]));
            i += 4;
          } else {
            text += ESCAPES[n] ?? n;
            i += 2;
          }
          continue;
        }
        if (q === "'" && c === '\\' && line[i + 1] === "'") {
          text += "'";
          i += 2;
          continue;
        }
        if (c === q) {
          closed = true;
          i++;
          break;
        }
        text += c;
        i++;
      }
      if (!closed) throw new Error(`Unbalanced quotes in: ${line}`);
      if (i < line.length && !/\s/.test(line[i])) throw new Error(`Closing quote must be followed by a space in: ${line}`);
    } else {
      while (i < line.length && !/\s/.test(line[i])) text += line[i++];
    }
    flush();
    args.push(Buffer.concat(parts));
  }
  return args;
}

/** Same as tokenizeBuffers, as text (raw bytes above 0x7f are not valid UTF-8 on their own). */
export function tokenize(line: string): string[] {
  return tokenizeBuffers(line).map((b) => b.toString('utf8'));
}

/** Commands that wipe or stop things; confirmed before running. */
export function isDestructiveCommand(args: string[]): boolean {
  const cmd = (args[0] ?? '').toUpperCase();
  return ['FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'SWAPDB'].includes(cmd) || (cmd === 'DEBUG' && /^(sleep|segfault|reload|crash)/i.test(args[1] ?? '')) || (cmd === 'CONFIG' && /^set$/i.test(args[1] ?? ''));
}
