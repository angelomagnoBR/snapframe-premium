/**
 * SnapFrame Premium — Foundry VTT v12 / v13
 * Recursos extras para o SnapFrame (módulo "mesa-de-cameras").
 *
 * 1. Destaque de quem fala: moldura brilhante na câmera de quem está falando
 *    e, opcionalmente, escurece quem não está falando.
 */

const MOD = "snapframe-premium";
const BASE = "mesa-de-cameras";
const POLL_MS = 120;     // frequência para checar quem está falando
const HOLD_MS = 450;     // mantém o destaque um pouco depois que a pessoa para de falar
const FADE = 0.18;       // suavidade da transição (0 a 1, maior = mais rápido)

/* -------------------------------------------- */
/*  Quem está falando                           */
/* -------------------------------------------- */

/**
 * Descobre se um usuário está falando agora.
 * Usa o estado de voz do próprio Foundry e, como reserva, a classe "speaking"
 * que o Foundry coloca na câmera do dock padrão.
 */
function isSpeaking(userId, api) {
  try {
    const act = game.webrtc?.settings?.activity?.[userId];
    if (act?.speaking) return true;
  } catch (e) { /* ignora */ }
  const view = api?.dockViewFor?.(userId);
  if (view?.classList?.contains("speaking")) return true;
  const parent = view?.closest?.(".camera-view");
  return !!parent?.classList?.contains("speaking");
}

/* -------------------------------------------- */
/*  Destaque                                    */
/* -------------------------------------------- */

const Highlight = {
  api: null,
  overlay: null,
  frames: new Map(),   // slot.id → { g, dim, level, lastSpoke }
  timer: null,
  tick: null,

  enabled() { return game.settings.get(MOD, "highlight"); },

  color() {
    const raw = String(game.settings.get(MOD, "color") || "#E2B866").replace("#", "");
    const n = parseInt(raw, 16);
    return Number.isFinite(n) ? n : 0xE2B866;
  },

  attach(overlay) {
    this.detach();
    if (!this.enabled() || !overlay?.layer) return;
    this.overlay = overlay;

    for (const d of overlay.slotEls.values()) {
      // Escurecimento: retângulo preto por cima do vídeo, dentro do recorte da área
      const dim = new PIXI.Graphics();
      dim.alpha = 0;
      d.box.children[0]?.addChild?.(dim);   // "content", já recortado pela máscara

      // Moldura: desenhada na borda interna da área, para aparecer pelo buraco do PNG
      const g = new PIXI.Graphics();
      g.alpha = 0;
      d.box.addChild(g);

      this.frames.set(d.slot.id, { d, g, dim, level: 0, lastSpoke: 0 });
    }
    this.layout();

    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.tick = () => this.animate();
    canvas.app.ticker.add(this.tick);
  },

  layout() {
    const color = this.color();
    const lw = Math.max(1, Number(game.settings.get(MOD, "width")) || 6);
    for (const f of this.frames.values()) {
      const { w, h } = f.d;
      if (!w || !h) continue;
      f.g.clear();
      // Brilho suave (camadas mais largas e transparentes) + linha principal
      for (const [mult, a] of [[3, 0.15], [2, 0.3], [1, 1]]) {
        const t = lw * mult;
        f.g.lineStyle(t, color, a, 0.5);
        f.g.drawRect(-w / 2 + t / 2, -h / 2 + t / 2, w - t, h - t);
      }
      f.dim.clear().beginFill(0x000000, 1).drawRect(-w / 2, -h / 2, w, h).endFill();
    }
  },

  poll() {
    const now = Date.now();
    for (const f of this.frames.values()) {
      const userId = f.d.slot.user;
      if (userId && isSpeaking(userId, this.api)) f.lastSpoke = now;
      f.speaking = !!userId && now - f.lastSpoke < HOLD_MS;
    }
  },

  animate() {
    const dimMax = Math.min(0.85, Math.max(0, Number(game.settings.get(MOD, "dim")) || 0));
    const anyone = [...this.frames.values()].some(f => f.speaking);
    for (const f of this.frames.values()) {
      if (f.g.destroyed) continue;
      const target = f.speaking ? 1 : 0;
      f.level += (target - f.level) * FADE;
      if (Math.abs(target - f.level) < 0.01) f.level = target;
      f.g.alpha = f.level;
      // Só escurece os outros quando alguém está falando
      const dimTarget = anyone && f.d.slot.user ? dimMax * (1 - f.level) : 0;
      f.dim.alpha += (dimTarget - f.dim.alpha) * FADE;
    }
  },

  detach() {
    clearInterval(this.timer); this.timer = null;
    if (this.tick) { canvas?.app?.ticker?.remove(this.tick); this.tick = null; }
    for (const f of this.frames.values()) {
      for (const o of [f.g, f.dim]) {
        if (!o.destroyed) { o.parent?.removeChild(o); o.destroy(); }
      }
    }
    this.frames.clear();
    this.overlay = null;
  },

  rebuild() {
    const overlay = this.api?.overlay;
    if (overlay?.layer) this.attach(overlay);
    else this.detach();
  }
};

/* -------------------------------------------- */
/*  Configurações e ganchos                     */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const onChange = () => Highlight.rebuild();
  game.settings.register(MOD, "highlight", {
    name: "SFP.Highlight.Name", hint: "SFP.Highlight.Hint",
    scope: "client", config: true, type: Boolean, default: true, onChange
  });
  game.settings.register(MOD, "color", {
    name: "SFP.Color.Name", hint: "SFP.Color.Hint",
    scope: "world", config: true, type: String, default: "#E2B866", onChange
  });
  game.settings.register(MOD, "width", {
    name: "SFP.Width.Name", hint: "SFP.Width.Hint",
    scope: "world", config: true, type: Number, default: 6,
    range: { min: 2, max: 20, step: 1 }, onChange
  });
  game.settings.register(MOD, "dim", {
    name: "SFP.Dim.Name", hint: "SFP.Dim.Hint",
    scope: "client", config: true, type: Number, default: 0.35,
    range: { min: 0, max: 0.8, step: 0.05 }, onChange
  });
});

Hooks.once("ready", () => {
  if (!game.modules.get(BASE)?.active) {
    if (game.user.isGM) ui.notifications.warn(game.i18n.localize("SFP.Missing"));
    return;
  }
  Highlight.api = game.modules.get(BASE).api ?? null;
  // A mesa pode já ter sido montada antes deste módulo carregar
  Highlight.rebuild();
});

Hooks.on("snapframeBuilt", overlay => {
  Highlight.api ??= game.modules.get(BASE)?.api ?? null;
  Highlight.attach(overlay);
});
Hooks.on("snapframeLayout", () => Highlight.layout());
Hooks.on("snapframeDestroy", () => Highlight.detach());
