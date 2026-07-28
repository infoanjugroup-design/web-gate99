/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#12181F',
        graphite: '#1D2530',
        paper: '#F5F3EC',
        blueline: '#3B7A9E',
        signal: '#E8842C',
        alert: '#C4453A',
        mint: '#3E9A6D',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        body: ['"Inter"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
      backgroundImage: {
        blueprint:
          'linear-gradient(rgba(59,122,158,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(59,122,158,0.14) 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '28px 28px',
      },
    },
  },
  plugins: [],
};
