"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
interface T { id: number; text: string; icon?: string }
const Ctx = createContext<(text: string, icon?: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<T[]>([]);
  const push = useCallback((text: string, icon?: string) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, icon }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">{list.map((t) => <div key={t.id} className="toast">{t.icon && <Icon name={t.icon} size={14} />}{t.text}</div>)}</div>
    </Ctx.Provider>
  );
}
export const useToast = () => useContext(Ctx);
