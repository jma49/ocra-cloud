import { createContext, type ReactNode, useContext, useState } from "react";
import { ToastProvider as CossToastProvider, ToastPrimitive } from "@/components/ui/toast";

// A short note after something happened ("Settings saved"), for any page.

const SHOWN_MS = 2600;
// Long enough to read the note and reach its button.
const WITH_ACTION_MS = 6000;

type Tone = "success" | "error";
/** A button on the toast, such as Undo; pressing it closes the toast. */
export type ToastAction = { label: string; run: () => void };
type Show = (message: string, tone?: Tone, action?: ToastAction) => void;

const ToastContext = createContext<Show>(() => {});

/** Each provider keeps its own toasts, so one app (or test) never sees another's. */
export function ToastProvider(props: { children: ReactNode }) {
  const [manager] = useState(ToastPrimitive.createToastManager);
  const [show] = useState<Show>(() => (message: string, tone?: Tone, action?: ToastAction) => {
    const id: string = manager.add({
      title: message,
      ...(tone ? { type: tone } : {}),
      ...(action
        ? {
            timeout: WITH_ACTION_MS,
            actionProps: {
              children: action.label,
              onClick: () => {
                manager.close(id);
                action.run();
              },
            },
          }
        : {}),
    });
  });
  return (
    <CossToastProvider toastManager={manager} timeout={SHOWN_MS}>
      <ToastContext.Provider value={show}>{props.children}</ToastContext.Provider>
    </CossToastProvider>
  );
}

/** Shows a message briefly, marked as a success or an error when it is one, with an optional button; outside a ToastProvider, nothing. */
export function useToast(): Show {
  return useContext(ToastContext);
}
