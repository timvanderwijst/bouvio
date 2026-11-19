export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  old?: number;
  new?: number;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

/** Parse `git diff` output into files, hunks and numbered lines. */
export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let o = 0;
  let n = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.+)$/);
      file = { path: m ? m[1] : line.slice(11), adds: 0, dels: 0, hunks: [] };
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      o = m ? +m[1] : 0;
      n = m ? +m[2] : 0;
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (!hunk) {
      continue;
    } else if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), new: n++ });
      file.adds++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), old: o++ });
      file.dels++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++ });
    }
  }
  return files;
}
