// Fake extension APIs so popup.html renders a realistic "working" state.
const STATE = { removeVocals: true, removeGuitar: false, removeDrums: false, removeBass: false,
  strength: 0.85, hold: true, lyrics: true, lyricsOffset: 0, lyricsLang: 'th' };
window.chrome = {
  storage: { local: { get: (d, cb) => cb({ ...d, ...STATE }), set() {} } },
  tabs: {
    query: async () => [{ id: 1 }],
    sendMessage: async (_, m) => m.type === 'karaoke:status'
      ? { state: 'active', models: ['mdx'], backend: 'webgpu', realtime: 3.4 }
      : { phase: 'ready', source: 'lrclib', synced: 'vocals' },
  },
};
