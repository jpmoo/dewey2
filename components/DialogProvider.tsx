"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * In-app replacement for window.alert / confirm / prompt. Provides promise-based
 * dialogs rendered as themed modals so the app never falls back to the browser's
 * system dialogs. Use via useDialog().
 */

type AlertOpts = { title?: string; okText?: string };
type ConfirmOpts = {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};
type PromptOpts = {
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  confirmText?: string;
  cancelText?: string;
};

interface DialogApi {
  alert: (message: ReactNode, opts?: AlertOpts) => Promise<void>;
  confirm: (message: ReactNode, opts?: ConfirmOpts) => Promise<boolean>;
  prompt: (message: ReactNode, opts?: PromptOpts) => Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

type State =
  | { kind: "alert"; message: ReactNode; opts: AlertOpts; resolve: (v: void) => void }
  | { kind: "confirm"; message: ReactNode; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | {
      kind: "prompt";
      message: ReactNode;
      opts: PromptOpts;
      resolve: (v: string | null) => void;
    };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);
  const [inputValue, setInputValue] = useState("");

  const alert = useCallback<DialogApi["alert"]>((message, opts = {}) => {
    return new Promise<void>((resolve) => setState({ kind: "alert", message, opts, resolve }));
  }, []);
  const confirm = useCallback<DialogApi["confirm"]>((message, opts = {}) => {
    return new Promise<boolean>((resolve) =>
      setState({ kind: "confirm", message, opts, resolve })
    );
  }, []);
  const prompt = useCallback<DialogApi["prompt"]>((message, opts = {}) => {
    setInputValue(opts.defaultValue ?? "");
    return new Promise<string | null>((resolve) =>
      setState({ kind: "prompt", message, opts, resolve })
    );
  }, []);

  const close = useCallback(
    (result: void | boolean | string | null) => {
      setState((cur) => {
        if (cur) (cur.resolve as (v: unknown) => void)(result);
        return null;
      });
    },
    []
  );

  // Cancel = the "negative" result for each kind (void / false / null).
  const cancel = useCallback(() => {
    setState((cur) => {
      if (!cur) return null;
      (cur.resolve as (v: unknown) => void)(
        cur.kind === "confirm" ? false : cur.kind === "prompt" ? null : undefined
      );
      return null;
    });
  }, []);

  const api = useMemo<DialogApi>(() => ({ alert, confirm, prompt }), [alert, confirm, prompt]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {state && (
        <DialogModal
          state={state}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onCancel={cancel}
          onAccept={() => {
            if (state.kind === "prompt") close(inputValue);
            else if (state.kind === "confirm") close(true);
            else close(undefined);
          }}
        />
      )}
    </DialogContext.Provider>
  );
}

function DialogModal({
  state,
  inputValue,
  setInputValue,
  onCancel,
  onAccept,
}: {
  state: State;
  inputValue: string;
  setInputValue: (v: string) => void;
  onCancel: () => void;
  onAccept: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

  useEffect(() => {
    if (state.kind === "prompt") inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.kind, onCancel]);

  const showCancel = state.kind !== "alert";
  const confirmText =
    state.kind === "alert"
      ? state.opts.okText ?? "OK"
      : state.kind === "confirm"
      ? state.opts.confirmText ?? "Confirm"
      : state.opts.confirmText ?? "OK";
  const cancelText =
    state.kind === "confirm"
      ? state.opts.cancelText ?? "Cancel"
      : state.kind === "prompt"
      ? state.opts.cancelText ?? "Cancel"
      : "Cancel";
  const danger = state.kind === "confirm" && state.opts.danger;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg bg-dewey-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {state.opts.title && (
          <h3 className="mb-2 text-lg font-semibold text-dewey-ink">{state.opts.title}</h3>
        )}
        {state.message != null && state.message !== "" && (
          <div className="text-sm text-dewey-ink [overflow-wrap:anywhere]">{state.message}</div>
        )}

        {state.kind === "prompt" &&
          (state.opts.multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              className="dewey-input mt-3 min-h-[80px]"
              value={inputValue}
              placeholder={state.opts.placeholder}
              onChange={(e) => setInputValue(e.target.value)}
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              className="dewey-input mt-3"
              value={inputValue}
              placeholder={state.opts.placeholder}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onAccept();
              }}
            />
          ))}

        <div className="mt-5 flex justify-end gap-2">
          {showCancel && (
            <button type="button" className="dewey-btn-secondary px-5 py-2.5" onClick={onCancel}>
              <span aria-hidden>✕</span> {cancelText}
            </button>
          )}
          <button
            type="button"
            className={
              danger
                ? "inline-flex items-center justify-center gap-1.5 rounded-full bg-red-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-700"
                : "dewey-btn-primary w-auto"
            }
            onClick={onAccept}
          >
            <span aria-hidden>{danger ? "⚠️" : "✓"}</span> {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within <DialogProvider>");
  return ctx;
}
