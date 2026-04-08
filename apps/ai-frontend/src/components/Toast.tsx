import { useState, useCallback, useRef, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { ToastNotification } from '@carbon/react';

type ToastType = 'success' | 'info' | 'warning' | 'error';

interface Toast {
    id: number;
    type: ToastType;
    message: string;
}

interface ToastCtx {
    showToast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastCtx>({ showToast: () => {} });
export const useToast = () => useContext(ToastContext);

const KIND_MAP: Record<ToastType, 'success' | 'info' | 'warning' | 'error'> = {
    success: 'success', info: 'info', warning: 'warning', error: 'error',
};

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const counter = useRef(0);

    const showToast = useCallback((type: ToastType, message: string) => {
        const id = ++counter.current;
        setToasts(prev => [...prev, { id, type, message }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
    }, []);

    const dismiss = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <div className="toast-container">
                {toasts.map(t => (
                    <ToastNotification
                        key={t.id}
                        kind={KIND_MAP[t.type]}
                        title={t.type.charAt(0).toUpperCase() + t.type.slice(1)}
                        subtitle={t.message}
                        lowContrast
                        onClose={() => { dismiss(t.id); return false; }}
                        timeout={4500}
                    />
                ))}
            </div>
        </ToastContext.Provider>
    );
}
