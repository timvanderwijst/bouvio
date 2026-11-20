// ProseMirror JSON (TipTap StarterKit + tasks + links) to Markdown. Pure.

export interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, any> }[];
}

function inline(nodes: PMNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === "hardBreak") return "  \n";
      if (n.type !== "text") return "";
      let s = n.text ?? "";
      const marks = n.marks ?? [];
      const has = (t: string) => marks.some((m) => m.type === t);
      if (has("code")) s = "`" + s + "`";
      else {
        s = s.replace(/([*_`\\[\]])/g, "\\$1");
        if (has("bold")) s = `**${s}**`;
        if (has("italic")) s = `*${s}*`;
        if (has("strike")) s = `~~${s}~~`;
      }
      const link = marks.find((m) => m.type === "link");
      if (link) s = `[${s}](${link.attrs?.href ?? ""})`;
      return s;
    })
    .join("");
}

const indent = (s: string, pad: string) =>
  s
    .split("\n")
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join("\n");

function block(n: PMNode): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case "paragraph":
      return inline(kids);
    case "heading":
      return `${"#".repeat(n.attrs?.level ?? 1)} ${inline(kids)}`;
    case "blockquote":
      return blocks(kids)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "codeBlock":
      return "```" + (n.attrs?.language ?? "") + "\n" + kids.map((k) => k.text ?? "").join("") + "\n```";
    case "horizontalRule":
      return "---";
    case "bulletList":
      return kids.map((li) => "- " + indent(blocks(li.content ?? []), "  ")).join("\n");
    case "orderedList": {
      const start = n.attrs?.start ?? 1;
      return kids.map((li, i) => `${start + i}. ` + indent(blocks(li.content ?? []), "   ")).join("\n");
    }
    case "taskList":
      return kids.map((li) => `- [${li.attrs?.checked ? "x" : " "}] ` + indent(blocks(li.content ?? []), "  ")).join("\n");
    default:
      return kids.length ? blocks(kids) : inline([n]);
  }
}

function blocks(nodes: PMNode[]): string {
  // Lists inside list items stay tight; other blocks get a blank line.
  return nodes.map(block).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

export function toMarkdown(doc: PMNode, title?: string): string {
  const body = blocks(doc.content ?? []).trim();
  return (title ? `# ${title}\n\n` : "") + body + "\n";
}

/** Plain text of a doc, for an agent's context. */
export function toPlain(doc: PMNode): string {
  const walk = (n: PMNode): string => (n.text ?? "") + (n.content ?? []).map(walk).join(n.type === "doc" || n.type.endsWith("List") ? "\n" : "");
  return walk(doc).trim();
}
