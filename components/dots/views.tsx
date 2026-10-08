"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Code2,
  Cpu,
  Download,
  FileText,
  Folder,
  GitBranch,
  Inbox,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Dot,
  Goal,
  Memory,
  ModelProfile,
  Session,
  Task,
} from "@/src/shared/types";
import { Status, TaskCard } from "./console";
import { PetAvatar } from "./pet";
import { MessageFiles } from "./message-files";
import { dotProse } from "@/src/shared/dot-output";
import { activeDot, ownerId } from "./identity";
import type { WorkspaceDiff } from "@/src/server/workspaces";
import {
  localApi,
  useDetail,
  type LocalState,
  type SessionDetail,
  type Snapshot,
  type TaskDetail,
} from "./use-local";

const Markdown = dynamic(
  () => import("./markdown").then((module) => module.Markdown),
  { loading: () => <span className="muted">Loading message…</span> },
);
type ViewProps = { state: LocalState; snapshot: Snapshot };

export function ChatView({
  state,
  snapshot,
  sessionId,
  selectTask,
  dot,
  kind = "chat",
}: ViewProps & {
  sessionId?: string;
  selectTask: (id: string) => void;
  dot?: Dot;
  kind?: "chat" | "work";
}) {
  const router = useRouter();
  const detail = useDetail<SessionDetail>(
    sessionId ? `/sessions/${sessionId}` : null,
    snapshot.eventsCursor,
  );
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"chat" | "work">(kind);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const sessionModel = snapshot.sessions.find(
    (session) => session.id === sessionId,
  )?.modelProfileId;
  const roleModel =
    snapshot.settings.roleModelProfileIds?.[
      mode === "work" ? "coder" : "coordinator"
    ];
  const model =
    modelOverride ??
    (dot
      ? (dot.modelProfileId ?? roleModel ?? sessionModel)
      : (sessionModel ?? roleModel)) ??
    snapshot.settings.defaultModelProfileId ??
    snapshot.models[0]?.id ??
    "";
  const [project, setProject] = useState(
    snapshot.sessions.find((session) => session.id === sessionId)?.projectId ??
      "",
  );
  const [attachments, setAttachments] = useState<
    { name: string; content: string }[]
  >([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const keepBottom = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const messages = detail.data?.messages ?? [];
  const isDotConversation = Boolean(dot && sessionId === dot.sessionId);
  const sessionTasks = snapshot.tasks.filter(
    (task) => task.sessionId === sessionId,
  );
  const assistantName = isDotConversation
    ? dot!.name
    : dot
      ? `${sessionTasks[0]?.role || "Specialist"} worker`
      : "Assistant";
  const active = sessionTasks.filter(
    (task) =>
      !["completed", "failed", "canceled", "interrupted"].includes(task.status),
  );
  const isEmpty =
    !sessionId || (!messages.length && !sessionTasks.length && !detail.loading);

  useEffect(() => {
    if (keepBottom.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, snapshot.eventsCursor]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !content.trim() ||
      !model ||
      state.busy ||
      (!dot && mode === "work" && !project)
    )
      return;
    await state.run(async () => {
      let id = sessionId;
      if (!id) {
        const session = await localApi<Session>("/sessions", "POST", {
          title:
            content.trim().slice(0, 70) ||
            attachments[0]?.name ||
            "New conversation",
          projectId: project || null,
          modelProfileId: model,
          kind: dot ? "dot" : mode,
          dotId: dot?.id ?? null,
        });
        id = session.id;
      }
      await localApi(`/sessions/${id}/messages`, "POST", {
        content: content.trim(),
        attachments,
        ...(!dot || modelOverride !== null ? { modelProfileId: model } : {}),
      });
      setContent("");
      setAttachments([]);
      keepBottom.current = true;
      if (!sessionId) router.push(`/sessions/${id}`);
    });
  }

  return (
    <div
      className={`chat-view ${isEmpty ? "is-empty" : ""} mode-${mode} ${dot ? "dot-chat" : "independent-chat"}`}
    >
      {!sessionId && !dot ? (
        <div
          className="session-mode-pill"
          role="group"
          aria-label="New session mode"
        >
          <button
            className={mode === "chat" ? "is-active" : ""}
            aria-pressed={mode === "chat"}
            onClick={() => {
              setMode("chat");
              setModelOverride(null);
            }}
          >
            <MessageSquare size={14} />
            Chat
          </button>
          <button
            className={mode === "work" ? "is-active" : ""}
            aria-pressed={mode === "work"}
            onClick={() => {
              setMode("work");
              setModelOverride(null);
            }}
          >
            <Code2 size={14} />
            Work
          </button>
        </div>
      ) : null}
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          const bottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            90;
          keepBottom.current = bottom;
          setAtBottom(bottom);
        }}
      >
        {isEmpty ? (
          <div className="welcome">
            <div className="welcome-eyebrow">
              <span className="mini-brand" aria-hidden="true">
                ✦
              </span>{" "}
              {dot
                ? `${dot.name} is home.`
                : mode === "work"
                  ? "A place to build something useful."
                  : "A little more room to think."}
            </div>
            <h1>
              {mode === "work" && !dot ? (
                "What should we work on?"
              ) : !dot ? (
                "What's on your mind?"
              ) : (
                <>
                  What shall we
                  <br />
                  work on?
                </>
              )}
            </h1>
            <p>
              {dot
                ? `${dot.name} has its own memory, personality, and computer. You can`
                : "Your models. Your machine. An assistant that can"}
              <br className="desktop-break" /> chat, write code, and keep
              working in the background.
            </p>
            {dot ? (
              <div className="welcome-actions">
                <Link href="/projects" className="welcome-card">
                  <span className="welcome-card-icon">
                    <Code2 size={20} />
                  </span>
                  <strong>Build something</strong>
                  <span>Give a coding agent a project</span>
                  <ArrowUpRight size={16} />
                </Link>
                <Link href={`/dots/${dot.id}/goals`} className="welcome-card">
                  <span className="welcome-card-icon">
                    <CalendarClock size={20} />
                  </span>
                  <strong>Set a background goal</strong>
                  <span>Let work happen on a schedule</span>
                  <ArrowUpRight size={16} />
                </Link>
                <Link href="/models" className="welcome-card">
                  <span className="welcome-card-icon">
                    <Cpu size={20} />
                  </span>
                  <strong>Connect a local model</strong>
                  <span>Ollama or LM Studio</span>
                  <ArrowUpRight size={16} />
                </Link>
              </div>
            ) : null}
            {snapshot.models.length === 0 ? (
              <div className="setup-note">
                <span className="step-number">1</span>
                <div>
                  <strong>First, make yourself at home.</strong>
                  <p>Connect a local model to start your first conversation.</p>
                </div>
                <Link href="/models">
                  Set up
                  <ArrowRight size={14} />
                </Link>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="conversation-content">
            {detail.error ? (
              <p className="inline-error" role="alert">
                {detail.error}
              </p>
            ) : null}
            {detail.loading && !detail.data ? (
              <div className="loading-row">
                <LoaderCircle size={17} className="spin" />
                Loading conversation…
              </div>
            ) : null}
            {messages.map((message) => (
              <article
                className={`chat-message message-${message.role} ${message.kind === "error" ? "message-error" : ""}`}
                key={message.id}
              >
                {message.role !== "user" ? (
                  <span
                    className={`assistant-avatar ${isDotConversation ? "pet-message-avatar" : ""}`}
                    aria-label={assistantName}
                  >
                    {isDotConversation ? <PetAvatar dot={dot!} /> : "✦"}
                  </span>
                ) : null}
                <div className="message-body">
                  {message.role !== "user" ? (
                    <div className="message-author">
                      {message.role === "tool" ? "Tool result" : assistantName}
                      {message.kind && message.kind !== "chat" ? (
                        <span className="message-kind">{message.kind}</span>
                      ) : null}
                    </div>
                  ) : null}
                  {isDotConversation && message.role !== "user" ? (
                    <p style={{ whiteSpace: "pre-wrap" }}>
                      {dotProse(message.content)}
                    </p>
                  ) : (
                    <Markdown content={message.content} />
                  )}
                  {message.attachments?.length ? (
                    <div className="attachment-list">
                      {message.attachments.map((attachment, index) => (
                        <span
                          className="attachment"
                          key={`${attachment.name}-${index}`}
                        >
                          <FileText size={14} />
                          {attachment.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {message.files?.length ? (
                    <MessageFiles files={message.files} />
                  ) : null}
                </div>
              </article>
            ))}
            {active.length ? (
              <div className="working-notice" role="status">
                <LoaderCircle size={16} className="spin" />
                <span>
                  {active.some((task) => task.status === "waiting_approval")
                    ? "Waiting for your decision"
                    : "Working on your request"}
                </span>
                <button onClick={() => selectTask(active[0].id)}>
                  View activity
                  <ChevronRight size={13} />
                </button>
              </div>
            ) : null}
            {sessionTasks.filter((task) => task.parentId !== null).length ? (
              <div className="conversation-children">
                <span className="eyebrow">Child sessions</span>
                {sessionTasks
                  .filter((task) => task.parentId !== null)
                  .map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onClick={() => selectTask(task.id)}
                    />
                  ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {!atBottom && !isEmpty ? (
        <button
          className="jump-latest"
          onClick={() => {
            keepBottom.current = true;
            scroller.current?.scrollTo({
              top: scroller.current.scrollHeight,
              behavior: "smooth",
            });
          }}
        >
          <ArrowDown size={14} />
          Jump to latest
        </button>
      ) : null}
      <div className="composer-wrap">
        <form className="chat-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="chat-message">
            Message CIT Dots
          </label>
          <textarea
            id="chat-message"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={
              snapshot.models.length
                ? dot
                  ? `Message ${dot.name}, or give it something to work on…`
                  : mode === "work"
                    ? "Describe what you want to work on…"
                    : "Ask anything…"
                : "Connect a local model to start chatting…"
            }
            rows={3}
            disabled={
              state.busy ||
              !snapshot.models.length ||
              state.connection !== "connected"
            }
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {attachments.length ? (
            <div className="attachment-list">
              {attachments.map((file, index) => (
                <span className="attachment" key={`${file.name}-${index}`}>
                  <FileText size={14} />
                  {file.name}
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    disabled={state.busy}
                    onClick={() =>
                      setAttachments((items) =>
                        items.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="composer-toolbar">
            <div className="composer-options">
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept=".txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.sh,.html,.css,.yaml,.yml,.toml,.log"
                aria-label="Attach text files"
                disabled={state.busy}
                onChange={async (event) => {
                  const files = Array.from(event.target.files ?? []);
                  setFileError(null);
                  if (files.length + attachments.length > 5) {
                    setFileError("Attach up to five text files per message.");
                    return;
                  }
                  if (files.some((file) => file.size > 100000)) {
                    setFileError("Choose text files smaller than 100 KB.");
                    return;
                  }
                  try {
                    const added = await Promise.all(
                      files.map(async (file) => ({
                        name: file.name,
                        content: await file.text(),
                      })),
                    );
                    setAttachments((items) => [...items, ...added]);
                  } catch {
                    setFileError("A selected file could not be read.");
                  }
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Attach text files"
                disabled={state.busy}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={18} />
              </button>
              <label className="composer-select">
                <Cpu size={14} />
                <span className="sr-only">Model for the next response</span>
                <select
                  aria-label="Model for the next response"
                  value={model}
                  onChange={(event) => setModelOverride(event.target.value)}
                  disabled={state.busy || !snapshot.models.length}
                >
                  <option value="">Choose model</option>
                  {snapshot.models.map((profile) => (
                    <option value={profile.id} key={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="composer-select project-composer-select">
                <Folder size={14} />
                <span className="sr-only">Project</span>
                <select
                  aria-label="Project"
                  value={project}
                  onChange={(event) => setProject(event.target.value)}
                  disabled={state.busy || !!sessionId}
                >
                  <option value="">No project</option>
                  {snapshot.projects.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="composer-send">
              {active.length ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cancel active conversation tasks"
                  disabled={state.busy}
                  onClick={() =>
                    void state.run(() =>
                      Promise.all(
                        active.map((task) =>
                          localApi(`/tasks/${task.id}/cancel`, "POST", {}),
                        ),
                      ),
                    )
                  }
                >
                  <Square size={14} />
                </button>
              ) : null}
              <button
                className="send-button"
                aria-label="Send message"
                type="submit"
                disabled={
                  state.busy ||
                  !model ||
                  !content.trim() ||
                  (!dot && mode === "work" && !project) ||
                  state.connection !== "connected"
                }
              >
                {state.busy ? (
                  <LoaderCircle size={19} className="spin" />
                ) : (
                  <ArrowUp size={21} />
                )}
              </button>
            </div>
          </div>
        </form>
        {fileError ? (
          <p className="inline-error" role="alert">
            {fileError}
          </p>
        ) : null}
        <p className="composer-caption">
          {!dot && mode === "work" && !project
            ? "Choose a project to start a work session."
            : model
              ? "Model changes apply to the next task."
              : "Choose a local model to begin."}
          <span>Shift + Enter for a new line</span>
        </p>
      </div>
    </div>
  );
}

export function ProjectsView({
  state,
  snapshot,
  projectId,
}: ViewProps & { projectId?: string }) {
  const [adding, setAdding] = useState(false);
  const router = useRouter();
  const selected = snapshot.projects.find(
    (project) => project.id === projectId,
  );
  const [model, setModel] = useState(
    snapshot.settings.roleModelProfileIds?.coder ??
      snapshot.settings.defaultModelProfileId ??
      snapshot.models[0]?.id ??
      "",
  );
  const [prompt, setPrompt] = useState("");
  return (
    <div className="page-content">
      <ViewHeader
        eyebrow="A workspace for your work"
        title={selected?.name ?? "Projects"}
        description={
          selected
            ? selected.path
            : "Connect a folder, start a coding session, and review the results."
        }
        action={
          !selected ? (
            <button
              className="button primary"
              onClick={() => setAdding(!adding)}
            >
              <Plus size={16} />
              Add project
            </button>
          ) : (
            <Link className="button subtle" href="/projects">
              All projects
            </Link>
          )
        }
      />
      {adding ? (
        <form
          className="surface form-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void state.run(async () => {
              await localApi("/projects", "POST", {
                path: form.get("path"),
                name: form.get("name") || undefined,
              });
              setAdding(false);
            });
          }}
        >
          <div className="form-heading">
            <h2>Connect a project folder</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close project form"
              onClick={() => setAdding(false)}
            >
              <X size={16} />
            </button>
          </div>
          <Field
            label="Project name"
            name="name"
            placeholder="My application"
          />
          <Field
            label="Absolute folder path"
            name="path"
            placeholder="/home/you/projects/my-application"
            required
          />
          <p className="form-hint">
            Choose a folder on the workstation running Dots. Coding agents use
            isolated workspaces, then produce a patch for review.
          </p>
          <button className="button primary" disabled={state.busy}>
            Connect folder
          </button>
        </form>
      ) : null}
      {selected ? (
        <>
          <div className="project-banner">
            <Folder size={21} />
            <span>{selected.isGit ? "Git repository" : "Project folder"}</span>
            <span className="tag">Local</span>
          </div>
          <form
            className="surface form-panel"
            onSubmit={(event) => {
              event.preventDefault();
              if (!model || !prompt.trim()) return;
              void state.run(async () => {
                const session = await localApi<Session>("/sessions", "POST", {
                  title: prompt.trim().slice(0, 70),
                  kind: "work",
                  dotId: null,
                  projectId: selected.id,
                  modelProfileId: model,
                });
                const result = await localApi<{ task: Task }>(
                  `/sessions/${session.id}/messages`,
                  "POST",
                  { content: prompt.trim(), modelProfileId: model },
                );
                router.push(`/tasks/${result.task.id}`);
              });
            }}
          >
            <h2>Start a coding session</h2>
            <label className="form-field">
              <span>What should the agent build or fix?</span>
              <textarea
                name="prompt"
                rows={4}
                required
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the change and how you want it verified…"
              />
            </label>
            <ModelPicker
              snapshot={snapshot}
              value={model}
              onChange={setModel}
            />
            <div className="button-row">
              <button
                className="button primary"
                disabled={state.busy || !model}
              >
                <Code2 size={16} />
                Start coding
              </button>
              <span className="form-hint">
                Changes are available for review before applying.
              </span>
            </div>
          </form>
          <div className="subsection-heading">
            <h2>Project sessions</h2>
          </div>
          {snapshot.tasks.some((task) => task.projectId === selected.id) ? (
            <div className="task-grid">
              {snapshot.tasks
                .filter(
                  (task) =>
                    task.projectId === selected.id && task.parentId === null,
                )
                .map((task) => (
                  <Link
                    className="surface coding-run"
                    key={task.id}
                    href={`/tasks/${task.id}`}
                  >
                    <div>
                      <Code2 size={19} />
                      <Status status={task.status} />
                    </div>
                    <h3>{task.title}</h3>
                    <p>
                      {task.role} · {task.profileSnapshot.name}
                    </p>
                    <span>
                      Open workspace
                      <ArrowUpRight size={14} />
                    </span>
                  </Link>
                ))}
            </div>
          ) : (
            <EmptyState
              icon={<Code2 size={26} />}
              title="Ready for your first coding task"
              description="Ask the agent to build, investigate, test, or review something in this project."
            />
          )}
        </>
      ) : snapshot.projects.length ? (
        <div className="project-grid">
          {snapshot.projects.map((project) => (
            <article className="surface project-card" key={project.id}>
              <Link href={`/projects/${project.id}`}>
                <span className="card-icon">
                  <Folder size={23} />
                </span>
                <h2>{project.name}</h2>
                <p className="path-text">{project.path}</p>
                <div className="card-footer">
                  <span className="tag">
                    {project.isGit ? (
                      <GitBranch size={13} />
                    ) : (
                      <Folder size={13} />
                    )}
                    {project.isGit ? "Git repository" : "Folder"}
                  </span>
                  <ArrowUpRight size={17} />
                </div>
              </Link>
              <button
                className="icon-button remove-project"
                aria-label={`Unregister ${project.name}`}
                disabled={state.busy}
                onClick={() =>
                  void state.run(() =>
                    localApi(`/projects/${project.id}`, "DELETE"),
                  )
                }
              >
                <X size={15} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Folder size={28} />}
          title="Good ideas need a workspace"
          description="Add a local project folder to give coding agents a place to read, build, and test."
          action={
            <button className="button subtle" onClick={() => setAdding(true)}>
              <Plus size={16} />
              Connect your first project
            </button>
          }
        />
      )}
    </div>
  );
}

export function GoalsView({ state, snapshot }: ViewProps) {
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState<Goal | undefined>();
  return (
    <div className="page-content">
      <ViewHeader
        eyebrow="A little progress, on repeat"
        title="Background goals"
        description="Give Dots an objective and a schedule. It will keep you posted when there is something to share."
        action={
          <button
            className="button primary"
            onClick={() => {
              setEditing(undefined);
              setForm(true);
            }}
          >
            <Plus size={16} />
            New goal
          </button>
        }
      />
      {form ? (
        <GoalForm
          key={editing?.id ?? "new"}
          state={state}
          snapshot={snapshot}
          goal={editing}
          close={() => setForm(false)}
        />
      ) : null}
      {snapshot.goals.length ? (
        <div className="goal-list">
          {snapshot.goals.map((goal) => (
            <article className="surface goal-card" key={goal.id}>
              <div className="goal-heading">
                <span className="card-icon">
                  <CalendarClock size={20} />
                </span>
                <div>
                  <Link href={`/sessions/${goal.sessionId}`}>
                    <h2>{goal.title}</h2>
                  </Link>
                  <div className="goal-schedule">
                    {goal.scheduleType === "interval"
                      ? `Every ${goal.intervalMinutes} minutes`
                      : goal.scheduleType === "cron"
                        ? goal.cron
                        : "One time"}
                    <span className="middle-dot">·</span>
                    {goal.timezone}
                  </div>
                </div>
                <span className={`tag ${goal.enabled ? "green" : ""}`}>
                  {goal.enabled ? "Scheduled" : "Paused"}
                </span>
              </div>
              <p>{goal.objective}</p>
              <div className="goal-next">
                {goal.enabled ? "Next run" : "Scheduled time"}
                <strong>{formatDate(goal.nextRunAt)}</strong>
              </div>
              <div className="card-footer">
                <div className="button-row">
                  <button
                    className="button small subtle"
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(() =>
                        localApi(`/goals/${goal.id}/run`, "POST", {}),
                      )
                    }
                  >
                    <Play size={13} />
                    Run now
                  </button>
                  <button
                    className="button small subtle"
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(() =>
                        localApi(`/goals/${goal.id}`, "PATCH", {
                          enabled: !goal.enabled,
                        }),
                      )
                    }
                  >
                    {goal.enabled ? "Pause" : "Resume"}
                  </button>
                </div>
                <div className="button-row">
                  <button
                    className="icon-button"
                    aria-label={`Edit ${goal.title}`}
                    onClick={() => {
                      setEditing(goal);
                      setForm(true);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${goal.title}`}
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(() =>
                        localApi(`/goals/${goal.id}`, "DELETE"),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<CalendarClock size={29} />}
          title="Let tomorrow start with progress"
          description="Schedule a project check, a research task, or another clear objective. Results arrive in your inbox."
          action={
            <button className="button subtle" onClick={() => setForm(true)}>
              <Plus size={16} />
              Create your first goal
            </button>
          }
        />
      )}
    </div>
  );
}

function GoalForm({
  state,
  snapshot,
  goal,
  close,
}: ViewProps & { goal?: Goal; close: () => void }) {
  const [schedule, setSchedule] = useState<Goal["scheduleType"]>(
    goal?.scheduleType ?? "interval",
  );
  const [model, setModel] = useState(
    goal?.modelProfileId ??
      snapshot.settings.defaultModelProfileId ??
      snapshot.models[0]?.id ??
      "",
  );
  return (
    <form
      className="surface form-panel"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = {
          ...(goal
            ? {}
            : { dotId: snapshot.settings.selectedDotId ?? "dot-primary" }),
          title: form.get("title"),
          objective: form.get("objective"),
          projectId: form.get("projectId") || null,
          modelProfileId: model,
          scheduleType: schedule,
          nextRunAt: new Date(String(form.get("nextRunAt"))).toISOString(),
          intervalMinutes:
            schedule === "interval"
              ? Number(form.get("intervalMinutes"))
              : undefined,
          cron: schedule === "cron" ? form.get("cron") : undefined,
          timezone: form.get("timezone"),
          overlap: form.get("overlap"),
          enabled: goal?.enabled ?? true,
        };
        void state.run(async () => {
          await localApi(
            goal ? `/goals/${goal.id}` : "/goals",
            goal ? "PATCH" : "POST",
            body,
          );
          close();
        });
      }}
    >
      <div className="form-heading">
        <h2>{goal ? "Edit goal" : "A new background goal"}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close goal form"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      <Field
        label="Goal title"
        name="title"
        defaultValue={goal?.title}
        placeholder="Check my project every morning"
        required
      />
      <label className="form-field">
        <span>Objective and success criteria</span>
        <textarea
          name="objective"
          rows={3}
          required
          defaultValue={goal?.objective}
          placeholder="Explain what to do, when it is complete, and what results to share…"
        />
      </label>
      <div className="form-grid">
        <ModelPicker snapshot={snapshot} value={model} onChange={setModel} />
        <label className="form-field">
          <span>Project</span>
          <select name="projectId" defaultValue={goal?.projectId ?? ""}>
            <option value="">No project</option>
            {snapshot.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Schedule</span>
          <select
            value={schedule}
            onChange={(event) =>
              setSchedule(event.target.value as Goal["scheduleType"])
            }
          >
            <option value="once">One time</option>
            <option value="interval">Repeating interval</option>
            <option value="cron">Cron schedule</option>
          </select>
        </label>
        <Field
          label="First run (your device time)"
          name="nextRunAt"
          type="datetime-local"
          required
          defaultValue={toLocalDateInput(
            goal?.nextRunAt ?? new Date(Date.now() + 60000).toISOString(),
          )}
        />
        {schedule === "interval" ? (
          <Field
            label="Repeat every (minutes)"
            name="intervalMinutes"
            type="number"
            min={1}
            required
            defaultValue={goal?.intervalMinutes ?? 60}
          />
        ) : null}
        {schedule === "cron" ? (
          <Field
            label="Cron expression"
            name="cron"
            placeholder="0 9 * * 1-5"
            defaultValue={goal?.cron ?? "0 9 * * 1-5"}
            required
          />
        ) : null}
        <Field
          label="Schedule timezone"
          name="timezone"
          required
          defaultValue={
            goal?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
          }
        />
        <label className="form-field">
          <span>If the previous run is still working</span>
          <select name="overlap" defaultValue={goal?.overlap ?? "skip"}>
            <option value="skip">Skip the overlapping run</option>
            <option value="queue">Queue the next run</option>
          </select>
        </label>
      </div>
      {!snapshot.models.length ? (
        <p className="form-hint">
          Connect a model before creating a goal.{" "}
          <Link href="/models">Open models</Link>
        </p>
      ) : null}
      <div className="button-row">
        <button className="button primary" disabled={state.busy || !model}>
          <CalendarClock size={16} />
          {goal ? "Save goal" : "Create goal"}
        </button>
        <button type="button" className="button subtle" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function InboxView({ state, snapshot }: ViewProps) {
  const [filter, setFilter] = useState("all");
  const items = snapshot.inbox.filter(
    (item) =>
      filter === "all" ||
      (filter === "unread" ? !item.read : item.kind === filter),
  );
  return (
    <div className="page-content">
      <ViewHeader
        eyebrow="Updates worth your attention"
        title="Your inbox"
        description="Progress, finished work, and questions from your agents. Everything stays here until you read it."
      />
      <div className="filter-tabs" role="group" aria-label="Filter inbox">
        {["all", "unread", "result", "question", "error"].map((value) => (
          <button
            className={filter === value ? "is-active" : ""}
            key={value}
            onClick={() => setFilter(value)}
          >
            {value === "result"
              ? "Results"
              : value === "question"
                ? "Questions"
                : value === "error"
                  ? "Errors"
                  : value === "unread"
                    ? "Unread"
                    : "All updates"}
          </button>
        ))}
      </div>
      {items.length ? (
        <div className="inbox-list">
          {items.map((item) => (
            <article
              className={`surface inbox-card ${item.read ? "is-read" : ""}`}
              key={item.id}
            >
              <span className={`inbox-kind kind-${item.kind}`}>
                {item.kind === "result" ? (
                  <CheckCircle2 size={19} />
                ) : item.kind === "question" ? (
                  <CircleHelp size={19} />
                ) : item.kind === "error" ? (
                  <CircleHelp size={19} />
                ) : (
                  <MessageSquare size={19} />
                )}
              </span>
              <div className="inbox-body">
                <div className="inbox-heading">
                  <h2>{item.title}</h2>
                  <time dateTime={item.createdAt}>
                    {formatDate(item.createdAt)}
                  </time>
                </div>
                <p>{item.body}</p>
                <div className="button-row">
                  <Link
                    className="text-link"
                    href={`/sessions/${item.sessionId}`}
                    onClick={() => {
                      if (!item.read)
                        void state.run(() =>
                          localApi(`/inbox/${item.id}/read`, "POST", {}),
                        );
                    }}
                  >
                    Open conversation
                    <ArrowUpRight size={13} />
                  </Link>
                  {!item.read ? (
                    <button
                      className="text-link muted"
                      disabled={state.busy}
                      onClick={() =>
                        void state.run(() =>
                          localApi(`/inbox/${item.id}/read`, "POST", {}),
                        )
                      }
                    >
                      Mark read
                    </button>
                  ) : (
                    <span className="read-label">
                      <Check size={12} />
                      Read
                    </span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Inbox size={29} />}
          title={
            filter === "all"
              ? "A quiet inbox is a good start"
              : "You're all caught up"
          }
          description={
            filter === "all"
              ? "When agents make progress, finish work, or need an answer, you will see it here."
              : "There are no updates in this filter."
          }
        />
      )}
    </div>
  );
}

export function ModelsView({ state, snapshot }: ViewProps) {
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState<ModelProfile | undefined>();
  return (
    <div className="page-content">
      <ViewHeader
        eyebrow="Intelligence, on your terms"
        title="Local models"
        description="Connect Ollama or LM Studio. Choose the model that fits the work, and switch whenever you need."
        action={
          <button
            className="button primary"
            onClick={() => {
              setEditing(undefined);
              setForm(true);
            }}
          >
            <Plus size={16} />
            Add model
          </button>
        }
      />
      {form ? (
        <ModelForm
          key={editing?.id ?? "new"}
          state={state}
          snapshot={snapshot}
          model={editing}
          close={() => setForm(false)}
        />
      ) : null}
      {snapshot.models.length ? (
        <div className="model-list">
          {snapshot.models.map((model) => (
            <article className="surface model-card" key={model.id}>
              <div className="model-heading">
                <span className="model-icon">
                  <Cpu size={25} />
                </span>
                <div>
                  <h2>{model.name}</h2>
                  <span>
                    {model.provider === "ollama" ? "Ollama" : "LM Studio"}
                    <span className="middle-dot">·</span>
                    {model.modelId}
                  </span>
                </div>
                <span
                  className={`tag ${model.status === "ready" ? "green" : model.status === "error" ? "red" : ""}`}
                >
                  {model.status === "ready"
                    ? "Ready"
                    : model.status === "error"
                      ? "Unavailable"
                      : "Not checked"}
                </span>
              </div>
              <div className="model-specs">
                <span>
                  <small>Endpoint</small>
                  {model.baseUrl}
                </span>
                <span>
                  <small>Context window</small>
                  {model.contextWindow.toLocaleString()} tokens
                </span>
                <span>
                  <small>Output limit</small>
                  {model.maxOutputTokens.toLocaleString()} tokens
                </span>
              </div>
              {model.capabilities?.vision && model.capabilities.tools ? (
                <p className="form-hint">
                  Screenshots verified for computer tasks
                </p>
              ) : null}
              {model.error ? (
                <p className="inline-error">{model.error}</p>
              ) : null}
              <div className="card-footer">
                <div className="button-row">
                  <button
                    className="button small subtle"
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(() =>
                        localApi(`/models/${model.id}/probe`, "POST", {}),
                      )
                    }
                  >
                    <RefreshCw size={13} />
                    Check connection
                  </button>
                  {snapshot.settings.defaultModelProfileId === model.id ? (
                    <span className="default-label">
                      <Check size={13} />
                      Default model
                    </span>
                  ) : (
                    <button
                      className="text-link"
                      disabled={state.busy}
                      onClick={() =>
                        void state.run(() =>
                          localApi("/settings", "PATCH", {
                            defaultModelProfileId: model.id,
                          }),
                        )
                      }
                    >
                      Make default
                    </button>
                  )}
                </div>
                <div className="button-row">
                  <button
                    className="icon-button"
                    aria-label={`Edit ${model.name}`}
                    onClick={() => {
                      setEditing(model);
                      setForm(true);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${model.name}`}
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(() =>
                        localApi(`/models/${model.id}`, "DELETE"),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Cpu size={31} />}
          title="Make room for your favorite model"
          description="Start a model server on your workstation, then connect its local endpoint. Your chats and project files stay under your control."
          action={
            <button className="button subtle" onClick={() => setForm(true)}>
              <Plus size={16} />
              Connect your first model
            </button>
          }
        />
      )}
      <div className="info-callout">
        <ShieldCheck size={19} />
        <div>
          <strong>A model switch is a fresh decision.</strong>
          <p>
            Running tasks keep the model they started with. Your new selection
            applies to subsequent tasks.
          </p>
        </div>
      </div>
    </div>
  );
}

function ModelForm({
  state,
  model,
  close,
}: ViewProps & { model?: ModelProfile; close: () => void }) {
  const [provider, setProvider] = useState<ModelProfile["provider"]>(
    model?.provider ?? "ollama",
  );
  const [baseUrl, setBaseUrl] = useState(
    model?.baseUrl ?? "http://127.0.0.1:11434/v1",
  );
  const [discovered, setDiscovered] = useState<{ id: string }[]>([]);
  const [modelId, setModelId] = useState(model?.modelId ?? "");
  return (
    <form
      className="surface form-panel"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = {
          name: form.get("name"),
          provider,
          baseUrl,
          modelId,
          contextWindow: Number(form.get("contextWindow")),
          maxOutputTokens: Number(form.get("maxOutputTokens")),
          temperature: Number(form.get("temperature")),
          visionEnabled: form.get("visionEnabled") === "on",
        };
        void state.run(async () => {
          await localApi(
            model ? `/models/${model.id}` : "/models",
            model ? "PATCH" : "POST",
            body,
          );
          close();
        });
      }}
    >
      <div className="form-heading">
        <h2>{model ? "Edit model profile" : "Connect a local model"}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close model form"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      <div className="form-grid">
        <Field
          label="Profile name"
          name="name"
          required
          placeholder="My coding model"
          defaultValue={model?.name}
        />
        <label className="form-field">
          <span>Model server</span>
          <select
            value={provider}
            onChange={(event) => {
              const value = event.target.value as ModelProfile["provider"];
              setProvider(value);
              setBaseUrl(
                value === "ollama"
                  ? "http://127.0.0.1:11434/v1"
                  : "http://127.0.0.1:1234/v1",
              );
              setDiscovered([]);
            }}
          >
            <option value="ollama">Ollama</option>
            <option value="lmstudio">LM Studio</option>
          </select>
        </label>
      </div>
      <label className="form-field">
        <span>OpenAI-compatible endpoint</span>
        <input
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          required
          placeholder="http://127.0.0.1:11434/v1"
        />
      </label>
      <div className="model-discovery">
        <label className="form-field">
          <span>Model ID</span>
          <input
            list="discovered-models"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            required
            placeholder="The model ID reported by your server"
          />
          <datalist id="discovered-models">
            {discovered.map((item) => (
              <option value={item.id} key={item.id} />
            ))}
          </datalist>
        </label>
        <button
          type="button"
          className="button subtle"
          disabled={state.busy || !baseUrl}
          onClick={() =>
            void state.run(async () => {
              const result = await localApi<{ models: { id: string }[] }>(
                "/model-discovery",
                "POST",
                { provider, baseUrl },
              );
              setDiscovered(result.models);
              if (!modelId && result.models[0]) setModelId(result.models[0].id);
            })
          }
        >
          <Search size={15} />
          Find models
        </button>
      </div>
      {discovered.length ? (
        <p className="form-hint">
          Found {discovered.length}{" "}
          {discovered.length === 1 ? "model" : "models"}. Choose one from the
          Model ID field.
        </p>
      ) : null}
      <label className="checkbox-row">
        <input
          type="checkbox"
          name="visionEnabled"
          defaultChecked={model?.visionEnabled ?? false}
        />
        Use screenshots for computer tasks
      </label>
      <p className="form-hint">
        Requires a local model that accepts images and tool calls. Check
        connection to test it.
      </p>
      <details className="advanced-options">
        <summary>Generation settings</summary>
        <div className="form-grid">
          <Field
            label="Context window (tokens)"
            name="contextWindow"
            type="number"
            min={1024}
            required
            defaultValue={model?.contextWindow ?? 16384}
          />
          <Field
            label="Maximum output tokens"
            name="maxOutputTokens"
            type="number"
            min={128}
            required
            defaultValue={model?.maxOutputTokens ?? 1024}
          />
          <Field
            label="Temperature"
            name="temperature"
            type="number"
            min={0}
            max={2}
            step={0.1}
            required
            defaultValue={model?.temperature ?? 0.3}
          />
        </div>
        <p className="form-hint">
          Use the limits your local server actually supports.
        </p>
      </details>
      <div className="button-row">
        <button className="button primary" disabled={state.busy}>
          <Cpu size={16} />
          {model ? "Save profile" : "Connect model"}
        </button>
        <button className="button subtle" type="button" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MemoryView({
  state,
  snapshot,
  dot,
}: ViewProps & { dot?: Dot }) {
  const companion = dot ?? activeDot(snapshot);
  const [scope, setScope] = useState<"general" | "dot">(
    companion ? "dot" : "general",
  );
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState<Memory | undefined>();
  const [query, setQuery] = useState("");
  const scopedMemories = snapshot.memories.filter(
    (memory) =>
      ownerId(memory) === (scope === "general" ? null : companion?.id),
  );
  const memories = scopedMemories.filter((memory) =>
    `${memory.title} ${memory.content}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="page-content">
      <ViewHeader
        eyebrow="Context that carries forward"
        title="Local memory"
        description="Save useful preferences and context. Inspect what your agents remember, correct it, or remove it."
        action={
          <button
            className="button primary"
            onClick={() => {
              setEditing(undefined);
              setForm(true);
            }}
          >
            <Plus size={16} />
            Add memory
          </button>
        }
      />
      <div className="memory-scope-control">
        <div className="scope-pill" role="group" aria-label="Memory scope">
          <button
            className={scope === "general" ? "is-active" : ""}
            aria-pressed={scope === "general"}
            onClick={() => {
              setScope("general");
              setForm(false);
              setEditing(undefined);
            }}
          >
            General
          </button>
          {companion ? (
            <button
              className={scope === "dot" ? "is-active" : ""}
              aria-pressed={scope === "dot"}
              onClick={() => {
                setScope("dot");
                setForm(false);
                setEditing(undefined);
              }}
            >
              {companion.name}&apos;s memory
            </button>
          ) : null}
        </div>
        <p className="muted">
          {scope === "general"
            ? "Preferences and context for your independent Chat and Work sessions."
            : `Private context remembered by ${companion?.name}.`}
        </p>
      </div>
      {form ? (
        <form
          key={editing?.id ?? "new"}
          className="surface form-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void state.run(async () => {
              await localApi(
                editing ? `/memories/${editing.id}` : "/memories",
                editing ? "PATCH" : "POST",
                {
                  ...(editing
                    ? {}
                    : {
                        dotId: scope === "general" ? null : companion?.id,
                      }),
                  title: values.get("title"),
                  content: values.get("content"),
                  source: editing?.source ?? "User-provided",
                },
              );
              setForm(false);
            });
          }}
        >
          <div className="form-heading">
            <h2>{editing ? "Edit memory" : "Something useful to remember"}</h2>
            <button
              className="icon-button"
              type="button"
              aria-label="Close memory form"
              onClick={() => setForm(false)}
            >
              <X size={16} />
            </button>
          </div>
          <Field
            label="Title"
            name="title"
            required
            defaultValue={editing?.title}
            placeholder="My coding preferences"
          />
          <label className="form-field">
            <span>Memory</span>
            <textarea
              aria-label="Memory"
              name="content"
              rows={4}
              required
              defaultValue={editing?.content}
              placeholder="Useful context you want available to future tasks…"
            />
          </label>
          <button className="button primary" disabled={state.busy}>
            Save memory
          </button>
        </form>
      ) : null}
      {scopedMemories.length ? (
        <>
          <label className="search-input">
            <Search size={17} />
            <span className="sr-only">Search memories</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your memories…"
            />
          </label>
          <div className="memory-grid">
            {memories.map((memory) => (
              <article className="surface memory-card" key={memory.id}>
                <div>
                  <BookOpen size={18} />
                  <div className="button-row">
                    <button
                      className="icon-button"
                      aria-label={`Edit ${memory.title}`}
                      onClick={() => {
                        setEditing(memory);
                        setForm(true);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Delete ${memory.title}`}
                      disabled={state.busy}
                      onClick={() =>
                        void state.run(() =>
                          localApi(`/memories/${memory.id}`, "DELETE"),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <h2>{memory.title}</h2>
                <p>{memory.content}</p>
                <small>Source: {memory.source ?? "Agent memory"}</small>
              </article>
            ))}
          </div>
          {!memories.length ? (
            <p className="muted">No memories match your search.</p>
          ) : null}
        </>
      ) : (
        <EmptyState
          icon={<BookOpen size={29} />}
          title="An assistant that knows the context"
          description="Add a preference, project note, or other useful context. Saved memories are available to subsequent tasks."
          action={
            <button className="button subtle" onClick={() => setForm(true)}>
              <Plus size={16} />
              Save your first memory
            </button>
          }
        />
      )}
    </div>
  );
}

export function SettingsView({ state, snapshot }: ViewProps) {
  const [saved, setSaved] = useState(false);
  const settings = snapshot.settings;
  return (
    <div className="page-content">
      <ViewHeader
        eyebrow="Make the workspace yours"
        title="Settings"
        description="Choose how much work your agents can take on, and how your local workspace feels."
      />
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const body: Record<string, unknown> = {
            defaultModelProfileId: form.get("defaultModelProfileId") || null,
            theme: form.get("theme"),
            sandboxImage: form.get("sandboxImage"),
            roleModelProfileIds: Object.fromEntries(
              ["coordinator", "coder", "investigator", "reviewer"].map(
                (role) => [role, form.get(`role-${role}`) || null],
              ),
            ),
          };
          for (const name of [
            "maxActiveTasks",
            "maxConcurrentInference",
            "maxDepth",
            "maxSteps",
            "maxToolCalls",
            "maxRunMinutes",
            "maxTokensPerGoal",
          ])
            body[name] = Number(form.get(name));
          void state.run(async () => {
            await localApi("/settings", "PATCH", body);
            setSaved(true);
          });
        }}
        onChange={() => setSaved(false)}
      >
        <section className="surface settings-section">
          <div className="settings-section-heading">
            <Settings2 size={18} />
            <div>
              <h2>Workspace</h2>
              <p>The defaults used for new conversations and tasks.</p>
            </div>
          </div>
          <div className="form-grid">
            <label className="form-field">
              <span>Default model</span>
              <select
                name="defaultModelProfileId"
                defaultValue={settings.defaultModelProfileId ?? ""}
              >
                <option value="">Choose at the start of each task</option>
                {snapshot.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>Appearance</span>
              <select
                key={settings.theme}
                name="theme"
                defaultValue={settings.theme}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">Follow system</option>
              </select>
            </label>
          </div>
          <div className="role-models-heading">
            <h3>Models by agent role</h3>
            <p>
              Leave a role unassigned to use the default. Running tasks keep
              their original model.
            </p>
          </div>
          <div className="form-grid">
            {(
              ["coordinator", "coder", "investigator", "reviewer"] as const
            ).map((role) => (
              <label className="form-field" key={role}>
                <span>
                  {role === "coordinator"
                    ? "Coordinator model"
                    : role === "coder"
                      ? "Coding model"
                      : role === "investigator"
                        ? "Investigation model"
                        : "Review model"}
                </span>
                <select
                  name={`role-${role}`}
                  defaultValue={settings.roleModelProfileIds?.[role] ?? ""}
                >
                  <option value="">Use default model</option>
                  {snapshot.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </section>
        <section className="surface settings-section">
          <div className="settings-section-heading">
            <Cpu size={18} />
            <div>
              <h2>Work and resource limits</h2>
              <p>Bound each run and keep the workstation responsive.</p>
            </div>
          </div>
          <div className="form-grid">
            <Field
              label="Concurrent tasks"
              name="maxActiveTasks"
              type="number"
              min={1}
              max={32}
              defaultValue={settings.maxActiveTasks}
              required
            />
            <Field
              label="Concurrent model requests"
              name="maxConcurrentInference"
              type="number"
              min={1}
              max={16}
              defaultValue={settings.maxConcurrentInference}
              required
            />
            <Field
              label="Maximum child-agent depth"
              name="maxDepth"
              type="number"
              min={0}
              max={10}
              defaultValue={settings.maxDepth}
              required
            />
            <Field
              label="Steps per run"
              name="maxSteps"
              type="number"
              min={1}
              defaultValue={settings.maxSteps}
              required
            />
            <Field
              label="Tool calls per run"
              name="maxToolCalls"
              type="number"
              min={1}
              defaultValue={settings.maxToolCalls}
              required
            />
            <Field
              label="Minutes per run"
              name="maxRunMinutes"
              type="number"
              min={1}
              defaultValue={settings.maxRunMinutes}
              required
            />
            <Field
              label="Tokens per goal"
              name="maxTokensPerGoal"
              type="number"
              min={1000}
              defaultValue={settings.maxTokensPerGoal}
              required
            />
          </div>
        </section>
        <section className="surface settings-section">
          <div className="settings-section-heading">
            <ShieldCheck size={18} />
            <div>
              <h2>Coding sandbox</h2>
              <p>
                Project commands run in an isolated container. External actions
                appear for approval.
              </p>
            </div>
          </div>
          <Field
            label="Container image"
            name="sandboxImage"
            defaultValue={settings.sandboxImage}
            required
          />
          <div className="sandbox-status">
            <span
              className={`status-dot ${snapshot.health.docker ? "online" : ""}`}
            />
            {snapshot.health.docker
              ? "Docker is available"
              : "Docker is unavailable — project commands cannot run yet"}
          </div>
        </section>
        <div className="settings-save">
          <button className="button primary" disabled={state.busy}>
            Save settings
          </button>
          {saved ? (
            <span className="saved-label" role="status">
              <Check size={15} />
              Settings saved
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}

export function TaskView({
  state,
  snapshot,
  detail,
  error,
}: ViewProps & { detail: TaskDetail | null; error: string | null }) {
  const [tab, setTab] = useState("overview");
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [applied, setApplied] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const task = detail?.task;
  useEffect(() => {
    setDiff(null);
    setApplied(false);
  }, [task?.id]);
  if (error)
    return (
      <div className="page-content">
        <EmptyState
          icon={<CircleHelp size={27} />}
          title="Unable to load this task"
          description={error}
        />
      </div>
    );
  if (!task || !detail)
    return (
      <div className="loading-row page-content">
        <LoaderCircle size={18} className="spin" />
        Loading workspace…
      </div>
    );
  const running = [
    "queued",
    "running",
    "waiting_approval",
    "waiting_child",
  ].includes(task.status);
  const project = snapshot.projects.find((item) => item.id === task.projectId);
  return (
    <div className="page-content coding-page">
      <Link className="back-link" href={`/sessions/${task.sessionId}`}>
        <ChevronRight size={13} className="rotate-back" />
        Back to conversation
      </Link>
      <ViewHeader
        eyebrow={`${task.role} session`}
        title={task.title}
        description={project ? project.path : "A local agent workspace"}
        action={<Status status={task.status} />}
      />
      <div className="coding-summary">
        <span>
          <Cpu size={15} />
          {task.profileSnapshot.name}
        </span>
        <span>
          <GitBranch size={15} />
          {task.workspace ? "Isolated workspace" : "Workspace not created yet"}
        </span>
        <span>
          <ShieldCheck size={15} />
          Changes reviewed before apply
        </span>
      </div>
      <div
        className="filter-tabs"
        role="group"
        aria-label="Coding workspace view"
      >
        {["overview", "changes", "tools"].map((value) => (
          <button
            className={tab === value ? "is-active" : ""}
            key={value}
            onClick={() => {
              setTab(value);
              if (value === "changes") {
                setLoadingDiff(true);
                void state
                  .run(async () => {
                    const data = await localApi<WorkspaceDiff>(
                      `/tasks/${task.id}/diff`,
                    );
                    setDiff(data);
                  })
                  .finally(() => setLoadingDiff(false));
              }
            }}
          >
            {value === "overview"
              ? "Overview"
              : value === "changes"
                ? "Changes"
                : "Tool output"}
          </button>
        ))}
      </div>
      {tab === "overview" ? (
        <>
          <section className="surface task-overview">
            <h2>The task</h2>
            <p>{task.prompt}</p>
            {task.result ? (
              <div className="task-result">
                <h3>Result</h3>
                {ownerId(task) !== null && task.role === "coordinator" ? (
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    {dotProse(task.result)}
                  </p>
                ) : (
                  <Markdown content={task.result} />
                )}
              </div>
            ) : null}
            {task.error ? (
              <p className="inline-error" role="alert">
                {task.error}
              </p>
            ) : null}
            <div className="button-row">
              {running ? (
                <button
                  className="button subtle"
                  disabled={state.busy}
                  onClick={() =>
                    void state.run(() =>
                      localApi(`/tasks/${task.id}/cancel`, "POST", {}),
                    )
                  }
                >
                  <Square size={13} />
                  Cancel task
                </button>
              ) : ["failed", "interrupted", "canceled"].includes(
                  task.status,
                ) ? (
                <button
                  className="button subtle"
                  disabled={state.busy}
                  onClick={() =>
                    void state.run(async () => {
                      const next = await localApi<Task>(
                        `/tasks/${task.id}/retry`,
                        "POST",
                        {},
                      );
                      window.location.assign(`/tasks/${next.id}`);
                    })
                  }
                >
                  <RefreshCw size={14} />
                  Retry task
                </button>
              ) : null}
            </div>
          </section>
          {task.workspace ? (
            <details className="surface workspace-details">
              <summary>Workspace details</summary>
              <pre>{JSON.stringify(task.workspace, null, 2)}</pre>
            </details>
          ) : null}
          {detail.children.length ? (
            <section>
              <div className="subsection-heading">
                <h2>Child agents</h2>
              </div>
              {detail.children.map((child) => (
                <Link
                  className="surface child-run"
                  key={child.id}
                  href={`/tasks/${child.id}`}
                >
                  <Code2 size={18} />
                  <span>
                    <strong>{child.title}</strong>
                    <small>{child.role}</small>
                  </span>
                  <Status status={child.status} />
                  <ArrowUpRight size={15} />
                </Link>
              ))}
            </section>
          ) : null}
        </>
      ) : tab === "changes" ? (
        <>
          {loadingDiff ? (
            <div className="loading-row">
              <LoaderCircle size={17} className="spin" />
              Loading actual workspace changes…
            </div>
          ) : diff?.patch ? (
            <div className="surface diff-card">
              <div className="diff-heading">
                <h2>
                  {diff.files.length} changed{" "}
                  {diff.files.length === 1 ? "file" : "files"}
                </h2>
                <div className="button-row">
                  <button
                    className="button small subtle"
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob([diff.patch], { type: "text/plain" }),
                      );
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = `dots-${task.id.slice(0, 8)}.patch`;
                      link.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download size={13} />
                    Export patch
                  </button>
                  <button
                    className="button small primary"
                    disabled={state.busy || applied || running}
                    onClick={() =>
                      void state.run(async () => {
                        await localApi(`/tasks/${task.id}/apply`, "POST", {});
                        setApplied(true);
                      })
                    }
                  >
                    <Check size={13} />
                    {applied ? "Applied" : "Apply changes"}
                  </button>
                </div>
              </div>
              <div className="diff-files">
                {diff.files.map((file) => (
                  <span key={file.path}>
                    <FileText size={12} />
                    {file.path}
                  </span>
                ))}
              </div>
              <pre className="diff-output">
                {diff.patch.split("\n").map((line, index) => (
                  <span
                    key={index}
                    className={
                      line.startsWith("+")
                        ? "diff-add"
                        : line.startsWith("-")
                          ? "diff-remove"
                          : line.startsWith("@@")
                            ? "diff-location"
                            : ""
                    }
                  >
                    {line || " "}
                  </span>
                ))}
              </pre>
              {diff.truncated ? (
                <p className="form-hint diff-hint">
                  This patch preview is truncated. Inspect the workspace before
                  applying.
                </p>
              ) : null}
              {running ? (
                <p className="form-hint diff-hint">
                  Review changes while the task runs. Applying becomes available
                  when the task stops.
                </p>
              ) : null}
            </div>
          ) : (
            <EmptyState
              icon={<GitBranch size={26} />}
              title="No changes to review yet"
              description="The agent's actual file changes will appear here when it creates them."
            />
          )}
        </>
      ) : detail.operations.length ? (
        <div className="tool-output-list">
          {detail.operations.map((operation) => (
            <details
              className="surface tool-output"
              key={operation.id}
              open={operation.status === "failed"}
            >
              <summary>
                <Code2 size={16} />
                <strong>{operation.toolName}</strong>
                <Status status={operation.status} />
              </summary>
              <div>
                <h3>Input</h3>
                <pre>{JSON.stringify(operation.input, null, 2)}</pre>
                {operation.result !== undefined ? (
                  <>
                    <h3>Result</h3>
                    <pre>
                      {typeof operation.result === "string"
                        ? operation.result
                        : JSON.stringify(operation.result, null, 2)}
                    </pre>
                  </>
                ) : null}
                {operation.error ? (
                  <p className="inline-error">{operation.error}</p>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Code2 size={27} />}
          title="Tool output belongs here"
          description="File operations, executed commands, exit codes, and test output appear as the agent works."
        />
      )}
    </div>
  );
}

function ViewHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="view-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="view-header-action">{action}</div> : null}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}

function ModelPicker({
  snapshot,
  value,
  onChange,
}: {
  snapshot: Snapshot;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="form-field">
      <span>Model</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      >
        <option value="">Choose a local model</option>
        {snapshot.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function toLocalDateInput(value: string) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
