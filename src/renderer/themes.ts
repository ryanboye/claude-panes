/**
 * Theme registry and engine for Claude Panes.
 * Defines theme palettes and applies them via CSS custom properties.
 */

export interface ThemeDefinition {
  id: string;
  name: string;
  preview: { bg: string; accent: string; surface: string; text: string };
  cssVars: Record<string, string>;
  terminalTheme: Record<string, string>;
}

const THEMES: ThemeDefinition[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    preview: { bg: '#1a1a2e', accent: '#60a5fa', surface: '#16213e', text: '#e0e0e0' },
    cssVars: {
      '--bg-primary': '#1a1a2e',
      '--bg-secondary': '#16213e',
      '--bg-tertiary': '#0f3460',
      '--bg-sidebar': '#12122a',
      '--bg-panel': '#1e1e3a',
      '--text-primary': '#e0e0e0',
      '--text-secondary': '#8888aa',
      '--text-muted': '#555577',
      '--border-color': '#2a2a4a',
      '--accent': '#60a5fa',
      '--danger': '#ff6b6b',
      '--warning': '#fbbf24',
      '--success': '#4ade80',
    },
    terminalTheme: {
      background: '#1a1a2e',
      foreground: '#e0e0e0',
      cursor: '#e0e0e0',
      cursorAccent: '#1a1a2e',
      selectionBackground: 'rgba(255, 255, 255, 0.15)',
      black: '#1a1a2e',
      red: '#ff6b6b',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#2dd4bf',
      white: '#e0e0e0',
      brightBlack: '#4a4a6a',
      brightRed: '#ff8a8a',
      brightGreen: '#6ee7a0',
      brightYellow: '#fcd34d',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#5eead4',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'evangelion',
    name: 'NERV Terminal',
    preview: { bg: '#0a0012', accent: '#00ff41', surface: '#1a0a2e', text: '#d4ffe0' },
    cssVars: {
      '--bg-primary': '#0a0012',
      '--bg-secondary': '#1a0a2e',
      '--bg-tertiary': '#241440',
      '--bg-sidebar': '#08000e',
      '--bg-panel': '#120822',
      '--text-primary': '#d4ffe0',
      '--text-secondary': '#a976c3',
      '--text-muted': '#6b3f8a',
      '--border-color': '#2a1548',
      '--accent': '#00ff41',
      '--danger': '#ff3300',
      '--warning': '#ff6600',
      '--success': '#00ff41',
    },
    terminalTheme: {
      background: '#0a0012',
      foreground: '#d4ffe0',
      cursor: '#00ff41',
      cursorAccent: '#0a0012',
      selectionBackground: 'rgba(0, 255, 65, 0.25)',
      black: '#0a0012',
      red: '#ff3300',
      green: '#00ff41',
      yellow: '#ff6600',
      blue: '#9b30ff',
      magenta: '#c084fc',
      cyan: '#2dd4bf',
      white: '#d4ffe0',
      brightBlack: '#2a1548',
      brightRed: '#ff5533',
      brightGreen: '#33ff66',
      brightYellow: '#ff8833',
      brightBlue: '#bf6fff',
      brightMagenta: '#d8b4fe',
      brightCyan: '#5eead4',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'cyberpunk',
    name: 'Night City',
    preview: { bg: '#0a0014', accent: '#00f0ff', surface: '#1a0028', text: '#f0f0f0' },
    cssVars: {
      '--bg-primary': '#0a0014',
      '--bg-secondary': '#1a0028',
      '--bg-tertiary': '#220038',
      '--bg-sidebar': '#08000e',
      '--bg-panel': '#12001e',
      '--text-primary': '#f0f0f0',
      '--text-secondary': '#b0b0d0',
      '--text-muted': '#706090',
      '--border-color': '#2a0040',
      '--accent': '#00f0ff',
      '--danger': '#ff0055',
      '--warning': '#ff8800',
      '--success': '#00ff88',
    },
    terminalTheme: {
      background: '#0a0014',
      foreground: '#f0f0f0',
      cursor: '#00f0ff',
      cursorAccent: '#0a0014',
      selectionBackground: 'rgba(0, 240, 255, 0.2)',
      black: '#0a0014',
      red: '#ff0055',
      green: '#00ff88',
      yellow: '#ff8800',
      blue: '#00f0ff',
      magenta: '#ff00ff',
      cyan: '#00f0ff',
      white: '#f0f0f0',
      brightBlack: '#2a0040',
      brightRed: '#ff3377',
      brightGreen: '#33ffaa',
      brightYellow: '#ffaa33',
      brightBlue: '#33f0ff',
      brightMagenta: '#ff55ff',
      brightCyan: '#55f5ff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized',
    name: 'Solarized Dark',
    preview: { bg: '#002b36', accent: '#268bd2', surface: '#073642', text: '#839496' },
    cssVars: {
      '--bg-primary': '#002b36',
      '--bg-secondary': '#073642',
      '--bg-tertiary': '#0a4050',
      '--bg-sidebar': '#00212b',
      '--bg-panel': '#073642',
      '--text-primary': '#839496',
      '--text-secondary': '#657b83',
      '--text-muted': '#586e75',
      '--border-color': '#0a4050',
      '--accent': '#268bd2',
      '--danger': '#dc322f',
      '--warning': '#cb4b16',
      '--success': '#859900',
    },
    terminalTheme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#839496',
      cursorAccent: '#002b36',
      selectionBackground: 'rgba(131, 148, 150, 0.2)',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#859900',
      brightYellow: '#b58900',
      brightBlue: '#268bd2',
      brightMagenta: '#6c71c4',
      brightCyan: '#2aa198',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai Pro',
    preview: { bg: '#2d2a2e', accent: '#a9dc76', surface: '#383539', text: '#fcfcfa' },
    cssVars: {
      '--bg-primary': '#2d2a2e',
      '--bg-secondary': '#383539',
      '--bg-tertiary': '#403d41',
      '--bg-sidebar': '#272428',
      '--bg-panel': '#353236',
      '--text-primary': '#fcfcfa',
      '--text-secondary': '#c1c0c0',
      '--text-muted': '#939293',
      '--border-color': '#49464e',
      '--accent': '#a9dc76',
      '--danger': '#ff6188',
      '--warning': '#fc9867',
      '--success': '#a9dc76',
    },
    terminalTheme: {
      background: '#2d2a2e',
      foreground: '#fcfcfa',
      cursor: '#fcfcfa',
      cursorAccent: '#2d2a2e',
      selectionBackground: 'rgba(252, 252, 250, 0.15)',
      black: '#2d2a2e',
      red: '#ff6188',
      green: '#a9dc76',
      yellow: '#ffd866',
      blue: '#78dce8',
      magenta: '#ab9df2',
      cyan: '#78dce8',
      white: '#fcfcfa',
      brightBlack: '#727072',
      brightRed: '#ff6188',
      brightGreen: '#a9dc76',
      brightYellow: '#ffd866',
      brightBlue: '#78dce8',
      brightMagenta: '#ab9df2',
      brightCyan: '#78dce8',
      brightWhite: '#ffffff',
    },
  },
];

let currentThemeId = 'midnight';

export function getThemes(): ThemeDefinition[] {
  return THEMES;
}

export function getTheme(id: string): ThemeDefinition {
  return THEMES.find(t => t.id === id) || THEMES[0];
}

export function applyTheme(id: string): void {
  const theme = getTheme(id);
  for (const [prop, value] of Object.entries(theme.cssVars)) {
    document.documentElement.style.setProperty(prop, value);
  }
  currentThemeId = theme.id;

  // Manage evangelion scanline effect
  const existing = document.getElementById('evangelion-scanlines');
  if (theme.id === 'evangelion') {
    if (!existing) {
      const overlay = document.createElement('div');
      overlay.id = 'evangelion-scanlines';
      document.body.appendChild(overlay);
    }
  } else if (existing) {
    existing.remove();
  }
}

export function getTerminalTheme(id: string): Record<string, string> {
  return getTheme(id).terminalTheme;
}

export function getCurrentThemeId(): string {
  return currentThemeId;
}
