/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Graphite monochrome: pure neutral greys, no blue/orange tint.
        bg: {
          DEFAULT: '#0a0a0b',
          panel: '#121214',
          elevated: '#1a1a1d',
          border: '#2a2a2e',
          inset: '#060607',
          subtle: '#1f1f23',
        },
        status: {
          running: '#b8b8bd',
          done: '#34d399',
          error: '#f87171',
        },
        accent: {
          DEFAULT: '#e8e8ea',
          hover: '#ffffff',
          muted: '#8e8e93',
        },
        text: {
          primary: '#f4f4f5',
          secondary: '#a1a1a6',
          muted: '#6e6e73',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
        display: ['Fraunces', 'Georgia', 'serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-slow': 'pulse 2s infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
