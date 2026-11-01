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

const SOCKET = `module.${MOD}`;
const REMOTE_TTL = 1600;           // sem notícia por esse tempo = parou de falar
const remote = new Map();          // userId → horário da última notícia de "falando"
const foundrySpeaking = new Map(); // userId → horário em que o Foundry disse "falando"

/**
 * Detecção pela voz no microfone do próprio jogador.
 * Funciona mesmo quando a conversa acontece no Discord: o áudio não é enviado
 * para ninguém, só o aviso "estou falando".
 */
const Voice = {
  stream: null, ctx: null, analyser: null, data: null, timer: null, beat: null,
  speaking: false, lastLoud: 0,

  enabled() { return game.settings.get(MOD, "micDetect"); },

  async start() {
    if (this.stream || !this.enabled() || !navigator.mediaDevices?.getUserMedia) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
      });
    } catch (e) {
      this.stream = null;
      ui.notifications.warn(game.i18n.localize("SFP.MicDenied"));
      return;
    }
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.data = new Float32Array(this.analyser.fftSize);
    // O navegador só libera o áudio depois de um clique
    const resume = () => this.ctx?.state === "suspended" && this.ctx.resume();
    document.addEventListener("pointerdown", resume);
    document.addEventListener("keydown", resume);
    resume();
    this.timer = setInterval(() => this.check(), 80);
    // Enquanto fala, repete o aviso para quem entrou depois ou perdeu a mensagem
    this.beat = setInterval(() => { if (this.speaking) this.send(true); }, 700);
  },

  stop() {
    clearInterval(this.timer); clearInterval(this.beat); this.timer = this.beat = null;
    this.stream?.getTracks().forEach(t => t.stop());
    try { this.ctx?.close(); } catch (e) { /* ignora */ }
    this.stream = this.ctx = this.analyser = this.data = null;
    if (this.speaking) { this.speaking = false; this.send(false); }
  },

  check() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / this.data.length) || 1e-8);
    const now = Date.now();
    if (db > Number(game.settings.get(MOD, "micThreshold"))) this.lastLoud = now;
    const speaking = now - this.lastLoud < HOLD_MS;
    if (speaking !== this.speaking) { this.speaking = speaking; this.send(speaking); }
  },

  send(speaking) {
    const now = Date.now();
    if (speaking) remote.set(game.user.id, now); else remote.delete(game.user.id);
    game.socket.emit(SOCKET, { type: "speaking", user: game.user.id, speaking });
  }
};

/** Também escuta o que o próprio Foundry diz sobre quem está falando (voz pelo Foundry). */
function wrapFoundrySpeaking() {
  for (const target of [game.webrtc, ui.webrtc]) {
    const orig = target?.setUserIsSpeaking;
    if (typeof orig !== "function" || orig._sfpWrapped) continue;
    const wrapped = function(userId, speaking, ...rest) {
      if (speaking) foundrySpeaking.set(userId, Date.now()); else foundrySpeaking.delete(userId);
      return orig.call(this, userId, speaking, ...rest);
    };
    wrapped._sfpWrapped = true;
    target.setUserIsSpeaking = wrapped;
  }
}

function isSpeaking(userId, api) {
  const now = Date.now();
  const r = remote.get(userId);
  if (r && now - r < REMOTE_TTL) return true;
  if (foundrySpeaking.has(userId)) return true;
  try {
    if (game.webrtc?.settings?.activity?.[userId]?.speaking) return true;
  } catch (e) { /* ignora */ }
  const view = api?.dockViewFor?.(userId);
  return !!(view?.classList?.contains("speaking") || view?.closest?.(".camera-view")?.classList?.contains("speaking"));
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
      f.speaking = (!!userId && now - f.lastSpoke < HOLD_MS) || (f.forceUntil ?? 0) > now;
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

  /** Acende todas as molduras por alguns segundos, para testar o visual. */
  test(seconds = 4) {
    if (!this.frames.size) return ui.notifications.warn(game.i18n.localize("SFP.NoTable"));
    for (const f of this.frames.values()) f.forceUntil = Date.now() + seconds * 1000;
  },

  rebuild() {
    const overlay = this.api?.overlay;
    if (overlay?.layer) this.attach(overlay);
    else this.detach();
  }
};

/* -------------------------------------------- */
/*  Retrato do personagem no canto              */
/* -------------------------------------------- */

const texCache = new Map();
async function loadTex(src) {
  if (!src) return null;
  if (texCache.has(src)) return texCache.get(src);
  const fn = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
  let tex = null;
  try { tex = await fn(src); } catch (e) { tex = null; }
  texCache.set(src, tex);
  return tex;
}

