import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// A short note after something worked ("Settings saved"), for any page.

const SHOWN_MS = 2600;
const ToastContext = createContext<(message: string) => void>(() => {});

export function ToastProvider(props: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useCallback((m: string) => {
    clearTimeout(timer.current);
    setMessage(m);
    timer.current = setTimeout(() => setMessage(""), SHOWN_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={toast}>
      {props.children}
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

/** Shows a message briefly; outside a ToastProvider, nothing. */
export function useToast(): (message: string) => void {
  return useContext(ToastContext);
}
