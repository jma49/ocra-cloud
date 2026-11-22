import { createContext, type ReactNode, useContext, useState } from "react";
import { ToastProvider as CossToastProvider, ToastPrimitive } from "@/components/ui/toast";

// A short note after something happened ("Settings saved"), for any page.

const SHOWN_MS = 2600;

type Tone = "success" | "error";
type Show = (message: string, tone?: Tone) => void;

const ToastContext = createContext<Show>(() => {});

/** Each provider keeps its own toasts, so one app (or test) never sees another's. */
export function ToastProvider(props: { children: ReactNode }) {
  const [manager] = useState(ToastPrimitive.createToastManager);
  const [show] = useState<Show>(() => (message: string, tone?: Tone) => {
    manager.add(tone ? { title: message, type: tone } : { title: message });
  });
  return (
    <CossToastProvider toastManager={manager} timeout={SHOWN_MS}>
      <ToastContext.Provider value={show}>{props.children}</ToastContext.Provider>
    </CossToastProvider>
  );
}

/** Shows a message briefly, marked as a success or an error when it is one; outside a ToastProvider, nothing. */
export function useToast(): Show {
  return useContext(ToastContext);
}
