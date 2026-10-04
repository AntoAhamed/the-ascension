/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Deep space base — the app is dark-only by design.
        void: {
          950: '#05060f',
          900: '#080a16',
          850: '#0b0e1e',
          800: '#10132a',
          700: '#171b38',
          600: '#1f2447',
        },
        neon: {
          cyan: '#22d3ee',
          violet: '#a78bfa',
          amber: '#fbbf24',
          emerald: '#34d399',
          rose: '#fb7185',
          gold: '#ffd166',
        },
      },
      fontFamily: {
        display: ['"Orbitron"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 24px -4px currentColor',
        'glow-lg': '0 0 60px -10px currentColor',
        card: '0 8px 32px -8px rgba(0,0,0,0.6)',
      },
      backgroundImage: {
        'grid-fade':
          'linear-gradient(to bottom, rgba(34,211,238,0.06) 1px, transparent 1px), linear-gradient(to right, rgba(34,211,238,0.06) 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '44px 44px',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.95)', opacity: '0.7' },
          '70%': { transform: 'scale(1.3)', opacity: '0' },
          '100%': { transform: 'scale(1.3)', opacity: '0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'count-pop': {
          '0%': { transform: 'scale(1)' },
          '40%': { transform: 'scale(1.14)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2.5s linear infinite',
        'pulse-ring': 'pulse-ring 2s cubic-bezier(0.4,0,0.6,1) infinite',
        float: 'float 3s ease-in-out infinite',
        'count-pop': 'count-pop 400ms cubic-bezier(0.34,1.56,0.64,1)',
      },
    },
  },
  plugins: [],
};