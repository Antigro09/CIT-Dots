import type { NextRequest } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  let localHost = false;
  try {
    localHost = ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(`http://${host}`).hostname,
    );
  } catch {}
  if (!localHost)
    return Response.json(
      { error: "Local workstation access only." },
      { status: 403 },
    );
  if (origin) {
    let same = false;
    try {
      const parsed = new URL(origin);
      same =
        parsed.host === host && ["http:", "https:"].includes(parsed.protocol);
    } catch {}
    if (!same)
      return Response.json(
        { error: "Cross-origin access denied." },
        { status: 403 },
      );
  }
  const url = new URL(
    `/api/local/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`,
    process.env.CIT_CONTROL_URL || "http://127.0.0.1:4318",
  );
  const rawBody = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : await request.text();
  const body = rawBody || undefined;
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      signal: request.signal,
      cache: "no-store",
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("content-type") || "application/json",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        ...(response.headers.get("content-disposition")
          ? {
              "Content-Disposition": response.headers.get(
                "content-disposition",
              )!,
              "X-Content-Type-Options": "nosniff",
            }
          : {}),
      },
    });
  } catch {
    return Response.json(
      {
        error:
          "The background service is offline. Start CIT Dots services and try again.",
      },
      { status: 503 },
    );
  }
}
export {
  proxy as GET,
  proxy as POST,
  proxy as PATCH,
  proxy as DELETE,
  proxy as PUT,
};
