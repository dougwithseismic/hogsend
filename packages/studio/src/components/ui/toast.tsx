import { CheckCircle2, X, XCircle } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error";

type Toast = {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
};

type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
};

type ToastContextValue = {
  toast: (input: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = ++idRef.current;
      const next: Toast = {
        id,
        title: input.title,
        description: input.description,
        variant: input.variant ?? "success",
      };
      setToasts((prev) => [...prev, next]);
      window.setTimeout(() => remove(id), 5000);
    },
    [remove],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "glass-panel pointer-events-auto flex items-start gap-3 p-4 text-white shadow-black/50 shadow-xl",
              t.variant === "error" && "border-accent/40",
            )}
          >
            {t.variant === "success" ? (
              <CheckCircle2
                strokeWidth={1.5}
                className="mt-0.5 h-5 w-5 shrink-0 text-white/90"
              />
            ) : (
              <XCircle
                strokeWidth={1.5}
                className="mt-0.5 h-5 w-5 shrink-0 text-accent"
              />
            )}
            <div className="flex-1 space-y-0.5">
              <p className="text-sm font-medium text-white">{t.title}</p>
              {t.description ? (
                <p className="text-sm text-white/60">{t.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="text-white/50 transition-colors hover:text-white"
              onClick={() => remove(t.id)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
