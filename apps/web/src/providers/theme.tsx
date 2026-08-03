import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "loan.theme";

export type Theme = "light" | "dark";

interface ThemeApi {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeCtx = createContext<ThemeApi | null>(null);

/**
 * Read the stored preference. Light is the product default, so an
 * absent or corrupt value means light — we deliberately don't consult
 * `prefers-color-scheme`: staff on a dark-mode laptop should still get
 * the console the product ships with until they choose otherwise.
 */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    // Private browsing / storage disabled. Not worth failing over.
    return "light";
  }
}

/** Reflect the theme onto <html>, which is what globals.css keys off. */
function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(storedTheme);

  // The inline script in index.html already applied the stored theme
  // before first paint; this keeps the attribute in step with state on
  // every later change.
  useEffect(() => {
    apply(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference just won't persist; the session still works.
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((cur) => {
      const next = cur === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* see above */
      }
      return next;
    });
  }, []);

  // Follow the choice across tabs, the same way auth follows sign-out.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY)
        setThemeState(e.newValue === "dark" ? "dark" : "light");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<ThemeApi>(
    () => ({ theme, setTheme, toggle }),
    [theme, setTheme, toggle],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
