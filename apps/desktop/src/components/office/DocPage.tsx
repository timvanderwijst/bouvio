import { ArrowLeft, Share2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import type { Doc } from "../../protocol/Doc";
import { rpc, useStore } from "../../store";
import { Empty } from "../Panel";
import { KindIcon, PopItem, Popover, docById, rememberDoc, useDocs } from "./common";
import { DatabaseEditor } from "./DatabaseEditor";
import { DocEditor } from "./DocEditor";
import { FormEditor } from "./FormEditor";
import { SheetEditor } from "./SheetEditor";
import { SlidesEditor } from "./SlidesEditor";
import { usePeers, useSession, type Session } from "./sync";
import "./office.css";

export interface DocAction {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

export interface EditorProps {
  doc: Doc;
  session: Session;
  /** Editors publish their export and share actions to the top bar. */
  setActions: (a: DocAction[]) => void;
  /** Extra controls for the top bar (a present button). */
  setTools: (n: ReactNode) => void;
}

export function DocPage({ sub }: { sub?: string }) {
  const t = useT();
  const docs = useDocs();
  const doc = sub ? (docs?.find((d) => d.id === sub) ?? docById(sub)) : undefined;
  const session = useSession(doc?.id);
  const peers = usePeers(session);
  const go = useStore((s) => s.go);
  // Kept per doc, so a previous editor's actions never show on the next one.
  const [bar, setBar] = useState<{ id?: string; actions: DocAction[]; tools: ReactNode }>({ actions: [], tools: null });
  const id = doc?.id;
  const setActions = useCallback((a: DocAction[]) => setBar((b) => ({ id, actions: a, tools: b.id === id ? b.tools : null })), [id]);
  const setTools = useCallback((n: ReactNode) => setBar((b) => ({ id, tools: n, actions: b.id === id ? b.actions : [] })), [id]);
  const actions = bar.id === id ? bar.actions : [];
  const tools = bar.id === id ? bar.tools : null;

  if (!doc) return <div className="office-doc">{docs === undefined ? null : <Empty text={t("office.notFound")} />}</div>;

  const props = session ? { doc, session, setActions, setTools } : null;
  return (
    <div className={`office-doc kind-${doc.kind}`}>
      <header className="office-bar">
        <button className="icon-btn" title={t("office.back")} onClick={() => go({ kind: "ext", id: "office.docs" })}>
          <ArrowLeft size={16} />
        </button>
        <KindIcon kind={doc.kind} />
        <TitleInput doc={doc} />
        <div className="composer-spacer" />
        <div className="office-peers">
          {peers.slice(0, 5).map((p) => (
            <span key={p.clientId} className="person-avatar office-peer" style={{ background: p.color }} title={p.name}>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
          {peers.length > 5 && <span className="office-peer-more">+{peers.length - 5}</span>}
        </div>
        {tools}
        {actions.length > 0 && (
          <Popover
            align="right"
            trigger={(_, toggle) => (
              <button className="btn small" onClick={toggle}>
                <Share2 size={13} />
                {t("office.share")}
              </button>
            )}
          >
            {(close) =>
              actions.map((a) => (
                <PopItem
                  key={a.id}
                  icon={a.icon}
                  label={a.label}
                  onClick={() => {
                    close();
                    a.run();
                  }}
                />
              ))
            }
          </Popover>
        )}
      </header>
      <div className="office-body">
        {!session || (!session.ready && !session.error) ? (
          <div className="office-loading" />
        ) : session.error ? (
          <Empty text={session.error} />
        ) : doc.kind === "doc" ? (
          <DocEditor key={doc.id} {...props!} />
        ) : doc.kind === "sheet" ? (
          <SheetEditor key={doc.id} {...props!} />
        ) : doc.kind === "slides" ? (
          <SlidesEditor key={doc.id} {...props!} />
        ) : doc.kind === "database" ? (
          <DatabaseEditor key={doc.id} {...props!} />
        ) : (
          <FormEditor key={doc.id} {...props!} />
        )}
      </div>
    </div>
  );
}

function TitleInput({ doc }: { doc: Doc }) {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const [title, setTitle] = useState(doc.title);
  useEffect(() => setTitle(doc.title), [doc.title]);
  const commit = () => {
    const next = title.trim();
    if (!next || next === doc.title) return setTitle(doc.title);
    rememberDoc({ ...doc, title: next });
    rpc<Doc>("rename_doc", { id: doc.id, title: next })
      .then(rememberDoc)
      .catch((e) => notify(String(e)));
  };
  return (
    <input
      className="board-title office-title-input"
      value={title}
      placeholder={t("office.untitled")}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      size={Math.max(8, Math.min(48, title.length + 1))}
    />
  );
}