const Portrait = {
  items: new Map(),   // slot.id → { d, cont, sprite, mask, ring, src }
  timer: null,

  enabled() { return game.settings.get(MOD, "portrait"); },

  attach(overlay) {
    this.detach();
    if (!this.enabled() || !overlay?.layer) return;
    for (const d of overlay.slotEls.values()) {
      const cont = new PIXI.Container();
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0.5);
      const mask = new PIXI.Graphics();
      const ring = new PIXI.Graphics();
      sprite.mask = mask;
      cont.addChild(sprite, mask, ring);
      cont.visible = false;
      // Logo acima do vídeo e abaixo da moldura de destaque
      d.box.addChildAt(cont, Math.min(1, d.box.children.length));
      this.items.set(d.slot.id, { d, cont, sprite, mask, ring, src: null });
    }
    this.layout();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 700);
  },

  layout() {
    const corner = game.settings.get(MOD, "portraitCorner");
    const pct = Number(game.settings.get(MOD, "portraitSize")) || 0.28;
    const color = Highlight.color();
    for (const it of this.items.values()) {
      const { w, h } = it.d;
      if (!w || !h) continue;
      const r = Math.min(w, h) * pct / 2;
      const m = Math.max(6, r * 0.25);
      const x = corner.endsWith("left") ? -w / 2 + m + r : w / 2 - m - r;
      const y = corner.startsWith("top") ? -h / 2 + m + r : h / 2 - m - r;
      it.cont.position.set(x, y);
      it.r = r;
      it.mask.clear().beginFill(0xffffff).drawCircle(0, 0, r).endFill();
      it.ring.clear().lineStyle(Math.max(2, r * 0.08), color, 1, 0.5).drawCircle(0, 0, r);
      this.fit(it);
    }
  },

  fit(it) {
    const tw = it.sprite.texture?.width || 0, th = it.sprite.texture?.height || 0;
    if (!tw || !th || !it.r) return false;
    const s = (it.r * 2) / Math.min(tw, th);
    it.sprite.scale.set(s, s);
    return true;
  },

  refresh() {
    const when = game.settings.get(MOD, "portraitWhen");
    for (const it of this.items.values()) {
      const user = it.d.slot.user ? game.users.get(it.d.slot.user) : null;
      const src = user?.character?.img ?? "";
      const bad = !src || src.includes("mystery-man");
      if (it.src !== src) {
        it.src = src;
        it.ready = false;
        loadTex(bad ? null : src).then(tex => {
          if (it.src !== src || it.sprite.destroyed) return;
          it.sprite.texture = tex ?? PIXI.Texture.EMPTY;
          it.ready = !!tex && this.fit(it);
        });
      }
      const camOk = when === "always" || !!it.d.showing;
      it.cont.visible = !!user && !bad && !!it.ready && camOk;
    }
  },

  detach() {
    clearInterval(this.timer); this.timer = null;
    for (const it of this.items.values()) {
      if (!it.cont.destroyed) { it.cont.parent?.removeChild(it.cont); it.cont.destroy({ children: true }); }
    }
    this.items.clear();
  },

  rebuild() {
    const overlay = Highlight.api?.overlay ?? game.modules.get(BASE)?.api?.overlay;
    if (overlay?.layer) this.attach(overlay);
    else this.detach();
  }
};

/* -------------------------------------------- */
/*  Configurações e ganchos                     */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const onChange = () => { Highlight.rebuild(); Portrait.rebuild(); };
  const onPortrait = () => Portrait.rebuild();
  game.settings.register(MOD, "portrait", {
    name: "SFP.Portrait.Name", hint: "SFP.Portrait.Hint",
    scope: "world", config: true, type: Boolean, default: true, onChange: onPortrait
  });
  game.settings.register(MOD, "portraitCorner", {
    name: "SFP.Corner.Name", hint: "SFP.Corner.Hint",
    scope: "world", config: true, type: String, default: "bottom-right",
    choices: {
      "bottom-right": "SFP.Corner.BR", "bottom-left": "SFP.Corner.BL",
      "top-right": "SFP.Corner.TR", "top-left": "SFP.Corner.TL"
    }, onChange: onPortrait
  });
  game.settings.register(MOD, "portraitSize", {
    name: "SFP.PSize.Name", hint: "SFP.PSize.Hint",
    scope: "world", config: true, type: Number, default: 0.28,
    range: { min: 0.15, max: 0.5, step: 0.01 }, onChange: onPortrait
  });
  game.settings.register(MOD, "portraitWhen", {
    name: "SFP.When.Name", hint: "SFP.When.Hint",
    scope: "world", config: true, type: String, default: "camera",
    choices: { camera: "SFP.When.Camera", always: "SFP.When.Always" }, onChange: onPortrait
  });
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
  game.settings.register(MOD, "micDetect", {
    name: "SFP.MicDetect.Name", hint: "SFP.MicDetect.Hint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: on => on ? Voice.start() : Voice.stop()
  });
  game.settings.register(MOD, "micThreshold", {
    name: "SFP.MicThreshold.Name", hint: "SFP.MicThreshold.Hint",
    scope: "client", config: true, type: Number, default: -50,
    range: { min: -70, max: -20, step: 1 }
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
  game.modules.get(MOD).api = { test: s => Highlight.test(s), voice: Voice };
  wrapFoundrySpeaking();
  game.socket.on(SOCKET, msg => {
    if (msg?.type !== "speaking" || !msg.user) return;
    if (msg.speaking) remote.set(msg.user, Date.now()); else remote.delete(msg.user);
  });
  Voice.start();
  // A mesa pode já ter sido montada antes deste módulo carregar
  Highlight.rebuild();
  Portrait.rebuild();
});

Hooks.on("snapframeBuilt", overlay => {
  Highlight.api ??= game.modules.get(BASE)?.api ?? null;
  Portrait.attach(overlay);
  Highlight.attach(overlay);
});
Hooks.on("snapframeLayout", () => { Highlight.layout(); Portrait.layout(); });
Hooks.on("snapframeDestroy", () => { Highlight.detach(); Portrait.detach(); });
Hooks.on("updateUser", (user, changes) => { if ("character" in changes) Portrait.refresh(); });
