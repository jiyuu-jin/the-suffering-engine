// Usage: npx tsx tools/gui.ts <game app dir> [--json] [--node <id>] [--png <outdir>] [--frame N]
//
// Decodes the front-end definitions (src/formats/gui.ts) from a local install and prints the
// screen tree with labels resolved through the game's own string tables.
//   --json      print the FrontEnd model as JSON (references only, no resolved text)
//   --node id   print the generic decoded tree of one Interface template (e.g. 151)
//   --png dir   render every decoded screen's layout to <dir>/<screen>.png (640x480): widget
//               boxes, resolved labels in the game fonts, images, backgrounds, and the main
//               menu over a frame of its first background video (--frame N, default 150;
//               decoded with ffmpeg from $FFMPEG or PATH)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SrscFile } from '../src/formats/srsc';
import { readDbId } from '../src/formats/model';
import type { EntityPackage } from '../src/formats/entities';
import { StringDb } from '../src/formats/strings';
import {
  GUI_VIRTUAL_HEIGHT,
  GUI_VIRTUAL_WIDTH,
  GuiState,
  readFrontEnd,
  readGuiNode,
  resolveRect,
  textColor,
  type FrontEnd,
  type GuiNode,
  type ImageWidget,
  type MenuScreenDef,
  type OptionPageDef,
  type Rect,
  type ScreenBackgroundDef,
  type TextWidget,
} from '../src/formats/gui';
import { readFonts, layoutText, type Font, type FontAtlas } from '../src/formats/font';
import { decodeTexture, TEXTURE_ENTRY_TYPE } from '../src/formats/texture';
import { listVideos } from '../src/formats/video';
import { videoFrameRGBA } from './ffmpeg';
import { encodePng } from './png';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--node', '--png', '--frame'].includes(args[i - 1])));
if (!root || !existsSync(join(root, 'COMMON'))) {
  console.error('usage: npx tsx tools/gui.ts <game app dir> [--json] [--node <id>] [--png <outdir>] [--frame N]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load COMMON packages (odu + xdu; small).

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith('.db')) out.push(p);
  }
  return out;
}
const load = (p: string) => (existsSync(p) ? new SrscFile(new Uint8Array(readFileSync(p)).buffer) : undefined);
const packages = new Map<number, EntityPackage & { base: string }>();
const strings = new StringDb();
for (const db of walk(join(root, 'COMMON'))) {
  const id = readDbId(readFileSync(db, 'latin1'));
  if (id === undefined || packages.has(id)) continue;
  const base = db.slice(0, -3);
  const xdu = load(base + '.xdu');
  packages.set(id, { id, name: basename(base), base, odu: load(base + '.odu'), xdu });
  if (xdu) strings.addFile(xdu, id);
}

const fe = readFrontEnd(packages);
const S = (k?: string) => (k ? (strings.lookup(k) ?? `<${k}?>`) : '');
const q = (k?: string) => (k ? `${k} "${S(k).replace(/\r?\n/g, ' ').slice(0, 70)}"` : '-');

if (args.includes('--json')) {
  console.log(JSON.stringify(fe, (k, v) => (k === 'node' ? undefined : v), 1));
  process.exit(0);
}

