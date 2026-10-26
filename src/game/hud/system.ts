// In-game HUD (GameSystem). Draws, from the game's own GUI templates, fonts and
// textures (docs/frontend.md §10):
//   * health meter (Player p277, 5:135), insanity meter + its full-meter frame
//     (p278/p279, 5:136/5:543), flashlight battery (p281, 5:524), Xombium bottle
//     counter (p282, 5:457), the current weapon's ammo meter (Ranged Weapon p89)
//     and throwable count (Missile Item p56), the crosshair (5:202 / 5:442);
//   * pickup text (p284, 5:460), the game message list (UIP 26, 5:172), the
//     checkpoint notice (UIP 28, 5:426), help popups (Help Popup guiTemplate,
//     5:411), the interaction prompt, a damage flash and the death overlay.
// Layout is the templates' percent rects in the 640x480 virtual screen, fitted
// to a centred 4:3 area like the menus. Data comes from HudModel (model.ts) and
// the HUD bus (bus.ts) that the legacy HUD calls write to. Meters follow the HUD
// block fades (widgets.ts): they show when their value changes and fade back to
// their idle opacity (health hidden unless low, weapon ammo always shown).
//
// Hidden while flying (noclip), during cinematics (.stomp-cine on the viewport,
// services.world.inCutscene) and while the front end (menus/pause) is open.
// Help popups respect the gameplay option "help text" (settings.extra.helpText:
// 0 = On, 1 = Off).
//
// Also: the inventory GUI (inventory.ts, Inventory key), notices in a Simple Text HUD
// template (services.hud.notice: the Archives Trigger's "page unlocked" text, template p2 =
// 5:660), the native gameplay actions (actions.ts), and the death flow (red fade, the revert prompt with the Use / Fire keys, a fade to black before
// the save system restores the checkpoint). Publishes services.input.bindings (placeholder
// labels from bindings.ts) and keeps it current when keys are rebound.

import type { GameContext, GameSystem } from '../runtime';
import { loadSettings } from '../../app/menu/settings';
import { hudBus, postHudMessage, resetHudBus, type HudMessage } from './bus';
import { loadHudAssets, type HudAssets } from './assets';
import { readHudModel, type HudModel } from './model';
import { currentBindings, expandHelpText, parsePrompt } from './controls';
import {
  VH,
  VW,
  ammoMeterDef,
  drawAmmoMeter,
  drawImage,
  drawMeter,
  drawText,
  fadeAlpha,
  imageDef,
  lineHeight,
  meterDef,
  textDef,
  type AmmoMeterDef,
  type HudFade,
  type ImageDef,
  type MeterDef,
  type Painter,
  type TextDef,
} from './widgets';
import type { GuiNode, TextWidget } from '../../formats/gui';
import { textWidget } from '../../formats/gui';
import { input } from './bindings';
import { registerSave } from '../save/providers';
import { profile } from '../../app/menu/profile';
import { installActions } from './actions';
import { InventoryGui } from './inventory';
import { buildMapData } from './map';
import { InventoryIcons } from './icons3d';
import type { PackageSet } from '../../formats/model';
import { SubtitleOverlay } from '../sequence/subtitles';
import { readXduString } from '../../formats/entities';
import type { EntityPackageSet } from '../../formats/entities';
import { uiBridge } from './ui-bridge';
import { pads } from '../../app/gamepad';
import { drawPadGlyph, padGlyphWidth } from '../../app/glyphs';
import { portOptions } from '../port-options';

/** HUD marker while the port option "Enemies ignore the player" is on. */
export const PORT_TAG_IGNORE_PLAYER = 'ENEMIES IGNORE PLAYER (port option)';

const CSS = `
.hud-canvas { position:absolute !important; left:0; top:0; width:100% !important; height:100% !important; pointer-events:none; z-index:6; }
.stomp-cine .hud-canvas, .stomp-cine .hud-icons { display:none !important; }
body:has(#frontend:not([hidden])) .hud-canvas, body:has(#frontend:not([hidden])) .hud-icons { display:none !important; }
`;

