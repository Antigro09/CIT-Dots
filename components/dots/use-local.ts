"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Message,
  Session,
  Snapshot,
  Task,
  ToolOperation,
} from "@/src/shared/types";
import type { WorkspaceDiff } from "@/src/server/workspaces";
export type { Snapshot } from "@/src/shared/types";

export interface SessionDetail {
  session: Session;
  messages: Message[];
  tasks: Task[];
}
export interface TaskDetail {
  task: Task;
  children: Task[];
  operations: ToolOperation[];
  diff?: WorkspaceDiff;
}

export async function localApi<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/local${path}`, {
    method,
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("The local service returned an unreadable response.");
  }
  if (!response.ok) {
    const detail = data as { error?: string };
    throw new Error(detail.error ?? `Request failed (${response.status}).`);
  }
  return data as T;
}

export function useLocal() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "offline"
  >("loading");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const loading = useRef<Promise<void> | null>(null);
  const cursor = useRef(0);

  const refresh = useCallback(async () => {
    if (loading.current) return loading.current;
    const work = (async () => {
      try {
        const data = await localApi<Snapshot>("/snapshot");
        if (!alive.current) return;
        cursor.current = data.eventsCursor;
        setSnapshot(data);
        setConnection("connected");
      } catch (cause) {
        if (!alive.current) return;
        setConnection("offline");
        setError(
          cause instanceof Error
            ? cause.message
            : "Cannot reach the local service.",
        );
      }
    })();
    loading.current = work;
    await work;
    loading.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let source: EventSource | null = null;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    void refresh().then(() => {
      if (disposed) return;
      source = new EventSource(`/api/local/events?after=${cursor.current}`);
      source.onopen = () => setLive(true);
      source.onerror = () => setLive(false);
      source.onmessage = () => {
        if (scheduled) return;
        scheduled = setTimeout(() => {
          scheduled = undefined;
          void refresh();
        }, 150);
      };
    });
    const poll = setInterval(() => void refresh(), 4000);
    return () => {
      disposed = true;
      alive.current = false;
      source?.close();
      clearInterval(poll);
      clearTimeout(scheduled);
    };
  }, [refresh]);

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        await refresh();
        return result;
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The action could not be completed.",
        );
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return {
    snapshot,
    connection,
    live,
    error,
    clearError: () => setError(null),
    busy,
    run,
    refresh,
  };
}

export function useDetail<T>(path: string | null, revision: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const currentPath = useRef<string | null>(null);
  useEffect(() => {
    if (!path) {
      setData(null);
      setError(null);
      currentPath.current = null;
      return;
    }
    if (currentPath.current !== path) {
      setData(null);
      currentPath.current = path;
    }
    const controller = new AbortController();
    setLoading(true);
    void localApi<T>(path, "GET", undefined, controller.signal)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Cannot load this item.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, loading };
}

export type LocalState = ReturnType<typeof useLocal>;