const nodeId = flag('--node');
if (nodeId) {
  const n = readGuiNode(packages, { pkg: fe.interfacePkg, id: Number(nodeId) });
  const show = (n: GuiNode, depth: number, label: string) => {
    const pad = '  '.repeat(depth);
    const l = n.layout;
    console.log(`${pad}${label}: ${n.template} ${n.className}${l ? ` [${l.hAlign} x${l.x} ${l.vAlign} y${l.y} w${l.w} h${l.h} bg${l.backgroundTransparency}]` : ''}`);
    for (const [k, v] of Object.entries(n.props)) {
      if (n.children[k] || (l && /^(hAlign|x|vAlign|y|w|h|p6|enabled|bgColor.*|bgTexture|bgTransparency|border|p14)$/.test(k))) continue;
      const txt = typeof v === 'string' && strings.lookup(v) !== undefined && /label|Confirm|level|text|message|name|^p\d+$/i.test(k) ? ` "${S(v).slice(0, 60)}"` : '';
      console.log(`${pad}  .${k} = ${JSON.stringify(v)}${txt}`);
    }
    for (const [k, c] of Object.entries(n.children)) (Array.isArray(c) ? c : [c]).forEach((x, i) => show(x, depth + 1, Array.isArray(c) ? `${k}[${i}]` : k));
  };
  if (n) show(n, 0, 'root');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Text report

const pct = (n: number) => Math.round(n * 100) / 100;
const box = (w: { layout: { hAlign: string; x: number; vAlign: string; y: number; w: number; h: number } }) =>
  `[${w.layout.hAlign[0]}${pct(w.layout.x)},${w.layout.vAlign[0]}${pct(w.layout.y)} ${pct(w.layout.w)}x${pct(w.layout.h)}]`;
const textLine = (t: TextWidget) => `${box(t)} font ${t.font ?? 'default'} x${t.scale[0]} ${q(t.label)}`;
const imgLine = (i: ImageWidget) => `${box(i)} tex ${i.texture} uv(${i.uv.x},${i.uv.y},${i.uv.w},${i.uv.h})`;

function printMenu(m: MenuScreenDef) {
  console.log(`\n== ${m.id}  (${m.template} ${m.className}, bg transparency ${m.layout.backgroundTransparency})`);
  for (const t of m.titles) console.log(`  title  ${imgLine(t)}`);
  m.items.forEach((it, i) =>
    console.log(
      `  ${i === m.defaultFocus ? '*' : ' '}item ${it.id.padEnd(16)} p${it.prop} -> ${it.action.kind}${it.action.screen ? ':' + it.action.screen : ''}${it.action.difficulty !== undefined ? ' d' + it.action.difficulty : ''}${it.action.transitionVideo ? ' +video' : ''}${it.platform ? ' [' + it.platform + ']' : ''}${it.disabledWhen ? ' (disabled when ' + it.disabledWhen + ')' : ''}  ${textLine(it.widget)}${it.action.confirm ? '  confirm ' + q(it.action.confirm) : ''}`,
    ),
  );
  for (const t of m.footers) console.log(`  footer ${textLine(t)}`);
}

function printPage(p: OptionPageDef) {
  console.log(`\n== page ${p.id}  (${p.template} ${p.className})`);
  for (const t of p.titles) console.log(`  title  ${imgLine(t)}`);
  for (const r of p.rows) {
    const extra =
      r.kind === 'slider' ? ` meter ${r.meter.template} [x${pct(r.meter.layout!.x)} y${pct(r.meter.layout!.y)}]` : r.kind === 'choice' ? ` choices: ${r.choices.map((c) => q(c.label)).join(' | ')}` : '';
    console.log(`  ${r.kind.padEnd(6)} ${r.id.padEnd(18)}${r.platform ? '[console] ' : ''}${textLine(r.label)}${extra}`);
  }
  if (p.accept) console.log(`  accept ${textLine(p.accept)}`);
  if (p.cancel) console.log(`  cancel ${textLine(p.cancel)}`);
  for (const t of p.extraTexts) console.log(`  text   ${textLine(t)}`);
  for (const [k, v] of Object.entries(p.strings)) console.log(`  string ${k}: ${q(v)}`);
}

console.log(`User Interface Properties ${fe.uiProperties}; default font ${fe.defaultFont}; cursor ${fe.cursorTexture}`);
console.log('\nBoot sequence:');
for (const b of fe.boot) {
  if (b.kind === 'openingMovies')
    console.log(`  openingMovies (one picked at random): ${b.choices.map((c) => `${c.template}{${c.movies.map((m) => `video ${m.video} + snd ${m.soundtrack}`).join(', ')}}`).join(' | ')}`);
  else if (b.kind === 'copyright')
    console.log(`  copyright ${b.template}: background ${b.background?.tiles.join(',')} for ${b.seconds} s, preload ${b.preloadPackages.map(q).join(', ')}`);
  else console.log(`  mainMenu ${b.template}`);
}
const mm = fe.mainMenu;
if (mm) {
  printMenu(mm);
  for (const l of mm.logo) console.log(`  logo   ${imgLine(l)}`);
  console.log(`  new game level ${q(mm.newGame.level)}; after finishing the game ${q(mm.newGame.unlockedLevel)}`);
  console.log(`  videos: first ${mm.videos.first}; backgrounds ${mm.videos.backgrounds.join(',')}; transition ${mm.videos.transition.join(',')}; back ${mm.videos.back.join(',')}`);
  console.log(`  attract: ${mm.videos.attract?.video} + snd ${mm.videos.attract?.soundtrack} after ${mm.videos.idleSeconds} s idle`);
  console.log(`  ambience: loops ${mm.ambience.loops.join(',')}; one-shots ${mm.ambience.oneShots.join(',')} every ${mm.ambience.delaySeconds} s, radius ${mm.ambience.radius.join('..')}, fade ${mm.ambience.fadeOutSeconds} s`);
  console.log(`  quit confirm ${q(mm.strings.quitConfirm)}`);
  printMenu(mm.difficulty);
}
if (fe.pause) printMenu(fe.pause);
if (fe.options.frontEnd) printMenu(fe.options.frontEnd);
if (fe.options.inGame) printMenu(fe.options.inGame);
for (const p of Object.values(fe.optionPages)) printPage(p);
console.log('\nUI sounds:', JSON.stringify(fe.sounds));
console.log('Strings:');
for (const [k, v] of Object.entries(fe.strings)) console.log(`  ${k}: ${q(v)}`);
console.log('\nLoading screens:');
console.log(`  default ${fe.loading.default?.template} bg ${fe.loading.default?.background?.template}; new game ${fe.loading.newGame?.template} bg ${fe.loading.newGame?.background?.template}; indicator ${fe.loading.indicator?.texture}`);
console.log(`  generic backgrounds: ${fe.loading.backgrounds.map((b) => b.template).join(', ')}`);
for (const c of fe.loading.chapters) console.log(`  chapter ${q(c.name)} -> ${c.loadingScreen?.template} bg ${c.loadingScreen?.background?.template}`);
console.log('\nScreens by UIP slot:');
for (const [k, n] of Object.entries(fe.screens)) console.log(`  ${k.padEnd(22)} ${n.template} ${n.className}`);
if (fe.hud) {
  console.log('\nHUD (Player template):');
  for (const [k, n] of Object.entries(fe.hud)) if (n) console.log(`  ${k.padEnd(14)} ${n.template} ${n.className}${n.layout ? ` [x${pct(n.layout.x)} y${pct(n.layout.y)} ${pct(n.layout.w)}x${pct(n.layout.h)}]` : ''}`);
}

// ---------------------------------------------------------------------------
// PNG layout renderer (verification only)

const outDir = flag('--png');
if (outDir) renderAll(fe, outDir);

function renderAll(fe: FrontEnd, dir: string) {
  mkdirSync(dir, { recursive: true });
  const ifc = packages.get(fe.interfacePkg)!;
  const tdu = load(ifc.base + '.tdu')!;
  const fdu = load(ifc.base + '.fdu')!;
  const texCache = new Map<number, { width: number; height: number; rgba: Uint8Array } | null>();
  const tex = (k?: string) => {
    if (!k) return null;
    const id = Number(k.split(':')[1]);
    if (!texCache.has(id)) {
      const e = tdu.entries.find((x) => x.type === TEXTURE_ENTRY_TYPE && x.id === id);
      texCache.set(id, e ? decodeTexture(tdu, e) : null);
    }
    return texCache.get(id)!;
  };
  const fonts = new Map<number, { font: Font; atlases: FontAtlas[] }>();
  for (const f of readFonts(fdu, fe.interfacePkg)) fonts.set(f.id, { font: f, atlases: f.textures.map((t) => tex(`${t.pkg}:${t.id}`)!).filter(Boolean) });
  const W = GUI_VIRTUAL_WIDTH;
  const H = GUI_VIRTUAL_HEIGHT;
  const SCREEN: Rect = { x: 0, y: 0, w: W, h: H };

  class Canvas {
    rgba = new Uint8Array(W * H * 4);
    constructor(r = 0, g = 0, b = 0) {
      for (let i = 0; i < W * H; i++) this.rgba.set([r, g, b, 255], i * 4);
    }
    blend(x: number, y: number, r: number, g: number, b: number, a: number) {
      x |= 0;
      y |= 0;
      if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
      const o = (y * W + x) * 4;
      const t = a / 255;
      this.rgba[o] = this.rgba[o] * (1 - t) + r * t;
      this.rgba[o + 1] = this.rgba[o + 1] * (1 - t) + g * t;
      this.rgba[o + 2] = this.rgba[o + 2] * (1 - t) + b * t;
    }
    fill(rc: Rect, rgb: number, a: number) {
      for (let y = Math.max(0, rc.y | 0); y < Math.min(H, rc.y + rc.h); y++)
        for (let x = Math.max(0, rc.x | 0); x < Math.min(W, rc.x + rc.w); x++) this.blend(x, y, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, a);
    }
    outline(rc: Rect, rgb: number) {
      const [r, g, b] = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
      for (let x = rc.x; x <= rc.x + rc.w; x++) {
        this.blend(x, rc.y, r, g, b, 160);
        this.blend(x, rc.y + rc.h, r, g, b, 160);
      }
      for (let y = rc.y; y <= rc.y + rc.h; y++) {
        this.blend(rc.x, y, r, g, b, 160);
        this.blend(rc.x + rc.w, y, r, g, b, 160);
      }
    }
    image(src: { width: number; height: number; rgba: Uint8Array }, sx: number, sy: number, sw: number, sh: number, d: Rect, opaque = false) {
      if (d.w <= 0 || d.h <= 0) return;
      for (let y = 0; y < d.h; y++)
        for (let x = 0; x < d.w; x++) {
          const u = Math.min(src.width - 1, Math.floor(sx + ((x + 0.5) / d.w) * sw));
          const v = Math.min(src.height - 1, Math.floor(sy + ((y + 0.5) / d.h) * sh));
          const o = (v * src.width + u) * 4;
          this.blend(d.x + x, d.y + y, src.rgba[o], src.rgba[o + 1], src.rgba[o + 2], opaque ? 255 : src.rgba[o + 3]);
        }
    }
  }

  const drawBackground = (c: Canvas, bg?: ScreenBackgroundDef) => {
    if (!bg) return;
    bg.tiles.forEach((t, i) => {
      const img = tex(t);
      if (!img) return;
      const col = i % 3;
      const row = Math.floor(i / 3);
      c.image(img, 0, 0, img.width, img.height, { x: Math.round((col * W) / 3), y: Math.round((row * H) / 2), w: Math.ceil(W / 3), h: Math.ceil(H / 2) }, true);
    });
  };
  const drawImage = (c: Canvas, w: ImageWidget, parent: Rect = SCREEN) => {
    const rc = resolveRect(w.layout, parent);
    const img = tex(w.texture);
    if (img) {
      const uv = w.uv.w && w.uv.h ? w.uv : { x: 0, y: 0, w: img.width, h: img.height };
      c.image(img, uv.x, uv.y, uv.w, uv.h, rc);
    }
    c.outline(rc, 0x40a0ff);
    return rc;
  };
  const drawText = (c: Canvas, t: TextWidget, state: number, parent: Rect = SCREEN, text?: string) => {
    const rc = resolveRect(t.layout, parent);
    c.outline(rc, state === GuiState.Focused ? 0xffff00 : 0x00c000);
    const str = (text ?? S(t.label)).replace(/\r\n?/g, '\n').trimEnd(); // some labels end in a line break
    const fid = Number((t.font ?? fe.defaultFont ?? '5:2').split(':')[1]);
    const f = fonts.get(fid);
    if (!str || !f) return rc;
    const mL = (t.margins.left * W) / 100;
    const mR = (t.margins.right * W) / 100;
    const mT = (t.margins.top * H) / 100;
    const mB = (t.margins.bottom * H) / 100;
    const [sx, sy] = t.scale;
    const lay = layoutText(f.font, str, { maxWidth: Math.max(8, (rc.w - mL - mR) / sx), align: t.hTextAlign });
    const tw = lay.width * sx;
    const th = lay.height * sy;
    const x0 = t.hTextAlign === 'left' ? rc.x + mL : t.hTextAlign === 'right' ? rc.x + rc.w - mR - tw : rc.x + (rc.w - tw) / 2;
    const y0 = t.vTextAlign === 'top' ? rc.y + mT : t.vTextAlign === 'bottom' ? rc.y + rc.h - mB - th : rc.y + (rc.h - th) / 2;
    const col = textColor(t, state as never) || 0xffffff;
    for (const pg of lay.glyphs) {
      const a = f.atlases[pg.glyph.page];
      if (!a) continue;
      const d = { x: Math.round(x0 + pg.x * sx), y: Math.round(y0 + pg.y * sy), w: Math.round(pg.glyph.width * sx), h: Math.round(pg.glyph.height * sy) };
      for (let y = 0; y < d.h; y++)
        for (let x = 0; x < d.w; x++) {
          const u = pg.glyph.x + Math.floor((x / d.w) * pg.glyph.width);
          const v = pg.glyph.y + Math.floor((y / d.h) * pg.glyph.height);
          c.blend(d.x + x, d.y + y, (col >> 16) & 255, (col >> 8) & 255, col & 255, a.rgba[(v * a.width + u) * 4 + 3]);
        }
    }
    return rc;
  };
  const drawMeter = (c: Canvas, n: GuiNode, parent: Rect = SCREEN) => {
    if (!n.layout) return;
    const rc = resolveRect(n.layout, parent);
    c.fill({ x: rc.x, y: rc.y, w: rc.w * 0.6, h: rc.h }, 0x808080, 120);
    c.outline(rc, 0xff40ff);
  };
  const dim = (c: Canvas, transparency: number) => {
    if (transparency < 99.9) c.fill(SCREEN, 0, 255 * (1 - transparency / 100));
  };
  const save = (name: string, c: Canvas) => {
    writeFileSync(join(dir, `${name}.png`), encodePng(W, H, c.rgba));
    console.log(`wrote ${join(dir, name + '.png')}`);
  };

  // Main menu background: a frame of the first background video, stretched to the screen.
  let videoFrame: { width: number; height: number; rgba: Uint8Array } | null = null;
  const first = fe.mainMenu?.videos.first;
  if (first && existsSync(ifc.base + '.vdu')) {
    try {
      const vdu = load(ifc.base + '.vdu')!;
      const info = listVideos(vdu, fe.interfacePkg).find((v) => v.id === Number(first.split(':')[1]));
      if (!info) throw new Error(`video ${first} not found`);
      videoFrame = videoFrameRGBA(vdu.bytes(info.data), Number(flag('--frame') ?? 150), info.width, info.height);
    } catch (e) {
      console.warn('video frame failed:', (e as Error).message);
    }
  }
  const menuBase = () => {
    const c = new Canvas(16, 16, 16);
    if (videoFrame) c.image(videoFrame, 0, 0, videoFrame.width, videoFrame.height, SCREEN, true);
    return c;
  };
  const drawMenu = (c: Canvas, m: MenuScreenDef) => {
    const rc = resolveRect(m.layout, SCREEN);
    dim(c, m.layout.backgroundTransparency);
    for (const t of m.titles) drawImage(c, t, rc);
    m.items.filter((i) => !i.platform).forEach((it, i) => drawText(c, it.widget, i === m.defaultFocus ? GuiState.Focused : GuiState.Normal, rc));
    for (const t of m.footers) drawText(c, t, GuiState.Normal, rc, S(t.label) || '(runtime hint text)');
  };

  if (fe.mainMenu) {
    const c = menuBase();
    for (const l of fe.mainMenu.logo) drawImage(c, l);
    drawMenu(c, fe.mainMenu);
    save('mainMenu', c);
    const d = menuBase();
    drawMenu(d, fe.mainMenu.difficulty);
    save('difficulty', d);
  }
  if (fe.pause) {
    const c = new Canvas(90, 70, 50); // stand-in for the game view
    drawMenu(c, fe.pause);
    save('pause', c);
  }
  for (const m of [fe.options.frontEnd, fe.options.inGame]) {
    if (!m) continue;
    const c = m.id === 'optionsInGame' ? new Canvas(90, 70, 50) : menuBase();
    drawMenu(c, m);
    save(m.id, c);
  }
  for (const p of Object.values(fe.optionPages)) {
    const inGame = /InGame$/.test(p.id);
    const c = inGame ? new Canvas(90, 70, 50) : menuBase();
    const rc = resolveRect(p.layout, SCREEN);
    dim(c, p.layout.backgroundTransparency);
    const bgNode = p.node.children['p17'];
    if (p.className === 'GUI Screen Adjust' && bgNode && !Array.isArray(bgNode) && bgNode.className === 'Screen Background') {
      const bg = { kind: 'background' as const, template: bgNode.template, tiles: [0, 1, 2, 3, 4, 5].map((i) => bgNode.props[`p${i}`] as string), cols: 3 as const, rows: 2 as const };
      drawBackground(c, bg);
    }
    for (const t of p.titles) drawImage(c, t, rc);
    for (const k of Object.values(p.node.children)) for (const x of Array.isArray(k) ? k : [k]) if (x.className === 'Listbox Control' && x.layout) c.outline(resolveRect(x.layout, rc), 0xff8000);
    for (const r of p.rows) {
      if (r.platform) continue;
      drawText(c, r.label, GuiState.Normal, rc);
      if (r.kind === 'slider') drawMeter(c, r.meter, rc);
      if (r.kind === 'choice' && r.choices[0]) drawText(c, r.choices[0], GuiState.Normal, rc);
    }
    if (p.accept) drawText(c, p.accept, GuiState.Focused, rc);
    if (p.cancel) drawText(c, p.cancel, GuiState.Normal, rc);
    for (const t of p.extraTexts) if (t.label && S(t.label)) drawText(c, t, GuiState.Normal, rc);
    for (const t of p.footers) drawText(c, t, GuiState.Normal, rc, S(t.label) || '(runtime hint text)');
    save(`page_${p.id}`, c);
  }
  const copyright = fe.boot.find((b) => b.kind === 'copyright');
  if (copyright && copyright.kind === 'copyright') {
    const c = new Canvas();
    drawBackground(c, copyright.background);
    save('copyright', c);
  }
  const loading = (name: string, l?: FrontEnd['loading']['default']) => {
    if (!l) return;
    const c = new Canvas();
    drawBackground(c, l.background);
    const pm = l.progressMeter;
    if (pm) drawMeter(c, pm);
    if (l.text) drawText(c, l.text, GuiState.Normal, SCREEN, S(l.text.label) || '(status text)');
    save(name, c);
  };
  loading('loading_default', fe.loading.default);
  loading('loading_newGame', fe.loading.newGame);
  fe.loading.chapters.slice(0, 3).forEach((ch, i) => loading(`loading_chapter${i}`, ch.loadingScreen));
  if (fe.hud) {
    const c = new Canvas(90, 70, 50);
    for (const n of Object.values(fe.hud)) {
      if (!n?.layout || n.layout.w >= 50) continue; // containers (inventory, message list, ammo group)
      if (n.className === 'HUD Texture') {
        const img = { kind: 'image' as const, template: n.template, layout: n.layout, texture: n.props.texture as string, uv: { x: n.props.u as number, y: n.props.v as number, w: n.props.uw as number, h: n.props.vh as number } };
        drawImage(c, img);
      } else drawMeter(c, n);
    }
    save('hud', c);
  }
}
