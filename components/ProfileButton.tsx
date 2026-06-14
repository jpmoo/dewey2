"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { Avatar } from "@/components/Avatar";
import { useDialog } from "@/components/DialogProvider";

type Profile = {
  username: string;
  full_name: string;
  nickname: string | null;
  email: string | null;
  role: string | null;
  about: string | null;
};

/**
 * "Profile" button + modal in the top bar. Lets a user edit their name,
 * nickname, title, description, and profile photo (with crop). Username and org
 * assignment are admin-managed and shown read-only.
 */
export function ProfileButton({ className }: { className?: string }) {
  const { data: session } = useSession();
  const meId = session?.user?.id ? Number(session.user.id) : null;
  const name = session?.user?.nickname || session?.user?.name || null;
  const [open, setOpen] = useState(false);
  // Bumped after an avatar change so the cached image refreshes everywhere here.
  const [avatarVersion, setAvatarVersion] = useState(0);

  return (
    <>
      <button
        type="button"
        className={`inline-flex items-center gap-1.5 rounded-full border border-dewey-border bg-dewey-surface py-0.5 pl-0.5 pr-3 text-sm text-dewey-mute transition-colors hover:bg-dewey-surface-2 hover:text-dewey-ink ${className ?? ""}`}
        onClick={() => setOpen(true)}
        title="Profile & settings"
      >
        <Avatar userId={meId} name={name} size={24} version={avatarVersion} />
        Profile
      </button>
      {open && (
        <ProfileModal
          meId={meId}
          headerName={name}
          avatarVersion={avatarVersion}
          onAvatarChanged={() => setAvatarVersion((v) => v + 1)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ProfileModal({
  meId,
  headerName,
  avatarVersion,
  onAvatarChanged,
  onClose,
}: {
  meId: number | null;
  headerName: string | null;
  avatarVersion: number;
  onAvatarChanged: () => void;
  onClose: () => void;
}) {
  const { update } = useSession();
  const router = useRouter();
  const dialog = useDialog();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [fullName, setFullName] = useState("");
  const [nickname, setNickname] = useState("");
  const [title, setTitle] = useState("");
  const [about, setAbout] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [cropFile, setCropFile] = useState<File | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ profile: Profile }>("/api/me/profile")
      .then((d) => {
        if (cancelled) return;
        setProfile(d.profile);
        setFullName(d.profile.full_name);
        setNickname(d.profile.nickname ?? "");
        setTitle(d.profile.role ?? "");
        setAbout(d.profile.about ?? "");
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load profile");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!fullName.trim()) {
      setErr("Name can't be empty.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await apiFetch("/api/me/profile", {
        method: "PATCH",
        body: { full_name: fullName, nickname, role: title, about },
      });
      await update({ action: "refresh" });
      router.refresh();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
      setSaving(false);
    }
  };

  const removePhoto = async () => {
    if (!(await dialog.confirm("Remove your profile photo?", { title: "Remove photo" }))) return;
    setAvatarBusy(true);
    try {
      await apiFetch("/api/me/avatar", { method: "DELETE" });
      onAvatarChanged();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Failed to remove photo");
    } finally {
      setAvatarBusy(false);
    }
  };

  const onCropped = async (blob: Blob) => {
    setCropFile(null);
    setAvatarBusy(true);
    try {
      const form = new FormData();
      form.append("file", blob, "avatar.jpg");
      const res = await fetch(pathWithBase("/api/me/avatar"), { method: "POST", body: form });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `HTTP ${res.status}`);
      }
      onAvatarChanged();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Failed to upload photo");
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-lg font-semibold">Profile</h3>

        {loading ? (
          <p className="text-sm text-dewey-mute">Loading…</p>
        ) : (
          <div className="space-y-4">
            {err && <p className="text-sm text-red-600">{err}</p>}

            {/* Avatar */}
            <div className="flex items-center gap-4">
              <Avatar userId={meId} name={headerName} size={72} version={avatarVersion} />
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  className="text-sm text-dewey-accent hover:underline disabled:opacity-50"
                  onClick={() => fileInput.current?.click()}
                  disabled={avatarBusy}
                >
                  {avatarBusy ? "Working…" : "Change photo"}
                </button>
                <button
                  type="button"
                  className="text-left text-sm text-red-700 hover:underline disabled:opacity-50"
                  onClick={removePhoto}
                  disabled={avatarBusy}
                >
                  Remove photo
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setCropFile(f);
                    if (fileInput.current) fileInput.current.value = "";
                  }}
                />
              </div>
            </div>

            <div>
              <label className="dewey-label">Name</label>
              <input
                className="dewey-input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div>
              <label className="dewey-label">Nickname</label>
              <input
                className="dewey-input"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="What you'd like to be called"
              />
            </div>
            <div>
              <label className="dewey-label">Title</label>
              <input
                className="dewey-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Instructional Literacy Coach, 3rd Grade Teacher"
              />
            </div>
            <div>
              <label className="dewey-label">Description</label>
              <textarea
                className="dewey-input min-h-[90px]"
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                placeholder="A short description about you and your coaching context."
              />
            </div>

            <div className="rounded-md border border-dewey-border bg-dewey-surface-2 p-3 text-xs text-dewey-mute">
              <div>
                <span className="font-medium text-dewey-ink">Username:</span> @{profile?.username}
              </div>
              <p className="mt-1">Username and building assignment are managed by your administrator.</p>
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="dewey-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dewey-btn-primary w-auto"
            onClick={save}
            disabled={saving || loading}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {cropFile && (
        <CropModal file={cropFile} onCancel={() => setCropFile(null)} onCropped={onCropped} />
      )}
    </div>
  );
}

// Display square (px) and exported avatar resolution (px).
const VIEW = 280;
const OUT = 512;

/** Square crop tool: zoom + drag to position, then export a centered square. */
function CropModal({
  file,
  onCancel,
  onCropped,
}: {
  file: File;
  onCancel: () => void;
  onCropped: (blob: Blob) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Load the file into an Image.
  useEffect(() => {
    const objUrl = URL.createObjectURL(file);
    setUrl(objUrl);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = objUrl;
    return () => URL.revokeObjectURL(objUrl);
  }, [file]);

  // "Cover" scale so the image always fills the square, times the zoom.
  const coverScale = img ? Math.max(VIEW / img.naturalWidth, VIEW / img.naturalHeight) : 1;
  const effScale = coverScale * zoom;
  const dispW = img ? img.naturalWidth * effScale : VIEW;
  const dispH = img ? img.naturalHeight * effScale : VIEW;

  const clamp = useCallback(
    (p: { x: number; y: number }) => ({
      x: Math.min(0, Math.max(VIEW - dispW, p.x)),
      y: Math.min(0, Math.max(VIEW - dispH, p.y)),
    }),
    [dispW, dispH]
  );

  // Recenter when zoom or the image changes so the framing stays sensible.
  useEffect(() => {
    setPos(clamp({ x: (VIEW - dispW) / 2, y: (VIEW - dispH) / 2 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, img]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    setPos(clamp({ x: drag.current.ox + dx, y: drag.current.oy + dy }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const save = () => {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // The square shows, in image pixels, a region starting at (-pos/effScale)
    // and spanning VIEW/effScale on each side.
    const sx = -pos.x / effScale;
    const sy = -pos.y / effScale;
    const sSize = VIEW / effScale;
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUT, OUT);
    canvas.toBlob(
      (blob) => {
        if (blob) onCropped(blob);
      },
      "image/jpeg",
      0.9
    );
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-dewey-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-base font-semibold">Position your photo</h3>
        <div
          className="relative mx-auto touch-none overflow-hidden rounded-full bg-dewey-surface-2"
          style={{ width: VIEW, height: VIEW, cursor: img ? "grab" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt="crop"
              draggable={false}
              style={{
                position: "absolute",
                left: pos.x,
                top: pos.y,
                width: dispW,
                height: dispH,
                maxWidth: "none",
              }}
            />
          )}
          {/* Ring overlay hint */}
          <div className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-white/60" />
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs text-dewey-mute">Zoom</label>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="dewey-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="dewey-btn-primary w-auto"
            onClick={save}
            disabled={!img}
          >
            Save photo
          </button>
        </div>
      </div>
    </div>
  );
}
