import Collaboration from "@tiptap/extension-collaboration";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Plugin } from "@tiptap/pm/state";
import { BubbleMenu, EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  FileDown,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Printer,
  Quote,
  Sparkles,
  SquareCode,
  Strikethrough,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { yCursorPlugin } from "y-prosemirror";
import { t, useT } from "../../i18n";
import { AskDialog } from "./AskAgent";
import { download, fileSafe, printOnly } from "./common";
import type { EditorProps } from "./DocPage";
import { toMarkdown, toPlain, type PMNode } from "./markdown";
import type { Session } from "./sync";

interface SlashItem {
  id: string;
  label: string;
  keys: string;
  icon: LucideIcon;
  run: (e: Editor) => void;
}

const SLASH: SlashItem[] = [
  { id: "h1", label: "office.slash.h1", keys: "heading title h1", icon: Heading1, run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { id: "h2", label: "office.slash.h2", keys: "heading h2", icon: Heading2, run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { id: "h3", label: "office.slash.h3", keys: "heading h3", icon: Heading3, run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { id: "ul", label: "office.slash.bullets", keys: "bullet list ul", icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ol", label: "office.slash.numbers", keys: "numbered ordered list ol", icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "todo", label: "office.slash.todo", keys: "todo task check", icon: ListChecks, run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: "quote", label: "office.slash.quote", keys: "quote blockquote", icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "office.slash.code", keys: "code block", icon: SquareCode, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: "hr", label: "office.slash.divider", keys: "divider rule hr line", icon: Minus, run: (e) => e.chain().focus().setHorizontalRule().run() },
];
const ASK: SlashItem = { id: "ask", label: "office.slash.ask", keys: "ask agent ai claude", icon: Sparkles, run: () => {} };

/** Keys go to the slash menu while it is open. */
const SlashKeys = Extension.create<{ onKey: { current: ((e: KeyboardEvent) => boolean) | null } }>({
  name: "officeSlashKeys",
  addOptions() {
    return { onKey: { current: null } };
  },
  addProseMirrorPlugins() {
    const ref = this.options.onKey;
    return [new Plugin({ props: { handleKeyDown: (_view, e) => ref.current?.(e) ?? false } })];
  },
});

/** Other people's carets and selections, from awareness. */
const Cursors = Extension.create<{ session: Session | null }>({
  name: "officeCursors",
  addOptions() {
    return { session: null };
  },
  addProseMirrorPlugins() {
    const s = this.options.session;
    if (!s) return [];
    return [
      yCursorPlugin(s.awareness, {
        cursorBuilder: (user: { name?: string; color?: string }) => {
          const caret = document.createElement("span");
          caret.className = "office-caret";
          caret.style.borderColor = user.color ?? "var(--accent)";
          const label = document.createElement("span");
          label.className = "office-caret-label";
          label.style.background = user.color ?? "var(--accent)";
          label.textContent = user.name ?? "";
          caret.append(label);
          return caret;
        },
        selectionBuilder: (user: { color?: string }) => ({ style: `background-color: color-mix(in srgb, ${user.color ?? "var(--accent)"} 22%, transparent)`, class: "office-remote-sel" }),
      }),
    ];
  },
});

export function DocEditor({ doc, session, setActions }: EditorProps) {
  const tr = useT();
  const onKey = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const [slash, setSlash] = useState<{ from: number; to: number; q: string; x: number; y: number } | null>(null);
  const [hot, setHot] = useState(0);
  const [ask, setAsk] = useState<{ context: string; scope: "doc" | "selection" } | null>(null);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: session.ydoc, field: "content" }),
        Placeholder.configure({ placeholder: ({ node }) => (node.type.name === "heading" ? t("office.doc.heading") : t("office.doc.placeholder")) }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Link.configure({ openOnClick: false, autolink: true }),
        SlashKeys.configure({ onKey }),
        Cursors.configure({ session }),
      ],
      editorProps: { attributes: { class: "office-prose", spellcheck: "true" } },
    },
    [session],
  );

  // Find "/query" right before the caret.
  useEffect(() => {
    if (!editor) return;
    const check = () => {
      const { $from, empty } = editor.state.selection;
      if (!empty || $from.parent.type.name === "codeBlock") return setSlash(null);
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
      const m = /(?:^|\s)\/([\p{L}\d-]*)$/u.exec(before);
      if (!m) return setSlash(null);
      const from = $from.pos - m[1].length - 1;
      const c = editor.view.coordsAtPos(from);
      setSlash((old) => {
        if (!old || old.q !== m[1]) setHot(0);
        return { from, to: $from.pos, q: m[1], x: c.left, y: c.bottom };
      });
    };
    editor.on("transaction", check);
    return () => void editor.off("transaction", check);
  }, [editor]);

  const items = useMemo(() => {
    if (!slash) return [];
    const q = slash.q.toLowerCase();
    return [...SLASH, ASK].filter((i) => !q || t(i.label).toLowerCase().includes(q) || i.keys.includes(q));
  }, [slash]);

  const plain = () => (editor ? toPlain(editor.getJSON() as PMNode) : "");
  const pick = (i: SlashItem) => {
    if (!editor || !slash) return;
    editor.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
    setSlash(null);
    if (i.id === "ask") setAsk({ context: toMarkdown(editor.getJSON() as PMNode), scope: "doc" });
    else i.run(editor);
  };

  onKey.current = (e) => {
    if (!slash || !items.length) return false;
    if (e.key === "ArrowDown") setHot((h) => (h + 1) % items.length);
    else if (e.key === "ArrowUp") setHot((h) => (h - 1 + items.length) % items.length);
    else if (e.key === "Enter" || e.key === "Tab") pick(items[Math.min(hot, items.length - 1)]);
    else if (e.key === "Escape") setSlash(null);
    else return false;
    return true;
  };

  useEffect(() => {
    if (!editor) return;
    setActions([
      { id: "md", label: t("office.exportMd"), icon: <FileDown size={14} />, run: () => download(`${fileSafe(doc.title)}.md`, toMarkdown(editor.getJSON() as PMNode, doc.title), "text/markdown") },
      { id: "pdf", label: t("office.printPdf"), icon: <Printer size={14} />, run: printOnly },
      { id: "ask", label: t("office.slash.ask"), icon: <Sparkles size={14} />, run: () => setAsk({ context: toMarkdown(editor.getJSON() as PMNode), scope: "doc" }) },
    ]);
  }, [editor, doc.title, setActions]);

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt(t("office.linkPrompt"), prev ?? "https://");
    if (url === null) return;
    if (!url.trim()) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };

  return (
    <div className="office-scroll">
      <article className="office-page office-print">
        <h1 className="office-doc-title">{doc.title}</h1>
        <EditorContent editor={editor} />
      </article>
      {editor && (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 120, placement: "top" }} className="office-bubble">
          <button className={editor.isActive("bold") ? "on" : ""} onClick={() => editor.chain().focus().toggleBold().run()} title={tr("office.fmt.bold")}>
            <Bold size={14} />
          </button>
          <button className={editor.isActive("italic") ? "on" : ""} onClick={() => editor.chain().focus().toggleItalic().run()} title={tr("office.fmt.italic")}>
            <Italic size={14} />
          </button>
          <button className={editor.isActive("strike") ? "on" : ""} onClick={() => editor.chain().focus().toggleStrike().run()} title={tr("office.fmt.strike")}>
            <Strikethrough size={14} />
          </button>
          <button className={editor.isActive("code") ? "on" : ""} onClick={() => editor.chain().focus().toggleCode().run()} title={tr("office.fmt.code")}>
            <Code size={14} />
          </button>
          <button className={editor.isActive("link") ? "on" : ""} onClick={setLink} title={tr("office.fmt.link")}>
            <Link2 size={14} />
          </button>
          <span className="office-bubble-sep" />
          <button
            className="office-bubble-ask"
            onClick={() => {
              const { from, to } = editor.state.selection;
              setAsk({ context: editor.state.doc.textBetween(from, to, "\n"), scope: "selection" });
            }}
          >
            <Sparkles size={13} />
            {tr("office.ask.short")}
          </button>
        </BubbleMenu>
      )}
      {slash && items.length > 0 && (
        <div className="menu-list office-slash" style={{ left: slash.x, top: slash.y + 6 }} onMouseDown={(e) => e.preventDefault()}>
          {items.map((i, n) => (
            <button key={i.id} className={`menu-item ${n === hot ? "hot" : ""} ${i.id === "ask" ? "office-slash-ask" : ""}`} onMouseEnter={() => setHot(n)} onClick={() => pick(i)}>
              <span className="menu-icon">
                <i.icon size={15} />
              </span>
              <span className="menu-label">{tr(i.label)}</span>
            </button>
          ))}
        </div>
      )}
      {ask && <AskDialog title={doc.title} context={ask.context || plain()} scope={ask.scope} onClose={() => setAsk(null)} />}
    </div>
  );
}
