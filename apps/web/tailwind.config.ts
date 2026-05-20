import type { Config } from 'tailwindcss';

export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../libs/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
      },
      keyframes: {
        // Dialog overlay + content. Content fades and grows from 96% so it
        // feels like it lifts up, not just appears.
        'overlay-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'overlay-out': {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        'dialog-in': {
          '0%': { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'dialog-out': {
          '0%': { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          '100%': { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
        },
        // Toasts slide in from the right edge and slide back out the same way.
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateX(110%)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'toast-out': {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(110%)' },
        },
        // Active swipe gesture — pass the swipe distance through Radix's
        // CSS variable so the toast tracks the pointer.
        'toast-swipe-out': {
          '0%': { transform: 'translateX(var(--radix-toast-swipe-end-x))' },
          '100%': { opacity: '0', transform: 'translateX(110%)' },
        },
        // Right-side drawer slide. Slightly stronger ease than the toast
        // since the panel is bigger; matches the visual feel of macOS
        // sidebars and shadcn's `Sheet`.
        'drawer-in-right': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'drawer-out-right': {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'overlay-in': 'overlay-in 150ms ease-out',
        'overlay-out': 'overlay-out 120ms ease-in',
        'dialog-in': 'dialog-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'dialog-out': 'dialog-out 140ms ease-in',
        'toast-in': 'toast-in 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'toast-out': 'toast-out 160ms ease-in',
        'toast-swipe-out': 'toast-swipe-out 120ms ease-out',
        'drawer-in-right': 'drawer-in-right 240ms cubic-bezier(0.16, 1, 0.3, 1)',
        'drawer-out-right': 'drawer-out-right 200ms cubic-bezier(0.4, 0, 1, 1)',
      },
    },
  },
  plugins: [],
} satisfies Config;
