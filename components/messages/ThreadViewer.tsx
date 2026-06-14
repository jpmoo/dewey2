"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { ThreadPane, AttachmentLightbox } from "@/components/messages/MessageCenter";

type AttachmentMeta = { id: number; filename: string; mime_type: string; size_bytes: number };

/** Modal that shows a single conversation (used to open threads from the log). */
export function ThreadViewer({
  threadId,
  scrollToTime,
  onClose,
}: {
  threadId: number;
  scrollToTime?: string;
  onClose: () => void;
}) {
  const { data: session } = useSession();
  const meId = session?.user?.id ? Number(session.user.id) : null;
  const [preview, setPreview] = useState<AttachmentMeta | null>(null);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-dewey-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-dewey-border px-4 py-2">
          <h3 className="text-sm font-semibold">Conversation</h3>
          <button
            type="button"
            className="text-sm text-dewey-mute hover:text-dewey-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <ThreadPane
            threadId={threadId}
            meId={meId}
            archived={false}
            onPreview={setPreview}
            onPosted={() => {}}
            onArchived={onClose}
            scrollToTime={scrollToTime}
          />
        </div>
      </div>
      {preview && <AttachmentLightbox attachment={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
