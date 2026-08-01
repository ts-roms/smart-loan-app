/**
 * Confirm + prompt dialogs — drop-in replacements for the browser-native
 * `window.confirm()` and `window.prompt()` that look like the rest of the
 * app. Backed by the same Radix Dialog primitive everything else uses.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete X?', message: '...' }))) return;
 *
 *   const prompt = usePrompt();
 *   const reason = await prompt({ title: 'Reason?', placeholder: '...' });
 *   if (reason === null) return;  // user cancelled
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

export type ConfirmTone = "default" | "destructive";

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Label on the green action button. Defaults to "OK". */
  confirmLabel?: string;
  /** Label on the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** "destructive" paints the action red. */
  tone?: ConfirmTone;
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Hide cancel button → user must provide an answer. Default false. */
  required?: boolean;
}

interface ConfirmApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const ConfirmCtx = createContext<ConfirmApi | null>(null);

/** Awaitable confirm() — returns true if user clicked the action button. */
export function useConfirm(): ConfirmApi["confirm"] {
  const ctx = useContext(ConfirmCtx);
  if (!ctx)
    throw new Error("useConfirm must be used inside <ConfirmDialogProvider>");
  return ctx.confirm;
}

/** Awaitable prompt() — returns the entered string, or null if cancelled. */
export function usePrompt(): ConfirmApi["prompt"] {
  const ctx = useContext(ConfirmCtx);
  if (!ctx)
    throw new Error("usePrompt must be used inside <ConfirmDialogProvider>");
  return ctx.prompt;
}

interface ConfirmState {
  kind: "confirm";
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

interface PromptState {
  kind: "prompt";
  options: PromptOptions;
  resolve: (value: string | null) => void;
}

type DialogState = ConfirmState | PromptState | null;

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  const [promptValue, setPromptValue] = useState("");
  // Capture the active resolver in a ref so closing via `onOpenChange`
  // can resolve `false`/`null` even if `state` has been cleared by then.
  const pendingRef = useRef<DialogState>(null);

  const open = useCallback(
    <T,>(next: DialogState, initialValue = ""): Promise<T> => {
      return new Promise<T>((resolve) => {
        // Wrap the resolver so we can clear state on the way out.
        const wrapped: DialogState =
          next?.kind === "confirm"
            ? {
                ...next,
                resolve: (v: boolean) => {
                  pendingRef.current = null;
                  setState(null);
                  next.resolve(v);
                  resolve(v as unknown as T);
                },
              }
            : next?.kind === "prompt"
              ? {
                  ...next,
                  resolve: (v: string | null) => {
                    pendingRef.current = null;
                    setState(null);
                    next.resolve(v);
                    resolve(v as unknown as T);
                  },
                }
              : null;
        pendingRef.current = wrapped;
        setPromptValue(initialValue);
        setState(wrapped);
      });
    },
    [],
  );

  const api: ConfirmApi = {
    confirm: (options) =>
      new Promise<boolean>((resolve) => {
        void open<boolean>({
          kind: "confirm",
          options,
          resolve: (v) => resolve(v),
        }).then(resolve);
      }),
    prompt: (options) =>
      new Promise<string | null>((resolve) => {
        void open<string | null>(
          { kind: "prompt", options, resolve: (v) => resolve(v) },
          options.defaultValue ?? "",
        ).then(resolve);
      }),
  };

  const onOpenChange = (open: boolean) => {
    if (open) return;
    const pending = pendingRef.current;
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(false);
    else pending.resolve(null);
  };

  const onConfirmClick = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(true);
    else pending.resolve(promptValue);
  };

  const onCancelClick = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(false);
    else pending.resolve(null);
  };

  return (
    <ConfirmCtx.Provider value={api}>
      {children}
      {state && (
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{state.options.title}</DialogTitle>
              {state.options.message && (
                <DialogDescription className="text-white/70">
                  {state.options.message}
                </DialogDescription>
              )}
            </DialogHeader>

            {state.kind === "prompt" && (
              <div className="space-y-1.5">
                {state.options.label && <Label>{state.options.label}</Label>}
                <Input
                  autoFocus
                  value={promptValue}
                  placeholder={state.options.placeholder}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onConfirmClick();
                    }
                  }}
                />
              </div>
            )}

            <DialogFooter>
              {!(state.kind === "prompt" && state.options.required) && (
                <Button variant="outline" onClick={onCancelClick}>
                  {state.options.cancelLabel ?? "Cancel"}
                </Button>
              )}
              <Button
                variant={
                  state.kind === "confirm" &&
                  state.options.tone === "destructive"
                    ? "destructive"
                    : "default"
                }
                onClick={onConfirmClick}
              >
                {state.options.confirmLabel ?? "OK"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ConfirmCtx.Provider>
  );
}
