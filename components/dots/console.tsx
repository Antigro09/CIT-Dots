"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CirclePause,
  CirclePlay,
  Code2,
  Cpu,
  Folder,
  Inbox,
  LoaderCircle,
  Menu,
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Approval, Task } from "@/src/shared/types";
import {
  localApi,
  useDetail,
  useLocal,
  type LocalState,
  type Snapshot,
  type TaskDetail,
} from "./use-local";
import {
  ChatView,
  GoalsView,
  InboxView,
  MemoryView,
  ModelsView,
  ProjectsView,
  SettingsView,
  TaskView,
} from "./views";

export type Section =
  | "chat"
  | "projects"
  | "goals"
  | "inbox"
  | "models"
  | "memory"
  | "settings"
  | "task";
const navigation = [
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "projects", label: "Projects", icon: Folder },
  { key: "goals", label: "Goals", icon: CirclePlay },
  { key: "inbox", label: "Inbox", icon: Inbox },
  { key: "models", label: "Models", icon: Cpu },
  { key: "memory", label: "Memory", icon: BookOpen },
  { key: "settings", label: "Settings", icon: Settings2 },
] as const;

export function DotsConsole({
  section = "chat",
  sessionId,
  taskId,
  projectId,
}: {
  section?: Section;
  sessionId?: string;
  taskId?: string;
  projectId?: string;
}) {
  const state = useLocal();
  const { snapshot, connection } = state;
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [chosenTask, setChosenTask] = useState<string | null>(null);
  const selectedTaskId = taskId ?? chosenTask;
  const detail = useDetail<TaskDetail>(
    selectedTaskId ? `/tasks/${selectedTaskId}` : null,
    snapshot?.eventsCursor ?? 0,
  );
  const unread = snapshot?.inbox.filter((item) => !item.read).length ?? 0;
  const active =
    snapshot?.tasks.filter((task) =>
      ["queued", "running", "waiting_approval", "waiting_child"].includes(
        task.status,
      ),
    ) ?? [];
  const currentSession = snapshot?.sessions.find(
    (session) => session.id === sessionId,
  );
  const title =
    section === "task"
      ? (detail.data?.task.title ?? "Coding workspace")
      : sessionId
        ? (currentSession?.title ?? "Conversation")
        : (navigation.find((item) => item.key === section)?.label ?? "Chat");
  const theme = snapshot?.settings.theme ?? "dark";
  useEffect(() => {
    if (window.matchMedia("(max-width: 960px)").matches)
      setInspectorOpen(false);
  }, []);

  return (
    <div className="dots-console" data-theme={theme}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {navOpen ? (
        <button
          className="drawer-backdrop"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <aside
        className={`dots-sidebar ${navOpen ? "is-open" : ""}`}
        aria-label="Main navigation"
      >
        <div className="brand">
          <Link
            href="/"
            className="brand-link"
            onClick={() => setNavOpen(false)}
          >
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>
              CIT Dots
              <span className="brand-caption">Your local AI workspace</span>
            </span>
          </Link>
          <button
            type="button"
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={(event) => {
              event.preventDefault();
              setNavOpen(false);
            }}
          >
            <X size={17} />
          </button>
        </div>
        <Link
          href="/chat"
          className="new-chat"
          onClick={() => setNavOpen(false)}
        >
          <Plus size={17} />
          New conversation
        </Link>
        <nav className="primary-nav">
          {navigation.map((item) => (
            <Link
              key={item.key}
              href={`/${item.key}`}
              className={`nav-item ${section === item.key ? "is-active" : ""}`}
              aria-current={section === item.key ? "page" : undefined}
              onClick={() => setNavOpen(false)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.key === "inbox" && unread > 0 ? (
                <span className="nav-count">{unread}</span>
              ) : item.key === "goals" &&
                snapshot?.goals.some((goal) => goal.enabled) ? (
                <span className="nav-indicator" />
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="sidebar-recents">
          <div className="sidebar-label">Recent conversations</div>
          {snapshot?.sessions.length ? (
            snapshot.sessions.slice(0, 8).map((session) => (
              <Link
                className={`recent-item ${sessionId === session.id ? "is-active" : ""}`}
                key={session.id}
                href={`/sessions/${session.id}`}
                onClick={() => setNavOpen(false)}
              >
                <MessageSquare size={14} />
                <span>{session.title}</span>
              </Link>
            ))
          ) : (
            <p className="sidebar-empty">
              Your conversations will appear here.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span
              className={`status-dot ${connection === "connected" ? "online" : ""}`}
            />
            <span>
              <strong>
                {connection === "loading"
                  ? "Connecting"
                  : connection === "offline"
                    ? "Service offline"
                    : snapshot?.settings.paused
                      ? "Background work paused"
                      : "Local workspace connected"}
              </strong>
              <small>
                {connection === "connected"
                  ? "Runs on your workstation"
                  : "Waiting for the local service"}
              </small>
            </span>
            <ShieldCheck size={17} />
          </div>
          <div className="profile-row">
            <span className="avatar">Y</span>
            <span>
              You<small>Local workspace</small>
            </span>
            <button
              className="icon-button"
              aria-label={
                theme === "light"
                  ? "Switch to dark theme"
                  : "Switch to light theme"
              }
              disabled={!snapshot || state.busy}
              onClick={() =>
                void state.run(() =>
                  localApi("/settings", "PATCH", {
                    theme: theme === "light" ? "dark" : "light",
                  }),
                )
              }
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
          </div>
        </div>
      </aside>

      <div className="dots-workspace">
        <header className="workspace-header">
          <div className="header-title">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setNavOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span>{title}</span>
          </div>
          <div className="header-actions">
            <span className="local-badge">
              <ShieldCheck size={12} />
              Local first
            </span>
            {snapshot ? (
              <button
                className="header-pause"
                disabled={state.busy}
                onClick={() =>
                  void state.run(() =>
                    localApi("/settings", "PATCH", {
                      paused: !snapshot.settings.paused,
                    }),
                  )
                }
              >
                {snapshot.settings.paused ? (
                  <CirclePlay size={15} />
                ) : (
                  <CirclePause size={15} />
                )}
                <span>{snapshot.settings.paused ? "Resume" : "Pause"}</span>
              </button>
            ) : null}
            <button
              className={`icon-button ${inspectorOpen ? "is-selected" : ""}`}
              aria-label={
                inspectorOpen ? "Hide task activity" : "Show task activity"
              }
              aria-expanded={inspectorOpen}
              aria-controls="activity-panel"
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              {inspectorOpen ? (
                <PanelRightClose size={19} />
              ) : (
                <PanelRightOpen size={19} />
              )}
            </button>
          </div>
        </header>
        {state.error ? (
          <div className="error-banner" role="alert">
            <CircleHelp size={18} />
            <span>{state.error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={state.clearError}
            >
              <X size={16} />
            </button>
          </div>
        ) : null}
        <div className="workspace-body">
          <main id="main-content" className="dots-main" tabIndex={-1}>
            {snapshot ? (
              section === "chat" ? (
                <ChatView
                  key={sessionId ?? "new"}
                  state={state}
                  snapshot={snapshot}
                  sessionId={sessionId}
                  selectTask={setChosenTask}
                />
              ) : section === "projects" ? (
                <ProjectsView
                  state={state}
                  snapshot={snapshot}
                  projectId={projectId}
                />
              ) : section === "goals" ? (
                <GoalsView state={state} snapshot={snapshot} />
              ) : section === "inbox" ? (
                <InboxView state={state} snapshot={snapshot} />
              ) : section === "models" ? (
                <ModelsView state={state} snapshot={snapshot} />
              ) : section === "memory" ? (
                <MemoryView state={state} snapshot={snapshot} />
              ) : section === "settings" ? (
                <SettingsView state={state} snapshot={snapshot} />
              ) : (
                <TaskView
                  state={state}
                  snapshot={snapshot}
                  detail={detail.data}
                  error={detail.error}
                />
              )
            ) : (
              <div className="connection-empty">
                <span className="large-brand">
                  <Sparkles size={26} />
                </span>
                <h1>
                  {connection === "offline"
                    ? "Your workspace is offline"
                    : "Opening your workspace"}
                </h1>
                <p>
                  {connection === "offline"
                    ? "Start the local services to reconnect to your conversations and background work."
                    : "Connecting to your local agent service…"}
                </p>
                {connection === "offline" ? (
                  <button
                    className="button primary"
                    onClick={() => void state.refresh()}
                  >
                    Try again
                  </button>
                ) : (
                  <LoaderCircle className="spin muted" size={22} />
                )}
              </div>
            )}
          </main>
          {inspectorOpen ? (
            <aside
              id="activity-panel"
              className="activity-panel"
              aria-label="Task activity"
            >
              <div className="activity-heading">
                <Activity size={16} />
                <h2>Activity</h2>
                <span className={`activity-live ${state.live ? "live" : ""}`}>
                  {state.live ? "Live" : "Polling"}
                </span>
                <button
                  className="icon-button mobile-only"
                  aria-label="Close task activity"
                  onClick={() => setInspectorOpen(false)}
                >
                  <X size={17} />
                </button>
              </div>
              {snapshot ? (
                <ActivityPanel
                  state={state}
                  snapshot={snapshot}
                  active={active}
                  selected={detail.data}
                  selectedError={detail.error}
                  selectTask={(id) => {
                    if (taskId) router.push(`/tasks/${id}`);
                    else setChosenTask(id);
                  }}
                  clearTask={() => {
                    if (taskId)
                      router.push(
                        `/sessions/${detail.data?.task.sessionId ?? ""}`,
                      );
                    else setChosenTask(null);
                  }}
                />
              ) : (
                <p className="panel-description">
                  Activity appears when the service connects.
                </p>
              )}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActivityPanel({
  state,
  snapshot,
  active,
  selected,
  selectedError,
  selectTask,
  clearTask,
}: {
  state: LocalState;
  snapshot: Snapshot;
  active: Task[];
  selected: TaskDetail | null;
  selectedError: string | null;
  selectTask: (id: string) => void;
  clearTask: () => void;
}) {
  const pending = snapshot.approvals.filter(
    (approval) => approval.status === "pending",
  );
  const recent = snapshot.tasks
    .filter((task) =>
      ["completed", "failed", "canceled", "interrupted"].includes(task.status),
    )
    .slice(0, 4);
  return (
    <div className="activity-content">
      {selectedError ? (
        <p className="inline-error" role="alert">
          {selectedError}
        </p>
      ) : null}
      {selected ? (
        <div className="selected-task">
          <button className="back-link" onClick={clearTask}>
            <ArrowLeft size={14} />
            All activity
          </button>
          <div className="task-detail-label">
            {selected.task.role} · level {selected.task.depth}
          </div>
          <h3>{selected.task.title}</h3>
          <Status status={selected.task.status} />
          <p className="panel-description">{selected.task.prompt}</p>
          <dl className="task-facts">
            <div>
              <dt>Model</dt>
              <dd>
                {selected.task.profileSnapshot?.name ??
                  selected.task.modelProfileId}
              </dd>
            </div>
            <div>
              <dt>Tool calls</dt>
              <dd>{selected.task.toolCount ?? 0}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{selected.task.tokenUsage?.toLocaleString() ?? "—"}</dd>
            </div>
          </dl>
          {selected.task.error ? (
            <p className="inline-error">{selected.task.error}</p>
          ) : null}
          <Link
            className="button subtle full"
            href={`/tasks/${selected.task.id}`}
          >
            <Code2 size={15} />
            Open workspace
            <ArrowUpRight size={14} />
          </Link>
          {selected.children.length ? (
            <div className="panel-section">
              <h3>Child agents</h3>
              {selected.children.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onClick={() => selectTask(task.id)}
                />
              ))}
            </div>
          ) : null}
          {selected.operations.length ? (
            <div className="panel-section">
              <h3>Tool activity</h3>
              {selected.operations.slice(-8).map((operation) => (
                <details className="operation" key={operation.id}>
                  <summary>
                    <Code2 size={13} />
                    <span>{operation.toolName}</span>
                    <Status status={operation.status} />
                  </summary>
                  <pre>{JSON.stringify(operation.input, null, 2)}</pre>
                  {operation.result !== undefined ? (
                    <pre>
                      {typeof operation.result === "string"
                        ? operation.result
                        : JSON.stringify(operation.result, null, 2)}
                    </pre>
                  ) : null}
                  {operation.error ? (
                    <p className="inline-error">{operation.error}</p>
                  ) : null}
                </details>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="panel-section">
            <div className="section-mini-title">
              <h3>Working now</h3>
              <span>{active.length}</span>
            </div>
            {active.length ? (
              active.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onClick={() => selectTask(task.id)}
                />
              ))
            ) : (
              <div className="quiet-state">
                <span className="quiet-icon">
                  <Check size={17} />
                </span>
                <strong>All quiet for now</strong>
                <p>
                  Active tasks and child agents will appear here as they work.
                </p>
              </div>
            )}
          </div>
          {recent.length ? (
            <div className="panel-section">
              <h3>Recently finished</h3>
              {recent.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onClick={() => selectTask(task.id)}
                />
              ))}
            </div>
          ) : null}
        </>
      )}
      {pending.length ? (
        <div className="panel-section">
          <div className="section-mini-title">
            <h3>Needs your decision</h3>
            <span className="amber">{pending.length}</span>
          </div>
          {pending.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} state={state} />
          ))}
        </div>
      ) : null}
      <div className="panel-footnote">
        <Bell size={14} />
        <p>
          Progress, results, and questions are saved in your inbox. Work
          continues when you close this window.
        </p>
      </div>
      <div className="service-health">
        <span>
          <span
            className={`status-dot ${snapshot.health.eve ? "online" : ""}`}
          />
          Agent worker {snapshot.health.eve ? "ready" : "offline"}
        </span>
        <span>
          <span
            className={`status-dot ${snapshot.health.docker ? "online" : ""}`}
          />
          Code sandbox {snapshot.health.docker ? "ready" : "unavailable"}
        </span>
      </div>
    </div>
  );
}

function ApprovalCard({
  approval,
  state,
}: {
  approval: Approval;
  state: LocalState;
}) {
  const [answer, setAnswer] = useState("");
  const isQuestion = approval.toolName === "ask_user";
  return (
    <div className="approval-card">
      <div className="approval-title">
        {isQuestion ? <CircleHelp size={16} /> : <ShieldCheck size={16} />}
        {isQuestion ? "A question for you" : approval.toolName}
      </div>
      <p>{approval.description}</p>
      {isQuestion ? (
        <>
          <label className="sr-only" htmlFor={`answer-${approval.id}`}>
            Your answer
          </label>
          <textarea
            id={`answer-${approval.id}`}
            className="approval-answer"
            rows={3}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Type your answer…"
          />
          <div className="button-row">
            <button
              className="button small primary"
              disabled={state.busy || !answer.trim()}
              onClick={() =>
                void state.run(() =>
                  localApi(`/approvals/${approval.id}/decide`, "POST", {
                    decision: "approve",
                    answer: answer.trim(),
                  }),
                )
              }
            >
              Send answer
            </button>
            <button
              className="button small subtle"
              disabled={state.busy}
              onClick={() =>
                void state.run(() =>
                  localApi(`/approvals/${approval.id}/decide`, "POST", {
                    decision: "deny",
                  }),
                )
              }
            >
              Skip
            </button>
          </div>
        </>
      ) : (
        <>
          <details>
            <summary>Review exact action</summary>
            <pre>{JSON.stringify(approval.input, null, 2)}</pre>
          </details>
          <div className="button-row">
            <button
              className="button small primary"
              disabled={state.busy}
              onClick={() =>
                void state.run(() =>
                  localApi(`/approvals/${approval.id}/decide`, "POST", {
                    decision: "approve",
                  }),
                )
              }
            >
              Allow once
            </button>
            <button
              className="button small subtle"
              disabled={state.busy}
              onClick={() =>
                void state.run(() =>
                  localApi(`/approvals/${approval.id}/decide`, "POST", {
                    decision: "deny",
                  }),
                )
              }
            >
              Deny
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function TaskCard({
  task,
  onClick,
}: {
  task: Task;
  onClick: () => void;
}) {
  return (
    <button className="task-card" onClick={onClick}>
      <span className="task-card-icon">
        {task.role === "coder" ? (
          <Code2 size={15} />
        ) : task.role === "reviewer" ? (
          <ShieldCheck size={15} />
        ) : (
          <Sparkles size={15} />
        )}
      </span>
      <span className="task-card-main">
        <strong>{task.title}</strong>
        <span>
          {task.role}
          <span className="middle-dot">·</span>
          <Status status={task.status} />
        </span>
      </span>
      <ChevronRight size={13} />
    </button>
  );
}

export function Status({ status }: { status: string }) {
  const label = status.replaceAll("_", " ");
  return (
    <span className={`status-label status-${status}`}>
      <span />
      {label}
    </span>
  );
}
