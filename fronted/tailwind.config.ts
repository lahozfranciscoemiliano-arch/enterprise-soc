import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      // Terracota tomado del logo de Grupo Bistro: color de marca para
      // acciones primarias / foco, separado de los colores de datos
      // (azul/verde/ambar/rojo) para que el chrome de la app se lea como
      // propio en vez de un dashboard generico.
      colors: {
        brand: {
          50: '#FBF3EC',
          100: '#F6E3D2',
          200: '#EBC29D',
          300: '#DFA067',
          400: '#D07F3F',
          500: '#C2632D',
          600: '#A84F22',
          700: '#873F1C',
          800: '#6C3317',
          900: '#552812',
        },
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        'card-hover': '0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 4px -2px rgb(15 23 42 / 0.05)',
      },
    },
  },
  plugins: [],
};

export default config;
