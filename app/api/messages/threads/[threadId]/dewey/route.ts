import { NextRequest, NextResponse } from "next/server";
import { messageScope, requireUser } from "@/lib/guard";
import { canAccessThread } from "@/lib/messages";
import { clearDeweyPane, finishDeweyPane, getDeweyPane, prepareDeweyPane } from "@/lib/dewey-pane";
import { chatStream } from "@/lib/ai";
import { allowAiRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Load the signed-in user's private Dewey side-panel conversation for a thread. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const id = parseInt((await params).threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const me = Number(session.user.id);
  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, me, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(await getDeweyPane(id, me));
}

/** Ask Dewey in the private pane; streams the reply (SSE). Body: { message }. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const id = parseInt((await params).threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const me = Number(session.user.id);
  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, me, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!allowAiRequest(me)) {
    return NextResponse.json({ error: "You're sending requests too quickly — please wait a moment." }, { status: 429 });
  }
  const body = await request.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Message required" }, { status: 400 });

  const encoder = new TextEncoder();
  const send = (c: ReadableStreamDefaultController, obj: unknown) =>
    c.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(": ready\n\n"));
        const prep = await prepareDeweyPane({ threadId: id, userId: me, message });
        send(controller, { type: "conversation", conversationId: prep.conversationId });
        if (prep.blocked) {
          send(controller, { type: "text", text: prep.blocked });
          send(controller, { type: "done" });
          controller.close();
          return;
        }
        let full = "";
        for await (const delta of chatStream({ system: prep.system, messages: prep.messages, maxTokens: 2048 })) {
          full += delta;
          send(controller, { type: "text", text: delta });
        }
        if (!full.trim()) full = "Sorry — I couldn't reach the model just now. Please try again.";
        await finishDeweyPane(prep.conversationId, full);
        if (prep.sources.length) send(controller, { type: "sources", sources: prep.sources });
        send(controller, { type: "done" });
      } catch (e) {
        send(controller, { type: "error", error: e instanceof Error ? e.message : "Assistant error" });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}

/** Clear the user's private Dewey conversation (snapshots stay; live shares go empty). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  const { session } = guard;
  const id = parseInt((await params).threadId, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const me = Number(session.user.id);
  const { isAdmin, overseeDistrictId } = messageScope(session);
  if (!(await canAccessThread(id, me, isAdmin, overseeDistrictId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await clearDeweyPane(id, me);
  return NextResponse.json({ ok: true });
}
