// Cutscene test bench (dev only): /video.html?video=PKG:ID
//   &t=SECONDS     start position          &loop=1   loop
//   &bg=1          menu-background mode    &audio=0  no soundtrack
//   &autoplay=0    show the list only
// Plays the converted media (npm run bake). window.__cut exposes
// { lib, player, play(key, opts), stats(), audioContext } for automation.
import { DevServerFS, LocalFolderFS, type GameFS } from './gamefs';
import { CutsceneLibrary, CutscenePlayer, type CutscenePlayOptions } from './cutscene';
import { onConvertedMediaMissing } from './media';

const q = new URLSearchParams(location.search);
const ui = document.createElement('div');
Object.assign(ui.style, {
  position: 'fixed', top: '0', left: '0', bottom: '0', width: '300px', overflow: 'auto', zIndex: '10',
  background: 'rgba(0,0,0,.75)', padding: '8px',
} satisfies Partial<CSSStyleDeclaration>);
const hud = document.createElement('pre');
Object.assign(hud.style, {
  position: 'fixed', right: '8px', top: '8px', margin: '0', zIndex: '2000', background: 'rgba(0,0,0,.6)',
  padding: '6px 8px', pointerEvents: 'none', display: q.get('hud') === '0' ? 'none' : '',
} satisfies Partial<CSSStyleDeclaration>);
document.body.append(ui, hud);

async function getFS(): Promise<GameFS> {
  const dev = await DevServerFS.probe();
  if (dev) return dev;
  return new Promise((resolve) => {
    const b = document.createElement('button');
    b.textContent = 'Select The Suffering install folder';
    b.onclick = async () => resolve(await LocalFolderFS.pickDirectory());
    ui.append(b);
  });
}

async function main() {
  const fs = await getFS();
  onConvertedMediaMissing((msg) => ui.prepend(Object.assign(document.createElement('p'), { textContent: msg })));
  const lib = new CutsceneLibrary(fs);
  const audioContext = new AudioContext(); // music beds (5:32)
  const player = new CutscenePlayer({ audioContext });
  let current = '';
  const play = async (key: string, extra: CutscenePlayOptions & { audio?: boolean } = {}) => {
    const [pkg, id] = key.split(':').map(Number);
    current = key;
    const src = await lib.load(pkg, id, { withAudio: extra.audio ?? q.get('audio') !== '0' });
    console.log(`[cut] play ${key} dur ${src.video.durationSec.toFixed(2)}s sound ${src.sound ? `${src.sound.info.key} (${src.sound.mode}; ${src.sound.pairing})` : 'none'}`);
    const r = await player.play(src, {
      loop: extra.loop ?? (q.has('loop') ? q.get('loop') === '1' : undefined),
      background: extra.background ?? q.get('bg') === '1',
      startAt: extra.startAt ?? Number(q.get('t') ?? 0),
      volume: extra.volume,
    });
    console.log(`[cut] ${key} -> ${r}`, JSON.stringify(statsText()));
    return r;
  };
  const statsText = () => {
    const s = player.stats;
    const n = Math.max(1, s.framesShown);
    return {
      video: current,
      t: +player.currentTime.toFixed(2),
      dur: +player.duration.toFixed(2),
      shown: s.framesShown,
      dropped: s.framesDropped,
      fps: +s.fps.toFixed(1),
      mainMs: +(s.mainMs / n).toFixed(3),
      mainMaxMs: +s.mainMaxMs.toFixed(2),
      seeks: s.seeks,
      startupMs: Math.round(s.startupMs),
      longTicks: s.longTicks,
      heapMB: +(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20).toFixed(1),
    };
  };
  setInterval(() => {
    hud.textContent = Object.entries(statsText()).map(([k, v]) => `${k.padEnd(10)} ${v}`).join('\n');
  }, 250);
  Object.assign(window, { __cut: { lib, player, play, stats: statsText, audioContext } });

  for (const { path, pkg, videos } of await lib.catalog()) {
    const h = document.createElement('div');
    h.textContent = `${path} (pkg ${pkg})`;
    h.style.margin = '8px 0 2px';
    ui.append(h);
    for (const v of videos) {
      const b = document.createElement('button');
      b.textContent = `${v.key} ${v.durationMs / 1000 > 1 ? Math.round(v.durationMs / 1000) + 's' : ''} g${v.group}`;
      b.style.margin = '1px';
      b.onclick = () => void play(v.key);
      ui.append(b);
      void lib.soundtrackFor(pkg, v.id).then((s) => (b.title = s ? `${s.info.key}: ${s.pairing}` : 'silent'));
    }
  }
  const key = q.get('video');
  if (key && q.get('autoplay') !== '0') await play(key);
}

main().catch((e) => {
  console.error(e);
  ui.append(String(e));
});
