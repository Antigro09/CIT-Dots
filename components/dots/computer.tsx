"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Computer,
  FilePlus,
  FileText,
  Folder,
  LoaderCircle,
  Maximize2,
  Play,
  RefreshCw,
  Save,
  Square,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Dot, Snapshot } from "@/src/shared/types";
import { localApi, useDetail, type LocalState } from "./use-local";
import { PetAvatar } from "./pet";

interface DesktopStatus {
  dotId: string;
  state: "stopped" | "starting" | "running" | "error";
  url: string | null;
  os: "Ubuntu 26.04";
  error?: string;
}
export interface ComputerInfo {
  dotId: string;
  desktop: DesktopStatus;
}
interface ComputerFiles {
  files: { path: string; type: "file" | "directory"; size?: number }[];
}

export function ComputerView({
  state,
  snapshot,
  dot,
}: {
  state: LocalState;
  snapshot: Snapshot;
  dot: Dot;
}) {
  const [revision, setRevision] = useState(0);
  const info = useDetail<ComputerInfo>(
    `/dots/${dot.id}/computer`,
    snapshot.eventsCursor + revision,
    4000,
  );
  const [tab, setTab] = useState<"desktop" | "files">("desktop");
  const [reconnect, setReconnect] = useState(0);
  const [changing, setChanging] = useState(false);
  const desktop = info.data?.desktop;
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    setTab(
      new URLSearchParams(window.location.search).get("tab") === "files"
        ? "files"
        : "desktop",
    );
  }, [dot.id]);
  const control = (action: "start" | "stop") => {
    setChanging(true);
    void state
      .run(async () => {
        await localApi(`/dots/${dot.id}/computer/${action}`, "POST", {});
        setRevision((value) => value + 1);
      })
      .finally(() => setChanging(false));
  };
  return (
    <div className="computer-view">
      <div className="computer-toolbar">
        <div className="computer-heading">
          <span className="computer-pet">
            <PetAvatar dot={dot} />
          </span>
          <div>
            <h1>{dot.name}&apos;s computer</h1>
            <p>
              {desktop?.os ?? "Ubuntu 26.04"}
              <span className="middle-dot">·</span>Private Linux desktop
            </p>
          </div>
        </div>
        <div className="computer-controls">
          <span
            className={`tag ${desktop?.state === "running" ? "green" : desktop?.state === "error" ? "red" : ""}`}
          >
            {changing ? "Updating" : (desktop?.state ?? "Connecting")}
          </span>
          {desktop?.state === "running" ? (
            <>
              <button
                className="button small subtle"
                onClick={() => setReconnect((value) => value + 1)}
              >
                <RefreshCw size={13} />
                Reconnect
              </button>
              <button
                className="button small subtle"
                disabled={state.busy || changing}
                onClick={() => control("stop")}
              >
                <Square size={12} />
                Stop desktop
              </button>
            </>
          ) : (
            <button
              className="button small primary"
              disabled={
                state.busy ||
                changing ||
                desktop?.state === "starting" ||
                !desktop
              }
              onClick={() => control("start")}
            >
              {changing ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Play size={13} />
              )}
              Start desktop
            </button>
          )}
        </div>
      </div>
      <div className="computer-tabs">
        <div className="filter-tabs" role="group" aria-label="Computer view">
          <button
            className={tab === "desktop" ? "is-active" : ""}
            onClick={() => setTab("desktop")}
          >
            <Computer size={14} />
            Desktop
          </button>
          <button
            className={tab === "files" ? "is-active" : ""}
            onClick={() => setTab("files")}
          >
            <Folder size={14} />
            Workspace files
          </button>
        </div>
        {tab === "desktop" && desktop?.state === "running" && desktop.url ? (
          <div className="desktop-display-actions">
            <button
              className="icon-button"
              aria-label="Make desktop fullscreen"
              onClick={() => {
                void frame.current?.requestFullscreen().catch(() => undefined);
              }}
            >
              <Maximize2 size={15} />
            </button>
            <a
              className="icon-button"
              href={desktop.url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open desktop in a new window"
            >
              <ArrowUpRight size={16} />
            </a>
          </div>
        ) : null}
      </div>
      {tab === "files" ? (
        <ComputerFilesView
          key={dot.id}
          state={state}
          dot={dot}
          revision={snapshot.eventsCursor}
        />
      ) : desktop?.state === "running" && desktop.url ? (
        <div className="desktop-frame">
          <iframe
            ref={frame}
            key={`${dot.id}-${reconnect}`}
            src={desktop.url}
            title={`${dot.name}'s Ubuntu desktop`}
            allow="clipboard-read; clipboard-write; fullscreen"
            referrerPolicy="no-referrer"
          />
          <div className="desktop-caption">
            <span>
              <Terminal size={13} />A real Linux desktop, running on your
              workstation.
            </span>
            <span>Closing this page keeps it running.</span>
          </div>
        </div>
      ) : (
        <div className="desktop-empty">
          <div className="desktop-pet-stage">
            <PetAvatar
              dot={dot}
              mood={
                desktop?.state === "starting" || changing ? "working" : "idle"
              }
            />
          </div>
          <span className="eyebrow">
            An actual computer, a space of its own
          </span>
          <h2>
            {desktop?.state === "starting" || changing
              ? `${dot.name}'s desktop is starting`
              : `${dot.name} has a place to work.`}
          </h2>
          <p>
            {desktop?.state === "starting" || changing
              ? "Preparing the isolated Ubuntu desktop. Its real screen will appear here when it is ready."
              : "Open its Linux desktop to use a browser, terminal, and file manager. Its personal files stay here between visits."}
          </p>
          {info.error || desktop?.error ? (
            <div className="desktop-error" role="alert">
              {info.error ?? desktop?.error}
            </div>
          ) : null}
          {!desktop && info.loading ? (
            <div className="loading-row">
              <LoaderCircle className="spin" size={18} />
              Checking the computer…
            </div>
          ) : desktop?.state !== "starting" && !changing ? (
            <button
              className="button primary"
              disabled={state.busy || !desktop}
              onClick={() => control("start")}
            >
              <Play size={14} />
              Start {dot.name}&apos;s desktop
            </button>
          ) : (
            <LoaderCircle size={21} className="spin muted" />
          )}
          <div className="computer-features">
            <span>
              <Computer size={15} />
              Ubuntu + Xfce
            </span>
            <span>
              <Folder size={15} />
              Persistent personal files
            </span>
            <span>
              <Terminal size={15} />
              Browser, terminal, file manager
            </span>
          </div>
          <details className="desktop-setup">
            <summary>First-time desktop setup</summary>
            <p>
              Docker and the local desktop image are required. Build the images
              on the workstation, then start the desktop.
            </p>
            <pre>
              docker build -t cit-dots-sandbox:latest -f sandbox/Dockerfile .
              {"\n"}docker build -t cit-dots-desktop:latest -f
              desktop/Dockerfile .
            </pre>
            <p>
              The desktop runs on an isolated local network. Its files persist
              when you stop it.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}

function ComputerFilesView({
  state,
  dot,
  revision,
}: {
  state: LocalState;
  dot: Dot;
  revision: number;
}) {
  const [directory, setDirectory] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [localRevision, setLocalRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const files = useDetail<ComputerFiles>(
    `/dots/${dot.id}/computer/files?path=${encodeURIComponent(directory)}`,
    revision + localRevision,
    5000,
  );
  const file = useDetail<{ path: string; content: string }>(
    path
      ? `/dots/${dot.id}/computer/file?path=${encodeURIComponent(path)}`
      : null,
    localRevision,
  );
  useEffect(() => {
    if (file.data?.path === path && !dirty) setContent(file.data.content);
  }, [file.data, dirty, path]);
  const canDiscardDraft = () =>
    !dirty || window.confirm("Discard the unsaved changes in this file?");
  async function save(target: string) {
    await state.run(async () => {
      await localApi(`/dots/${dot.id}/computer/file`, "PUT", {
        path: target,
        content,
      });
      setPath(target);
      setAdding(false);
      setDirty(false);
      setSaved(true);
      setLocalRevision((value) => value + 1);
    });
  }
  return (
    <div className="computer-files">
      <aside
        className="computer-file-browser"
        aria-label={`${dot.name}'s workspace files`}
      >
        <div className="file-browser-heading">
          <strong>Workspace</strong>
          <button
            className="icon-button"
            aria-label="Create workspace file"
            disabled={state.busy}
            onClick={() => {
              if (!canDiscardDraft()) return;
              setAdding(true);
              setPath(null);
              setContent("");
              setDraftPath(directory ? `${directory}/` : "");
              setDirty(false);
              setSaved(false);
            }}
          >
            <FilePlus size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Refresh workspace files"
            onClick={() => setLocalRevision((value) => value + 1)}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {directory ? (
          <button
            className="file-browser-back"
            onClick={() => {
              setDirectory(directory.split("/").slice(0, -1).join("/"));
            }}
          >
            <ArrowLeft size={13} />
            {directory}
          </button>
        ) : (
          <span className="file-browser-root">
            {dot.name}&apos;s private workspace
          </span>
        )}
        {files.error ? (
          <p className="inline-error" role="alert">
            {files.error}
          </p>
        ) : null}
        <div className="computer-file-list">
          {files.data?.files.length ? (
            files.data.files.map((item) => (
              <button
                className={`computer-file-item ${path === item.path ? "is-active" : ""}`}
                key={item.path}
                disabled={state.busy}
                onClick={() => {
                  if (item.type === "directory") setDirectory(item.path);
                  else {
                    if (item.path === path && !adding) return;
                    if (!canDiscardDraft()) return;
                    setPath(item.path);
                    setAdding(false);
                    setDirty(false);
                    setSaved(false);
                  }
                }}
              >
                {item.type === "directory" ? (
                  <Folder size={15} />
                ) : (
                  <FileText size={15} />
                )}
                <span>{item.path.split("/").at(-1)}</span>
                {item.size !== undefined ? (
                  <small>
                    {item.size > 1024
                      ? `${Math.ceil(item.size / 1024)} KB`
                      : `${item.size} B`}
                  </small>
                ) : null}
              </button>
            ))
          ) : (
            <p className="empty-files">No files in this folder yet.</p>
          )}
        </div>
      </aside>
      <div className="computer-file-editor">
        {path || adding ? (
          <>
            <div className="file-editor-heading">
              <FileText size={15} />
              {adding ? (
                <label>
                  <span className="sr-only">New file path</span>
                  <input
                    required
                    aria-label="New file path"
                    disabled={state.busy}
                    value={draftPath}
                    onChange={(event) => setDraftPath(event.target.value)}
                    placeholder="notes.md"
                  />
                </label>
              ) : (
                <span>{path}</span>
              )}
              <button
                className="button small primary"
                disabled={state.busy || (adding ? !draftPath.trim() : !dirty)}
                onClick={() => void save(adding ? draftPath.trim() : path!)}
              >
                <Save size={13} />
                Save file
              </button>
            </div>
            {file.error ? (
              <p className="inline-error" role="alert">
                {file.error}
              </p>
            ) : null}
            <label className="file-editor-label">
              <span className="sr-only">File contents</span>
              <textarea
                aria-label="File contents"
                disabled={
                  state.busy ||
                  (!adding && (file.loading || file.data?.path !== path))
                }
                spellCheck={false}
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setDirty(true);
                  setSaved(false);
                }}
                placeholder="Write something to keep in this Dot's computer…"
              />
            </label>
            <div className="file-editor-caption">
              <span>
                {dot.name}&apos;s files are separate from every other Dot.
              </span>
              {saved ? (
                <span className="saved-label" role="status">
                  <Check size={12} />
                  Saved to computer
                </span>
              ) : dirty ? (
                <span>Unsaved changes</span>
              ) : null}
            </div>
          </>
        ) : (
          <div className="file-editor-empty">
            <Folder size={30} />
            <h2>A workspace that stays</h2>
            <p>
              Open a file, or create a note for {dot.name}. These are real files
              in its private computer.
            </p>
            <button
              className="button subtle"
              disabled={state.busy}
              onClick={() => {
                setAdding(true);
                setContent("");
                setDraftPath("notes.md");
                setDirty(false);
              }}
            >
              <FilePlus size={14} />
              Create a file
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
