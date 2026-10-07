"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Computer,
  Download,
  Folder,
  Heart,
  LoaderCircle,
  MessageSquare,
  Palette,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { Dot, DotAvatarKind, Snapshot } from "@/src/shared/types";
import { activeDot, ownerId } from "./identity";
import {
  localApi,
  useDetail,
  type LocalState,
  type SessionDetail,
} from "./use-local";
import { fileSizeLabel } from "./message-files";
import { PetAvatar, type PetMood } from "./pet";
import type { ComputerInfo } from "./computer";

export function dotMood(snapshot: Snapshot, dotId: string): PetMood {
  const tasks = snapshot.tasks.filter((task) => ownerId(task) === dotId);
  return tasks.some((task) => task.status === "waiting_approval")
    ? "question"
    : tasks.some((task) => ["running", "waiting_child"].includes(task.status))
      ? "working"
      : "idle";
}

export function DotRail({
  state,
  snapshot,
  selected,
  select,
}: {
  state: LocalState;
  snapshot: Snapshot;
  selected?: Dot;
  select: (id: string) => void;
}) {
  return (
    <nav className="dot-rail" aria-label="Your Dots">
      <Link className="rail-home" href="/dots" aria-label="Your Dots home">
        <Sparkles size={20} />
      </Link>
      <div className="rail-pets">
        {(snapshot.dots ?? []).map((dot) => (
          <button
            key={dot.id}
            className={`rail-pet ${selected?.id === dot.id ? "is-active" : ""}`}
            aria-label={`Select ${dot.name}`}
            aria-pressed={selected?.id === dot.id}
            title={dot.name}
            onClick={() => select(dot.id)}
            disabled={state.busy}
          >
            <PetAvatar dot={dot} mood={dotMood(snapshot, dot.id)} />
            {dot.isPrimary ? (
              <span className="rail-primary" title="Your permanent first Dot">
                <Heart size={8} fill="currentColor" />
              </span>
            ) : null}
            <span className="rail-pet-tooltip">{dot.name}</span>
          </button>
        ))}
      </div>
      <Link
        className="rail-add"
        href="/dots?add=1"
        aria-label="Create another Dot"
        title="Add a Dot"
      >
        <Plus size={19} />
      </Link>
      <span className="rail-divider" />
      <span className="rail-footprint" aria-hidden="true">
        ••
      </span>
    </nav>
  );
}

export function CurrentDotCard({
  dot,
  snapshot,
}: {
  dot: Dot;
  snapshot: Snapshot;
}) {
  const mood = dotMood(snapshot, dot.id);
  return (
    <Link href="/dots" className="current-dot-card">
      <span className="current-dot-pet">
        <PetAvatar dot={dot} mood={mood} />
      </span>
      <span>
        <strong>{dot.name}</strong>
        <small>{dot.isPrimary ? "Your first Dot" : "Your companion"}</small>
      </span>
      <ChevronDown size={13} />
    </Link>
  );
}

