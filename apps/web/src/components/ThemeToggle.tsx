import { Moon, Sun } from "lucide-react";

import { useTheme } from "../providers/theme";

/**
 * Light/dark switch for the app header.
 *
 * Shows the theme you'd get by clicking, not the one you're in — a sun
 * while dark, a moon while light. That's the convention every OS uses
 * and it's what the tooltip has to say anyway, so the icon may as well
 * agree with it.
 */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      className="grid h-9 w-9 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </button>
  );
}