/** Templates used when a level's packages lack them (all in the Interface package). */
const HELP_TEMPLATE = '5:411';
const CROSSHAIR = '5:202';
const CROSSHAIR_HOT = '5:442';
const CHECKPOINT_LABEL = '5:107';
const REVERT_LABEL = '5:187';
/** Archives Trigger notice template (p2) when the trigger names none. */
const ARCHIVE_NOTICE = '5:660';
/** Seconds after death before the revert prompt / input is accepted, and the save system's restart delay. */
const DEATH_PROMPT = 1.2;
const DEATH_RESTART = 4;

interface Layout {
  health?: MeterDef;
  insanity?: MeterDef;
  insanityFrame?: ImageDef;
  flashlight?: MeterDef;
  bottles?: AmmoMeterDef;
  pickup?: TextDef;
  messages?: { x: number; y: number; w: number; rowH: number; rows: number; widget: TextWidget; hold: number };
  checkpoint?: TextDef;
  help?: TextDef;
  crosshair?: ImageDef;
  crosshairHot?: ImageDef;
}

function buildLayout(a: HudAssets): Layout {
  const h = a.hud;
  const L: Layout = {
    health: meterDef(h?.health),
    insanity: meterDef(h?.insanity),
    insanityFrame: imageDef(h?.insanityFrame),
    flashlight: meterDef(h?.flashlight),
    bottles: ammoMeterDef(h?.ammo),
    pickup: textDef(h?.pickupMessage),
    checkpoint: textDef(h?.checkpointText),
    help: textDef(a.node(HELP_TEMPLATE)),
    crosshair: imageDef(a.node(CROSSHAIR)),
    crosshairHot: imageDef(a.node(CROSSHAIR_HOT)),
  };
  const ml = h?.messageList;
  const row = ml?.children.p16 as GuiNode | undefined;
  const rowText = row && !Array.isArray(row) ? (row.children.p23 as GuiNode | undefined) : undefined;
  const rw = textWidget(rowText && !Array.isArray(rowText) ? rowText : undefined);
  if (ml?.layout && row?.layout && rw) {
    const rows = typeof ml.props.p17 === 'number' ? ml.props.p17 : 3;
    L.messages = {
      x: (ml.layout.x * VW) / 100,
      y: (ml.layout.y * VH) / 100,
      w: Math.min((ml.layout.w * VW) / 100, VW - (ml.layout.x * VW) / 100),
      rowH: (row.layout.h * VH) / 100,
      rows,
      widget: rw,
      hold: typeof row.props.p16 === 'number' ? row.props.p16 : 5,
    };
  }
  return L;
}

const FADE_IN = 0.15;
const FADE_OUT = 0.6;
/** Opacity of a timed message: quick fade in, hold, fade out. */
const msgAlpha = (age: number, hold: number) =>
  age < 0 ? 0 : Math.min(1, age / FADE_IN) * (age < hold ? 1 : Math.max(0, 1 - (age - hold) / FADE_OUT));