export function DotsView({
  state,
  snapshot,
}: {
  state: LocalState;
  snapshot: Snapshot;
}) {
  const router = useRouter();
  const dot = activeDot(snapshot);
  const [editing, setEditing] = useState<Dot | null>(null);
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<Dot | null>(null);
  const [queryHandled, setQueryHandled] = useState(false);
  const wantsAdd =
    !queryHandled &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("add") === "1";
  const editId =
    !queryHandled && typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("edit")
      : null;
  const editedDot = editing ?? snapshot.dots.find((item) => item.id === editId);
  if (!dot)
    return (
      <div className="loading-row">
        <LoaderCircle size={17} className="spin" />
        Loading your Dots…
      </div>
    );
  const mood = dotMood(snapshot, dot.id);
  const taskCount = snapshot.tasks.filter(
    (task) =>
      ownerId(task) === dot.id &&
      ["queued", "running", "waiting_approval", "waiting_child"].includes(
        task.status,
      ),
  ).length;
  const model = snapshot.models.find(
    (profile) => profile.id === dot.modelProfileId,
  );
  async function select(id: string) {
    await state.run(async () => {
      await localApi("/settings", "PATCH", { selectedDotId: id });
      setEditing(null);
      router.push(`/dots/${id}`);
    });
  }

  return (
    <div className="page-content dots-home">
      <div className="view-header">
        <div>
          <span className="eyebrow">A companion with a place of its own</span>
          <h1>Your Dots</h1>
          <p>
            Give each Dot a name, a personality, and its own computer to work
            in.
          </p>
        </div>
        <div className="view-header-action">
          <button
            className="button primary"
            onClick={() => {
              setQueryHandled(true);
              setAdding(true);
              setEditing(null);
            }}
          >
            <Plus size={16} />
            Add a Dot
          </button>
        </div>
      </div>
      <section className="surface companion-home">
        <div
          className="companion-stage"
          style={{ "--pet-color": dot.avatar.color } as React.CSSProperties}
        >
          <span className="stage-orbit orbit-one" />
          <span className="stage-orbit orbit-two" />
          <span className="stage-spark spark-one">✦</span>
          <span className="stage-spark spark-two">✧</span>
          <PetAvatar dot={dot} mood={mood} className="hero-pet" />
          <span className="pet-stage-status">
            <span
              className={`status-dot ${mood === "working" ? "online" : ""}`}
            />
            {mood === "working"
              ? "Working on something"
              : mood === "question"
                ? "Has a question for you"
                : "At home"}
          </span>
        </div>
        <div className="companion-intro">
          <span className={`tag ${dot.isPrimary ? "primary-dot-tag" : ""}`}>
            {dot.isPrimary ? (
              <Heart size={11} fill="currentColor" />
            ) : (
              <Sparkles size={11} />
            )}
            {dot.isPrimary ? "Your permanent first Dot" : "Your Dot"}
          </span>
          <h2>Meet {dot.name}.</h2>
          <p>
            {dot.personality ||
              "A curious local companion, ready to make something useful with you."}
          </p>
          <div className="companion-model">
            <span>Default model</span>
            <strong>{model?.name ?? "Workspace default"}</strong>
          </div>
          <div className="companion-actions">
            <Link className="button primary" href={`/dots/${dot.id}`}>
              <MessageSquare size={15} />
              Chat with {dot.name}
            </Link>
            <Link className="button subtle" href={`/dots/${dot.id}/computer`}>
              <Computer size={15} />
              Open computer
            </Link>
            <button
              className="text-link"
              onClick={() => {
                setQueryHandled(true);
                setEditing(dot);
                setAdding(false);
              }}
            >
              <Palette size={14} />
              Personalize {dot.name}
            </button>
          </div>
          <div className="companion-home-footnote">
            <ShieldCheck size={14} />
            <span>
              {taskCount
                ? `${taskCount} ${taskCount === 1 ? "task" : "tasks"} in progress`
                : "Its chats, memory, and files stay on this workstation."}
            </span>
          </div>
        </div>
      </section>
      {adding || editedDot || wantsAdd ? (
        <DotForm
          key={editedDot?.id ?? "new"}
          state={state}
          snapshot={snapshot}
          dot={editedDot ?? undefined}
          close={() => {
            setAdding(false);
            setEditing(null);
            setQueryHandled(true);
            router.replace("/dots");
          }}
        />
      ) : null}
      <div className="subsection-heading">
        <h2>
          Your companions{" "}
          <span className="dot-count">{snapshot.dots?.length ?? 0}</span>
        </h2>
        <span className="muted">A separate space for every Dot</span>
      </div>
      <div className="companion-grid">
        {(snapshot.dots ?? []).map((item) => (
          <article
            className={`surface companion-card ${item.id === dot.id ? "is-selected" : ""}`}
            key={item.id}
          >
            <button
              className="companion-select"
              aria-label={`Open ${item.name}'s home`}
              onClick={() => void select(item.id)}
              disabled={state.busy}
            >
              <PetAvatar dot={item} mood={dotMood(snapshot, item.id)} />
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.isPrimary
                    ? "Your first Dot · Permanent"
                    : "Personal companion"}
                </small>
              </span>
              {item.id === dot.id ? (
                <Check size={15} />
              ) : (
                <ArrowUpRight size={15} />
              )}
            </button>
            <p>{item.personality || "Ready to find its personality."}</p>
            <div className="card-footer">
              <button
                className="text-link"
                onClick={() => {
                  setEditing(item);
                  setAdding(false);
                  setQueryHandled(true);
                }}
              >
                <Pencil size={12} />
                Personalize
              </button>
              <button
                className="icon-button"
                aria-label={`Remove ${item.name}`}
                title={
                  item.isPrimary
                    ? "Your first Dot is permanent and cannot be removed."
                    : `Remove ${item.name}`
                }
                disabled={item.isPrimary || state.busy}
                onClick={() => setRemove(item)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {remove ? (
        <section
          className="surface remove-dot-panel"
          role="alertdialog"
          aria-labelledby="remove-dot-title"
          aria-describedby="remove-dot-description"
        >
          <div>
            <h2 id="remove-dot-title">Remove {remove.name}?</h2>
            <p id="remove-dot-description">
              This stops its work and removes its conversations, memory, and
              private computer files. Your original project folders stay intact.
            </p>
          </div>
          <div className="button-row">
            <button
              className="button danger"
              disabled={state.busy}
              onClick={() =>
                void state.run(async () => {
                  await localApi(`/dots/${remove.id}`, "DELETE");
                  setRemove(null);
                })
              }
            >
              Remove Dot
            </button>
            <button className="button subtle" onClick={() => setRemove(null)}>
              Keep {remove.name}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function DotIdentityCard({
  state,
  snapshot,
  dot,
}: {
  state: LocalState;
  snapshot: Snapshot;
  dot: Dot;
}) {
  const mood = dotMood(snapshot, dot.id);
  const computer = useDetail<ComputerInfo>(
    `/dots/${dot.id}/computer`,
    snapshot.eventsCursor,
    5000,
  );
  const sessionId =
    dot.sessionId ??
    snapshot.sessions.find(
      (session) => session.kind === "dot" && ownerId(session) === dot.id,
    )?.id;
  const conversation = useDetail<SessionDetail>(
    sessionId ? `/sessions/${sessionId}` : null,
    snapshot.eventsCursor,
  );
  const outputs = [
    ...new Map(
      conversation.data?.messages
        .slice()
        .reverse()
        .flatMap((message) => message.files ?? [])
        .map((file) => [file.id, file]),
    ).values(),
  ].slice(0, 4);
  const desktop = computer.data?.desktop;
  return (
    <div className="dot-identity-wrap">
      <section className="dot-identity-card">
        <div className="identity-pet">
          <PetAvatar dot={dot} mood={mood} />
        </div>
        <div className="identity-name">
          <h2>{dot.name}</h2>
          <Link
            className="icon-button"
            href={`/dots?edit=${dot.id}`}
            aria-label={`Personalize ${dot.name}`}
          >
            <Pencil size={14} />
          </Link>
        </div>
        <span className="identity-status">
          <span
            className={`status-dot ${mood === "working" ? "online" : ""}`}
          />
          {snapshot.settings.paused
            ? "Background work paused"
            : mood === "working"
              ? "Working"
              : mood === "question"
                ? "Has a question for you"
                : "At home"}
        </span>
        {dot.isPrimary ? (
          <span className="identity-primary">
            <Heart size={10} />
            Your first Dot
          </span>
        ) : null}
        <p>{dot.personality}</p>
        <Link className="identity-computer" href={`/dots/${dot.id}/computer`}>
          <span className="identity-computer-icon">
            <Computer size={17} />
          </span>
          <span>
            <strong>Computer</strong>
            <small>
              {desktop?.state === "running"
                ? "Connected · Ubuntu desktop"
                : desktop?.state === "starting"
                  ? "Starting desktop"
                  : desktop?.state === "error"
                    ? "Needs setup"
                    : desktop
                      ? "Desktop stopped"
                      : "Checking status"}
            </small>
          </span>
          <span
            className={`status-dot ${desktop?.state === "running" ? "online" : ""}`}
          />
          <ArrowUpRight size={13} />
        </Link>
      </section>
      <div className="identity-output-files">
        <div className="section-mini-title">
          <h3>Output files</h3>
          <Link
            href={`/dots/${dot.id}/computer?tab=files`}
            aria-label={`Open ${dot.name}'s files`}
          >
            <ArrowUpRight size={12} />
          </Link>
        </div>
        {outputs.length ? (
          outputs.map((file) => (
            <a
              key={file.id}
              href={`/api/local/files/${encodeURIComponent(file.id)}`}
              download={file.name}
              aria-label={`Download ${file.name}, ${fileSizeLabel(file.size)}`}
              title={`Download ${file.name} · ${fileSizeLabel(file.size)}`}
            >
              <Download size={13} aria-hidden="true" />
              <span>{file.name}</span>
            </a>
          ))
        ) : (
          <p>
            {conversation.error
              ? "Files are unavailable."
              : "Files your Dot shares with you appear here."}
          </p>
        )}
      </div>
    </div>
  );
}

function DotForm({
  state,
  snapshot,
  dot,
  close,
}: {
  state: LocalState;
  snapshot: Snapshot;
  dot?: Dot;
  close: () => void;
}) {
  const [name, setName] = useState(dot?.name ?? "");
  const [personality, setPersonality] = useState(dot?.personality ?? "");
  const [kind, setKind] = useState<DotAvatarKind>(dot?.avatar.kind ?? "blob");
  const [color, setColor] = useState(dot?.avatar.color ?? "#a7e8c7");
  const [model, setModel] = useState(dot?.modelProfileId ?? "");
  const preview = {
    name: name.trim() || "Your new Dot",
    avatar: { kind, color },
  };
  const kinds: DotAvatarKind[] = ["blob", "cat", "dog", "robot"];
  const colors = [
    "#a7e8c7",
    "#b9c8f2",
    "#f1be93",
    "#e8b5d3",
    "#eadb96",
    "#9bd8e7",
  ];
  return (
    <form
      className="surface form-panel dot-form"
      onSubmit={(event) => {
        event.preventDefault();
        const body = {
          name: name.trim(),
          personality: personality.trim(),
          avatar: { kind, color },
          modelProfileId: model || null,
        };
        void state.run(async () => {
          const saved = await localApi<Dot>(
            dot ? `/dots/${dot.id}` : "/dots",
            dot ? "PATCH" : "POST",
            body,
          );
          if (!dot)
            await localApi("/settings", "PATCH", { selectedDotId: saved.id });
          close();
        });
      }}
    >
      <div className="form-heading">
        <h2>{dot ? `Personalize ${dot.name}` : "Make a new friend"}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close Dot form"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      <div className="dot-form-body">
        <div className="dot-preview">
          <PetAvatar dot={preview} />
          <strong>{name.trim() || "Your new Dot"}</strong>
          <span>
            {dot?.isPrimary
              ? "Your first Dot, always yours"
              : "A little personality goes a long way"}
          </span>
        </div>
        <div>
          <div className="form-grid">
            <label className="form-field">
              <span>Dot name</span>
              <input
                aria-label="Dot name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Nova"
              />
            </label>
            <label className="form-field">
              <span>Default model for this Dot</span>
              <select
                aria-label="Default model for this Dot"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">Use workspace default</option>
                {snapshot.models.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>Personality</span>
            <textarea
              aria-label="Personality"
              rows={4}
              maxLength={4000}
              value={personality}
              onChange={(event) => setPersonality(event.target.value)}
              placeholder="Curious, thoughtful, and direct. Enjoys building small useful things…"
            />
            <small className="form-hint">
              This becomes part of its instructions for future tasks.
            </small>
          </label>
          <fieldset className="appearance-field">
            <legend>Appearance</legend>
            <div className="appearance-options">
              {kinds.map((value) => (
                <label
                  key={value}
                  className={kind === value ? "is-selected" : ""}
                >
                  <input
                    type="radio"
                    name="avatar-kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                  />
                  <PetAvatar
                    dot={{ name: value, avatar: { kind: value, color } }}
                  />
                  <span>{value}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="pet-colors">
            <legend>Accent color</legend>
            <div>
              {colors.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`color-choice ${color === value ? "is-selected" : ""}`}
                  style={{ background: value }}
                  aria-label={`Use ${value} accent color`}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                >
                  {color === value ? <Check size={13} /> : null}
                </button>
              ))}
              <label className="custom-pet-color">
                <span className="sr-only">Custom accent color</span>
                <input
                  type="color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                />
              </label>
            </div>
          </fieldset>
        </div>
      </div>
      <div className="button-row">
        <button
          className="button primary"
          disabled={state.busy || !name.trim()}
        >
          {dot ? "Save Dot" : "Create Dot"}
        </button>
        <button type="button" className="button subtle" onClick={close}>
          Cancel
        </button>
        {dot?.isPrimary ? (
          <span className="primary-form-note">
            <Heart size={11} />
            Your first Dot stays with you.
          </span>
        ) : null}
      </div>
    </form>
  );
}