export async function createHudSystem(ctx: GameContext): Promise<GameSystem> {
  const { view } = ctx;
  const container = view.renderer.domElement.parentElement ?? document.body;
  const style = document.createElement('style');
  style.textContent = CSS;
  const canvas = document.createElement('canvas');
  canvas.className = 'hud-canvas';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.append(style, canvas);
  const g = canvas.getContext('2d')!;

  let assets: HudAssets | undefined;
  let layout: Layout = {};
  let disposed = false;
  let inventory: InventoryGui | undefined;
  let icons: InventoryIcons | undefined;
  /** 3d Icon templates of the inventory cell (#158 p17 focused / p21 normal): spin p26, p25. */
  const iconStyle = () => {
    const cell = assets?.node('5:158');
    const kid = (k: string) => {
      const c = cell?.children[k];
      return Array.isArray(c) ? c[0] : c;
    };
    const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return { spin: n(kid('p17')?.props.p26, 30), focused: n(kid('p17')?.props.p25, 1), normal: n(kid('p21')?.props.p25, 0.5) };
  };
  void loadHudAssets(ctx)
    .then((a) => {
      if (disposed) return;
      assets = a;
      layout = buildLayout(a);
      inventory = new InventoryGui(a.hud?.inventory ?? a.node('5:157'));
      console.info(`[hud] ready (${Object.values(layout).filter(Boolean).length} widgets, font ${a.font ? 'ok' : 'fallback'})`);
    })
    .catch((err) => console.warn('[hud] assets unavailable', err));

  const painter: Painter = { g, font: null, texture: (k) => assets?.texture(k) };

  // Help-text option: the live menu settings when the menu flow runs, else the stored ones.
  let storedSettings = loadSettings();
  let settingsAt = 0;
  const helpEnabled = () => {
    const live = (window as { __menu?: { settings?: { extra?: Record<string, unknown> } } }).__menu?.settings;
    if (!live && hudBus.clock - settingsAt > 2) {
      settingsAt = hudBus.clock;
      storedSettings = loadSettings();
    }
    const v = (live ?? storedSettings).extra?.helpText;
    return !(v === 1 || v === false);
  };

  // Value tracking for the damage/heal flashes and insanity "full" pulse.
  let lastHealth = NaN;
  let healthFlashAt = -1e9;
  let deadAt = -1e9;
  let wasDead = false;
  let lastHelpText: string | null = null;
  let helpAt = 0;
  // Change tracking for the HUD block fades: key -> { value, changed-at clock }.
  const changes = new Map<string, { v: string | number; at: number }>();
  /** Opacity of a faded element whose tracked value is `v` (any change re-shows it). */
  const shown = (key: string, v: string | number, fade: HudFade, eps = 1e-3, force = false) => {
    const c = changes.get(key);
    const t = hudBus.clock;
    if (!c) changes.set(key, { v, at: t });
    else if (typeof v === 'number' && typeof c.v === 'number' ? Math.abs(v - c.v) > eps : v !== c.v) {
      c.v = v;
      c.at = t;
    }
    return force ? fade.active : fadeAlpha(fade, t - changes.get(key)!.at);
  };

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(container.clientWidth * dpr));
    const h = Math.max(1, Math.round(container.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  // (Hidden: the canvas is cleared once, not every frame; a full-window clear at the display's
  // pixel ratio is a canvas commit per frame for nothing, docs/perf.md.)
  let blank = false;
  const draw = (m: HudModel) => {
    resize();
    const W = canvas.width;
    const H = canvas.height;
    const visible = hudBus.combatVisible && view.walking && !m.inCutscene && !container.classList.contains('stomp-cine');
    if (visible || !blank) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
    }
    blank = !visible;
    canvas.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return icons?.hide();
    const t = hudBus.clock;
    painter.font = assets?.font ?? null;

    // Full-window effects first (damage flash, death), then the 4:3 HUD on top.
    const dmg = Math.max(0, 1 - (t - hudBus.damageAt) / 0.45);
    if (dmg > 0) {
      const gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.55);
      gr.addColorStop(0, 'rgba(140,0,0,0)');
      gr.addColorStop(1, `rgba(140,0,0,${0.55 * dmg})`);
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
    }
    const dead = !m.alive || hudBus.dead;
    if (dead) {
      const k = Math.min(1, (t - deadAt) / 1.5);
      g.fillStyle = `rgba(40,0,0,${0.65 * k})`;
      g.fillRect(0, 0, W, H);
    }

    const s = Math.min(W / VW, H / VH);
    g.setTransform(s, 0, 0, s, (W - VW * s) / 2, (H - VH * s) / 2);
    g.imageSmoothingEnabled = true;

    // Crosshair (hidden when dead).
    if (!dead) {
      const hot = m.targeting || t - hudBus.hitAt < (hudBus.hitKill ? 0.25 : 0.12);
      const ch = (hot ? layout.crosshairHot : undefined) ?? layout.crosshair;
      const custom = m.weapon?.crosshair && !hot ? imageDef(assets?.node(m.weapon.crosshair)) : undefined;
      const c = custom ?? ch;
      if (c) drawImage(painter, c.tex, c.uv, c.rect, 0.9);
      else {
        g.fillStyle = 'rgba(230,225,210,0.85)';
        g.fillRect(VW / 2 - 0.5, VH / 2 - 5, 1, 10);
        g.fillRect(VW / 2 - 5, VH / 2 - 0.5, 10, 1);
      }
    }

    // Health.
    const hFrac = m.maxHealth > 0 ? m.health / m.maxHealth : 0;
    if (!Number.isNaN(lastHealth) && Math.abs(m.health - lastHealth) > 0.01) healthFlashAt = t;
    lastHealth = m.health;
    if (layout.health) {
      const hm = layout.health;
      const a = shown('health', hFrac, hm.fade, 1e-3, hFrac <= hm.lowFrac || dead);
      if (a > 0.01) drawMeter(painter, hm, { value: hFrac, time: t, alpha: a, flash: Math.max(0, 1 - (t - healthFlashAt) / 0.35) });
    }

    // Insanity (+ the frame flashing while full / transformed).
    if (layout.insanity && m.insanity !== undefined) {
      const full = m.insanityReady;
      const a = shown('insanity', m.insanity, layout.insanity.fade, 2e-3, full || m.insane);
      if (a > 0.01) drawMeter(painter, layout.insanity, { value: m.insanity, time: t, alpha: a, flash: full ? 0.5 + 0.5 * Math.sin(t * 8) : 0 });
      if ((full || m.insane) && layout.insanityFrame) {
        const fr = layout.insanityFrame;
        drawImage(painter, fr.tex, fr.uv, fr.rect, 0.55 + 0.45 * Math.sin(t * (m.insane ? 4 : 8)));
      }
    }

    // Flashlight battery.
    if (layout.flashlight && m.flashlight) {
      const fm = layout.flashlight;
      const a = Math.max(shown('flashlight', m.flashlight.battery, fm.fade, 1e-3), shown('flashlightOn', m.flashlight.on ? 1 : 0, fm.fade));
      if (a > 0.01) drawMeter(painter, fm, { value: m.flashlight.battery, time: t, alpha: a });
    }

    // Xombium bottles.
    if (layout.bottles && m.healthPacks !== undefined) {
      const a = shown('bottles', m.healthPacks, layout.bottles.fade);
      if (a > 0.01) drawAmmoMeter(painter, layout.bottles, m.healthPacks, String(m.healthPacks), t, a);
    }

    // Current weapon's ammo meter; throwable count.
    if (m.weapon?.ranged && m.weapon.ammoMeter) {
      const d = ammoMeterDef(assets?.node(m.weapon.ammoMeter));
      const a = d ? shown('ammo', `${m.weapon.ammoMeter}|${m.weapon.clip}|${m.weapon.reserve}`, d.fade) : 0;
      if (d && a > 0.01) drawAmmoMeter(painter, d, m.weapon.clip, m.weapon.reserve !== undefined ? String(m.weapon.reserve) : undefined, t, a);
    }
    if (m.throwable?.meter) {
      const d = ammoMeterDef(assets?.node(m.throwable.meter));
      const a = d ? shown('throwable', `${m.throwable.meter}|${m.throwable.count}`, d.fade) : 0;
      if (d && a > 0.01) drawAmmoMeter(painter, d, m.throwable.count, String(m.throwable.count), t, a);
    }

    if (!dead && inventory) {
      icons ??= ctx.loaded.packages ? new InventoryIcons(container, ctx.loaded.packages as PackageSet, iconStyle()) : undefined;
      inventory.draw(painter, t, InventoryGui.rows(ctx.services), icons);
      icons?.render(inventory.iconCells, inventory.iconAlpha, t, { W, H, s, ox: (W - VW * s) / 2, oy: (H - VH * s) / 2 });
    } else icons?.hide();
    drawMessages(t);
    // The inventory strip shares the top-left corner with the notice and help popups.
    if (!dead && (!inventory || inventory.visible(t) < 0.5)) {
      drawNotice(t);
      drawHelp(t);
    }
    drawPrompt(dead);
    drawPortTag();

    if (dead) {
      const since = t - deadAt;
      const k = Math.min(1, Math.max(0, (since - DEATH_PROMPT) / 0.6));
      const w = layout.checkpoint?.widget ?? layout.pickup?.widget ?? layout.help?.widget;
      if (w && k > 0) {
        const label = assets?.string(REVERT_LABEL) ?? 'Revert';
        const glyphs = pads.usingPad ? [input.padButton('use'), input.padButton('fire')].filter((i) => i >= 0) : [];
        if (glyphs.length) {
          // Pad: the Use / Fire buttons' glyphs before the label.
          const gh = 20;
          const gw = glyphs.reduce((sum, i) => sum + padGlyphWidth(i, gh, pads.family) + 4, 0) + 4;
          const r = drawText(painter, w, { x: gw / 2, y: VH * 0.45, w: VW, h: VH * 0.08 }, `- ${label}`, { alpha: k, align: 'center', color: '#d8d0c0' });
          let x = r.x - gw;
          for (const i of glyphs) x += drawPadGlyph(g, pads.family, i, x, r.y + r.h / 2, gh, k) + 4;
        } else {
          const keys = [input.label('use'), input.label('fire')].filter(Boolean).join(' / ');
          drawText(painter, w, { x: 0, y: VH * 0.45, w: VW, h: VH * 0.08 }, keys ? `${keys} - ${label}` : label, { alpha: k, align: 'center', color: '#d8d0c0' });
        }
      }
      // Fade to black just before the checkpoint is restored (save system, 4 s).
      const fb = Math.min(1, Math.max(0, (since - (DEATH_RESTART - 0.7)) / 0.6));
      if (fb > 0 || reverting) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = `rgba(0,0,0,${reverting ? 1 : fb})`;
        g.fillRect(0, 0, W, H);
      }
    }
  };

  /** Port option marker (src/game/port-options.ts): screenshots and recordings show it is on. */
  const drawPortTag = () => {
    if (!portOptions.ignorePlayer) return;
    g.save();
    g.font = '600 9px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(0,0,0,0.45)';
    const text = PORT_TAG_IGNORE_PLAYER;
    const w = g.measureText(text).width + 10;
    g.fillRect(VW / 2 - w / 2, 3, w, 13);
    g.fillStyle = 'rgba(255,196,110,0.92)';
    g.fillText(text, VW / 2, 5);
    g.restore();
  };

  /** Notice in a Simple Text HUD template (Archives Trigger "page unlocked" text). */
  let notice: { text: string; template?: string; at: number } | null = null;
  const noticeDefs = new Map<string, ReturnType<typeof textDef>>();
  const drawNotice = (t: number) => {
    const n = notice;
    if (!n || !assets) return;
    const tpl = n.template ?? ARCHIVE_NOTICE;
    if (!noticeDefs.has(tpl)) noticeDefs.set(tpl, textDef(assets.node(tpl)));
    const d = noticeDefs.get(tpl);
    if (!d) return;
    const a = msgAlpha(t - n.at, d.hold);
    if (a <= 0) return;
    drawText(painter, d.widget, d.rect, n.text, { alpha: a });
  };

  const drawMessages = (t: number) => {
    const msgs = hudBus.messages;
    // Pickup text (right-aligned, newest at the bottom of the widget).
    const pk = layout.pickup;
    if (pk) {
      const live = msgs.filter((x) => x.kind === 'pickup' && msgAlpha(t - x.at, x.hold ?? pk.hold) > 0).slice(-3);
      const lh = lineHeight(painter, pk.widget) * 1.05;
      live.forEach((x, i) => {
        const r = { ...pk.rect, y: pk.rect.y + (i - (live.length - 1)) * lh };
        drawText(painter, pk.widget, r, x.text, { alpha: msgAlpha(t - x.at, x.hold ?? pk.hold) });
      });
    }
    // Game message list (rows, newest last).
    const ml = layout.messages;
    if (ml) {
      const live = msgs.filter((x) => x.kind === 'message' && msgAlpha(t - x.at, x.hold ?? ml.hold) > 0).slice(-ml.rows);
      live.forEach((x, i) =>
        drawText(painter, ml.widget, { x: ml.x, y: ml.y + i * ml.rowH, w: ml.w, h: ml.rowH }, x.text, { alpha: msgAlpha(t - x.at, x.hold ?? ml.hold) }),
      );
    }
    // Checkpoint notice / banner (the game's own label).
    const cp = layout.checkpoint;
    if (cp) {
      const last: HudMessage | undefined = msgs.filter((x) => x.kind === 'checkpoint').slice(-1)[0];
      const a = last ? msgAlpha(t - last.at, cp.hold) : 0;
      if (last && a > 0) drawText(painter, cp.widget, cp.rect, assets?.string(CHECKPOINT_LABEL) ?? last.text, { alpha: a });
      else if (hudBus.banner) drawText(painter, cp.widget, cp.rect, hudBus.banner);
    }
  };

  const drawHelp = (t: number) => {
    const h = hudBus.help;
    if (h?.text !== lastHelpText) {
      lastHelpText = h?.text ?? null;
      helpAt = t;
    }
    if (!h || !layout.help || !helpEnabled()) return;
    const text = expandHelpText(h.text, currentBindings(ctx.services));
    drawText(painter, layout.help.widget, layout.help.rect, text, { alpha: Math.min(1, (t - helpAt) / 0.25) });
  };

  const drawPrompt = (dead: boolean) => {
    if (dead || !hudBus.prompt) return;
    const w = layout.pickup?.widget ?? layout.help?.widget;
    if (!w) return;
    const p = parsePrompt(hudBus.prompt, currentBindings(ctx.services));
    // The world builds its prompts with the default Use key ("<b>E</b> Open"): show the binding
    // (with a pad: the Use button's glyph).
    const padUse = p.key === 'E' && pads.usingPad ? input.padButton('use') : -1;
    if (padUse >= 0) {
      const gh = 18;
      const gw = padGlyphWidth(padUse, gh, pads.family) + 6;
      const r = drawText(painter, w, { x: VW * 0.2 + gw / 2, y: VH * 0.56, w: VW * 0.6, h: VH * 0.06 }, p.text, { align: 'center', alpha: 0.95 });
      drawPadGlyph(g, pads.family, padUse, r.x - gw, r.y + r.h / 2, gh, 0.95);
      return;
    }
    const key = p.key === 'E' ? input.label('use', 0) || input.label('use') || p.key : p.key;
    const text = key ? `${key} - ${p.text}` : p.text;
    // Centred under the crosshair, in the pickup text's style.
    drawText(painter, w, { x: VW * 0.2, y: VH * 0.56, w: VW * 0.6, h: VH * 0.06 }, text, { align: 'center', alpha: 0.95 });
  };

  // Public API for systems that report HUD events directly (weapons, insanity, save).
  const api: HudService = {
    message: (text, seconds) => postHudMessage('message', text, seconds),
    pickup: (text, seconds) => postHudMessage('pickup', text, seconds),
    checkpoint: () => postHudMessage('checkpoint', 'Checkpoint'),
    help: (text) => void (hudBus.help = text ? { text, at: hudBus.clock } : null),
    damage: () => void (hudBus.damageAt = hudBus.clock),
    notice: (text, template) => {
      const tx = text.replace(/\r\n?/g, '\n').trim();
      notice = tx ? { text: tx, template, at: hudBus.clock } : null;
    },
  };
  ctx.services.hud = api;

  // Placeholder labels for help texts, from the live bindings (services.input.bindings).
  const publishBindings = () => {
    const svc = (ctx.services.input ??= {}) as { bindings?: Record<string, string> };
    svc.bindings = { ...(svc.bindings ?? {}), ...input.labelMap() };
  };
  publishBindings();
  const offBindings = input.onChange(publishBindings);
  // Archive unlocks also travel inside saves (merged back into the profile on load).
  const offSave = registerSave<{ pages: string[] }>(
    ctx.services,
    'archives',
    {
      save: () => ({ pages: profile.unlockedPages() }),
      load: (d) => void profile.unlockPages(Array.isArray(d?.pages) ? d.pages.filter((p) => typeof p === 'string') : []),
    },
    { scope: 'game', priority: 60 },
  );
  let reverting = false;
  const offActions = installActions(ctx, { dead: () => wasDead });
  const offInventory = input.onPress('inventory', () => {
    // Not while the cheat chord is held (Suffering.rfl 0x1004944e reads the cheat state's +0).
    if (!wasDead && !(ctx.services.cheats as { chordHeld?: boolean } | undefined)?.chordHeld) inventory?.toggle(hudBus.clock);
  });
  // Map key: the map screen over the paused game (map.ts data, the menu flow draws it).
  const offMap = input.onPress('map', () => {
    const pkgs = ctx.loaded.packages as EntityPackageSet | undefined;
    if (wasDead || !assets || !pkgs || !view.walking || (ctx.services.world as { inCutscene?: boolean } | undefined)?.inCutscene) return;
    const data = buildMapData(pkgs, assets, ctx.services);
    if (data && uiBridge.map) uiBridge.map(data);
    else if (!data) console.info('[hud] map: no map item for this level');
  });

  // Subtitles of dialogue played outside sequences (phone calls: hudBus.speech, set by
  // src/game/world/interact.ts): the sound's own subtitle string (.sdu +0x24) when the
  // subtitle option is on, in the sequence system's subtitle overlay.
  let subs: SubtitleOverlay | null = null;
  let spoken: unknown = null;
  const updateSpeech = (now: number) => {
    const sp = hudBus.speech;
    if (sp && sp !== spoken) {
      spoken = sp;
      const info = ctx.audio.get(sp.sound) as { subtitle?: { pkg: number; id: number }; duration?: number } | undefined;
      const pkgs = ctx.loaded.packages as EntityPackageSet | undefined;
      const text = info?.subtitle && pkgs ? readXduString(pkgs, info.subtitle) : undefined;
      const on = (window as { __menu?: { settings?: { subtitles?: boolean } } }).__menu?.settings?.subtitles ?? loadSettings().subtitles;
      if (text && on) {
        subs ??= new SubtitleOverlay(container, assets?.font ?? null);
        subs.show(text, now, Math.max(1.5, info?.duration ?? 3));
        console.info(`[hud] subtitle (${sp.sound}): ${text}`);
      }
    }
    subs?.update(now);
  };
  // Death: Use / Fire (after the prompt shows) restores the checkpoint at once.
  const offRevert = input.onPress('*', (a) => {
    if (!wasDead || reverting || hudBus.clock - deadAt < DEATH_PROMPT) return;
    if (a !== 'use' && a !== 'fire' && a !== 'jump') return;
    if (!uiBridge.revert) return;
    reverting = true;
    uiBridge.revert();
  });
  // Debug/test hook, like window.__world / window.__actors.
  Object.assign(window, { __hud: { bus: hudBus, services: ctx.services, model: () => readHudModel(ctx.services, view.flashlight.visible) } });

  // Drawn on its own animation frame (not in update) so the HUD keeps drawing even when a
  // system earlier in the update loop throws; the clock stops while the front end is open.
  let raf = 0;
  let last = performance.now();
  const frontEnd = () => {
    const fe = document.getElementById('frontend');
    return !!fe && !fe.hidden;
  };
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (frontEnd()) return;
    hudBus.clock += dt;
    try {
      const m = readHudModel(ctx.services, view.flashlight.visible);
      const dead = !m.alive || hudBus.dead;
      if (dead && !wasDead) deadAt = hudBus.clock;
      if (!dead) reverting = false;
      wasDead = dead;
      draw(m);
      updateSpeech(hudBus.clock);
    } catch (err) {
      console.warn('[hud] draw failed', err);
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    name: 'hud',
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      offBindings();
      offActions();
      offInventory();
      offMap();
      subs?.dispose();
      icons?.dispose();
      offRevert();
      offSave();
      canvas.remove();
      style.remove();
      resetHudBus();
      if (ctx.services.hud === api) delete ctx.services.hud;
      delete (window as { __hud?: unknown }).__hud;
    },
  };
}

/** services.hud: direct HUD calls for other systems. */
export interface HudService {
  /** Game message list line (UIP 26). */
  message(text: string, seconds?: number): void;
  /** Pickup text (Player p284), e.g. the item name. */
  pickup(text: string, seconds?: number): void;
  /** Checkpoint notice (UIP 28, the game's own label). */
  checkpoint(): void;
  /** Help popup text with <Action> placeholders; null hides it. */
  help(text: string | null): void;
  /** Damage flash. */
  damage(): void;
  /**
   * Timed notice in a Simple Text HUD template (default 5:660, the Archives Trigger style:
   * left-aligned at x 5 %, y 15 %); shown for the template's display seconds (p16).
   */
  notice(text: string, template?: string): void;
}
