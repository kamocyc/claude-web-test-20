import * as THREE from 'three';
import { HazardPhase, MATERIAL_NAMES, Material } from '../core/types.ts';
import type { Cell } from '../core/types.ts';
import {
  BRIDGES,
  COLORS,
  FOUNDATION_NAMES,
  GRACE_SECONDS,
  GRASS_COLOR,
  MAX_ROUTE_LENGTH,
  START_BUDGET,
  SURVEY_COST,
  UNKNOWN_COLOR,
  WORLD,
} from '../core/config.ts';
import type { Game } from '../sim/Game.ts';
import { bridgeCell } from '../sim/bridge.ts';
import { hazardProgress } from '../sim/hazard.ts';
import { cellToWorld } from '../render/Scene.ts';
import { TOOL_DEFS, sameTool } from './tools.ts';
import type { Tool } from './tools.ts';

export interface HudCallbacks {
  onSelect: (tool: Tool) => void;
  onHelp: (open: boolean) => void;
  onToggleGeology: () => void;
  onSlice: (z: number) => void;
  onCommit: () => void;
  onCancel: () => void;
  onFocus: (cell: Cell) => void;
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

export class Hud {
  private root: HTMLElement;
  private el: Record<string, HTMLElement> = {};
  private toolButtons = new Map<string, HTMLButtonElement>();
  private labels: HTMLElement[] = [];
  private toasts: { el: HTMLElement; life: number }[] = [];
  /** 開通バナーは数秒で引っ込める(景色を隠し続けない) */
  private bannerTimer = 0;
  private announcedWin = false;
  private projected = new THREE.Vector3();

  selected: Tool = { kind: 'survey' };

  constructor(root: HTMLElement, private cb: HudCallbacks) {
    this.root = root;
    this.build();
  }

  private div(parent: HTMLElement, cls: string, id?: string): HTMLElement {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (id) d.id = id;
    parent.appendChild(d);
    return d;
  }

  private build(): void {
    // ---- 上部
    const top = this.div(this.root, 'panel', 'topbar');
    const stat = (label: string): HTMLElement => {
      const s = this.div(top, 'stat');
      const b = document.createElement('b');
      const sp = document.createElement('span');
      sp.textContent = label;
      s.append(b, sp);
      return b;
    };
    this.el.budget = stat('予算');
    this.el.time = stat('経過');
    this.el.route = stat(`接続 (上限 ${MAX_ROUTE_LENGTH})`);
    this.el.bores = stat('調査');
    this.div(top, 'spacer');
    const job = this.div(top, '', 'jobbar');
    this.el.jobLabel = this.div(job, '');
    this.el.jobFill = this.div(this.div(job, 'track'), 'fill');

    // ---- 道具
    const tools = this.div(this.root, 'panel', 'tools');
    let group = '';
    for (const def of TOOL_DEFS) {
      if (def.group !== group) {
        group = def.group;
        const h = this.div(tools, 'head');
        h.textContent = group;
      }
      const btn = document.createElement('button');
      btn.className = 'tool';
      btn.innerHTML = `<kbd>${def.key}</kbd><span>${def.label}</span><span class="cost">${def.hint}</span>`;
      btn.addEventListener('click', () => this.select(def.tool));
      tools.appendChild(btn);
      this.toolButtons.set(def.key, btn);
    }

    // ---- 右
    const right = this.div(this.root, 'panel', 'right');
    const helpBtn = document.createElement('button');
    helpBtn.className = 'wide';
    helpBtn.textContent = '遊び方 (H)';
    helpBtn.addEventListener('click', () => this.toggleHelp());
    right.appendChild(helpBtn);

    const geo = document.createElement('button');
    geo.className = 'wide';
    geo.textContent = '地質ビュー (G)';
    geo.addEventListener('click', () => this.cb.onToggleGeology());
    right.appendChild(geo);
    this.el.geoBtn = geo;

    const sliceLabel = document.createElement('label');
    sliceLabel.innerHTML = '<span>断面の位置</span><span></span>';
    right.appendChild(sliceLabel);
    this.el.sliceValue = sliceLabel.lastElementChild as HTMLElement;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(WORLD.SZ - 1);
    slider.value = String(Math.floor(WORLD.SZ / 2));
    slider.addEventListener('input', () => this.cb.onSlice(Number(slider.value)));
    right.appendChild(slider);
    this.el.slider = slider;

    const legend = this.div(right, 'legend');
    legend.innerHTML = [
      ['土 (耐力2 / 支保1)', COLORS[Material.DIRT]],
      ['岩 (耐力3 / 支保0)', COLORS[Material.ROCK]],
      ['軟弱層 (耐力0 / 支保2)', COLORS[Material.WEAK]],
      ['未調査', UNKNOWN_COLOR],
      ['地表', GRASS_COLOR],
    ]
      .map(([t, c]) => `<div><i style="background:${hex(c as number)}"></i>${t}</div>`)
      .join('');
    const note = this.div(right, 'legend');
    note.innerHTML = `<div>地下水位 y=${WORLD.WATER_TABLE_Y} より下は支保レベル +1</div><div>道路として認める経路長は ${MAX_ROUTE_LENGTH} マスまで</div><div>左ドラッグ: 回転 / 右ドラッグ: 平行移動 / Space: 一時停止</div>`;

    // ---- 警告
    const warn = this.div(this.root, 'panel', 'warnings');
    const h4 = document.createElement('h4');
    h4.textContent = '崩壊の予兆';
    warn.appendChild(h4);
    this.el.warnings = warn;
    this.el.warnList = this.div(warn, '');

    // ---- プラン
    const plan = this.div(this.root, 'panel', 'plan');
    this.el.plan = plan;
    plan.innerHTML =
      '<h4></h4><div class="verdict"></div><table><thead><tr><th>支持点</th><th>受持</th><th>荷重</th><th>耐力</th><th>基礎</th></tr></thead><tbody></tbody></table><div class="hint">桁マスをクリック: 橋脚の増減 / Shift+クリック: 基礎の切替</div><div class="row"></div>';
    this.el.planTitle = plan.querySelector('h4') as HTMLElement;
    this.el.planVerdict = plan.querySelector('.verdict') as HTMLElement;
    this.el.planBody = plan.querySelector('tbody') as HTMLElement;
    const row = plan.querySelector('.row') as HTMLElement;
    const commit = document.createElement('button');
    commit.className = 'wide';
    commit.textContent = '確定 (Enter)';
    commit.addEventListener('click', () => this.cb.onCommit());
    const cancel = document.createElement('button');
    cancel.className = 'wide';
    cancel.textContent = '取消 (Esc)';
    cancel.addEventListener('click', () => this.cb.onCancel());
    row.append(commit, cancel);
    this.el.commit = commit;

    // ---- 次の一手
    const objective = this.div(this.root, 'panel', 'objective');
    const tag = document.createElement('b');
    tag.textContent = '次にやること';
    const text = document.createElement('span');
    objective.append(tag, text);
    this.el.objective = objective;
    this.el.objectiveText = text;

    // ---- 遊び方
    this.buildHelp();

    // ---- その他
    this.el.toast = this.div(this.root, '', 'toast');
    this.el.vignette = this.div(this.root, '', 'vignette');
    this.el.banner = this.div(this.root, 'panel', 'banner');

    this.select(this.selected);
  }

  /** 遊び方。初回は開いた状態で始める。 */
  private buildHelp(): void {
    const overlay = this.div(this.root, '', 'help');
    const sheet = this.div(overlay, 'sheet');
    sheet.innerHTML = `
      <h2>谷を渡り、尾根を抜けて、START から GOAL まで道路を通す</h2>
      <div class="lead">
        予算 ¥${START_BUDGET.toLocaleString()}。段差1で歩ける経路が ${MAX_ROUTE_LENGTH} マス以内でつながれば開通。
        地質は最初は分からない。調べるか、勘で掘るかはあなたが決める。
      </div>
      <div class="cols">
        <div>
          <h3>進め方</h3>
          <ol>
            <li>まず地形を見る<small>崖や谷壁は露頭なので、そこだけは掘らなくても地質の色が見える。黄色は軟弱層。</small></li>
            <li>気になる場所にボーリングを打つ (<kbd>1</kbd>)<small>1本 ¥${SURVEY_COST}。その位置の地層が縦一列だけ見えるようになる。<kbd>G</kbd> の地質ビューで確認する。</small></li>
            <li>谷に橋を架ける<small><kbd>Q</kbd>〜<kbd>T</kbd> で橋種を選び、起点 → 終点の順にクリック。支間と荷重を満たす橋脚・基礎が自動で提案される。</small></li>
            <li>尾根を抜ける<small>掘削 (<kbd>2</kbd>) で坑道を掘る。土被りがあるセルは支保 (<kbd>4</kbd>〜<kbd>6</kbd>) が要る。切土なら要らない。</small></li>
            <li>足りない段差は盛土 (<kbd>3</kbd>) と掘削で均す<small>段差2以上は歩けない。</small></li>
          </ol>
          <h3>崩壊は必ず予告される</h3>
          <ul>
            <li>支保が足りないと劣化タイマーが走り、左下に残り秒数が出る</li>
            <li>猶予は ${GRACE_SECONDS} 秒。残り60%で予兆フェーズに入り、砂が落ち画面端が赤くなる</li>
            <li><b>猶予のうちに直せば必ず元に戻る</b> — 支保を上げる / 埋め戻す / 基礎を補強する</li>
            <li>警告の行をクリックすると、その場所にカメラが飛ぶ</li>
          </ul>
        </div>
        <div>
          <h3>操作</h3>
          <table>
            <tr><td>左クリック</td><td>選択中の道具を使う</td></tr>
            <tr><td>左ドラッグ</td><td>視点を回す</td></tr>
            <tr><td>右ドラッグ</td><td>視点を平行移動</td></tr>
            <tr><td>ホイール</td><td>ズーム</td></tr>
            <tr><td><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></td><td>調査 / 掘削 / 盛土</td></tr>
            <tr><td><kbd>4</kbd><kbd>5</kbd><kbd>6</kbd></td><td>木枠 / コンクリート覆工 / 鋼製支保+排水</td></tr>
            <tr><td><kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd><kbd>T</kbd></td><td>木橋 / コンクリート橋 / 鋼橋 / トラス橋 / 吊橋</td></tr>
            <tr><td><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>大型基礎 / 岩着杭 / 撤去</td></tr>
            <tr><td><kbd>G</kbd></td><td>地質ビュー (右のスライダーで断面の位置)</td></tr>
            <tr><td><kbd>Enter</kbd> / <kbd>Esc</kbd></td><td>建設プランの確定 / 取消</td></tr>
            <tr><td><kbd>Space</kbd></td><td>一時停止 (猶予をゆっくり見る)</td></tr>
            <tr><td><kbd>H</kbd></td><td>この画面</td></tr>
          </table>
          <h3>橋を架ける手順</h3>
          <ol>
            <li>橋種を選び、起点の地面をクリック</li>
            <li>対岸の地面をクリック → プランになる</li>
            <li>桁マスをクリックで橋脚を足し引き / Shift+クリックで基礎を切替</li>
            <li>右下の表で <b>荷重 ≤ 耐力</b> を確認して <kbd>Enter</kbd></li>
          </ol>
          <h3>覚える数字は3つだけ</h3>
          <table>
            <tr><td>耐力</td><td>岩3 / 土2 / 軟弱0 (+大型基礎1 / +岩着杭3)</td></tr>
            <tr><td>荷重</td><td>受け持つ桁マス数 ÷ 4 (切り上げ)。<b>荷重 &gt; 耐力 なら沈む</b></td></tr>
            <tr><td>支保レベル</td><td>岩0 / 土1 / 軟弱2。地下水位より下は +1</td></tr>
          </table>
        </div>
      </div>
      <button class="wide close">閉じる (H)</button>
      <button class="x" title="閉じる">×</button>
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.toggleHelp(false);
    });
    for (const b of sheet.querySelectorAll('.close, .x')) {
      b.addEventListener('click', () => this.toggleHelp(false));
    }
    this.el.help = overlay;
    this.toggleHelp(true);
  }

  get helpOpen(): boolean {
    return this.el.help!.classList.contains('show');
  }

  toggleHelp(on?: boolean): void {
    const next = on ?? !this.helpOpen;
    this.el.help!.classList.toggle('show', next);
    this.cb.onHelp(next);
  }

  /**
   * いま何をすればいいかを1行で出す。
   * ツールが多いので、最初の数分で迷わないための道しるべ。
   */
  private nextStep(game: Game): { text: string; tone: '' | 'urgent' | 'done' } {
    if (game.won) return { text: '開通。あとは自由に掘って壊して構わない', tone: 'done' };
    if (game.board.count > 0) {
      const h = game.board.list[0]!;
      return {
        text: `崩壊の予兆 (残り ${h.remaining.toFixed(0)} 秒) — ${h.kind === 'tunnel' ? '支保を上げるか埋め戻す' : '基礎を補強するか、下の空洞を埋め戻す'}`,
        tone: 'urgent',
      };
    }
    if (game.plan) {
      const st = game.planStatus();
      return st?.ok
        ? { text: `Enter で確定 (¥${st.cost.toLocaleString()})。桁マスをクリックすれば橋脚を足し引きできる`, tone: 'done' }
        : { text: `${st?.reason ?? ''} — 桁マスをクリックで橋脚を足す / Shift+クリックで基礎を上げる`, tone: 'urgent' };
    }
    if (game.jobs.length > 0) return { text: `施工中: ${game.currentJob?.label ?? ''}`, tone: '' };
    if (game.survey.boreCount === 0 && game.bridges.bridges.length === 0) {
      return { text: '1 で気になる場所にボーリングを打ち、G で地質ビューを開いてみる (勘で進めてもよい)', tone: '' };
    }
    if (!game.routeReachable) {
      return { text: '谷を渡る手段がない — Q〜T で橋種を選び、起点と終点をクリックする', tone: '' };
    }
    if (!game.routeConnected) {
      return {
        text: `遠回りが長すぎる (経路 ${game.routeLength} / 上限 ${MAX_ROUTE_LENGTH}) — 尾根を掘り抜くか切り開いて近道を作る`,
        tone: '',
      };
    }
    return { text: '開通条件を満たしている。この状態を数秒保てば達成', tone: 'done' };
  }

  select(tool: Tool): void {
    this.selected = tool;
    for (const [key, btn] of this.toolButtons) {
      const def = TOOL_DEFS.find((d) => d.key === key);
      btn.classList.toggle('active', !!def && sameTool(def.tool, tool));
    }
    this.cb.onSelect(tool);
  }

  selectByKey(key: string): boolean {
    const def = TOOL_DEFS.find((d) => d.key === key.toUpperCase());
    if (!def) return false;
    this.select(def.tool);
    return true;
  }

  toast(text: string, kind: 'good' | 'bad' | '' = ''): void {
    const el = document.createElement('div');
    el.className = `toast-item ${kind}`;
    el.textContent = text;
    this.el.toast!.appendChild(el);
    this.toasts.push({ el, life: 2.6 });
    while (this.toasts.length > 3) {
      const old = this.toasts.shift();
      old?.el.remove();
    }
  }

  setGeologyActive(on: boolean): void {
    this.el.geoBtn!.classList.toggle('on', on);
  }

  private label(i: number): HTMLElement {
    let el = this.labels[i];
    if (!el) {
      el = document.createElement('div');
      el.className = 'label';
      this.root.appendChild(el);
      this.labels[i] = el;
    }
    return el;
  }

  /** 橋脚の「荷重 / 耐力」を現地に浮かべる。マス目を数えれば予測できる、を担保する表示。 */
  private updateLabels(game: Game, camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    let i = 0;
    const show = (cell: Cell, text: string, ok: boolean): void => {
      const el = this.label(i++);
      cellToWorld(cell.x, cell.y, cell.z, this.projected);
      this.projected.project(camera);
      const behind = this.projected.z > 1;
      el.style.display = behind ? 'none' : 'block';
      el.style.left = `${((this.projected.x + 1) / 2) * canvas.clientWidth}px`;
      el.style.top = `${((1 - this.projected.y) / 2) * canvas.clientHeight}px`;
      el.textContent = text;
      el.className = `label ${ok ? 'ok' : 'ng'}`;
    };

    const status = game.planStatus();
    if (status && game.plan) {
      for (const l of status.loads) {
        if (l.isAbutment) continue;
        show(bridgeCell(game.plan, l.coord, game.plan.y), `${l.load} / ${l.bearing}`, l.ok);
      }
    } else {
      for (const b of game.bridges.bridges) {
        for (const l of game.bridges.pierLoads(b)) {
          if (l.isAbutment || l.ok) continue;
          const pier = b.piers.find((p) => p.coord === l.coord);
          if (!pier?.alive) continue;
          show({ ...bridgeCell(b, l.coord, b.y), y: pier.baseY + 1 }, `荷重 ${l.load} > 耐力 ${l.bearing}`, false);
        }
      }
    }
    for (let k = i; k < this.labels.length; k++) this.labels[k]!.style.display = 'none';
  }

  update(game: Game, dt: number, geologyView: boolean, sliceZ: number, camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    this.el.budget!.textContent = `¥${Math.round(game.economy.budget).toLocaleString()}`;
    this.el.time!.textContent = `${Math.floor(game.time / 60)}:${String(Math.floor(game.time % 60)).padStart(2, '0')}`;
    // 「行けるけれど道路としては長すぎる」を、行けないのと同じ表示にしない。
    if (game.routeConnected) {
      this.el.route!.textContent = `○ ${game.routeLength}`;
      this.el.route!.style.color = 'var(--ok)';
    } else if (game.routeReachable) {
      this.el.route!.textContent = `△ ${game.routeLength}`;
      this.el.route!.style.color = 'var(--warn)';
    } else {
      this.el.route!.textContent = '✕ 未通';
      this.el.route!.style.color = 'var(--dim)';
    }
    this.el.bores!.textContent = `${game.survey.boreCount} 本`;

    const job = game.currentJob;
    this.el.jobLabel!.textContent = job ? `${job.label}${game.jobs.length > 1 ? `  (+${game.jobs.length - 1})` : ''}` : '作業なし';
    this.el.jobLabel!.style.color = job ? 'var(--text)' : 'var(--dim)';
    this.el.jobFill!.style.width = job ? `${(1 - job.remaining / job.total) * 100}%` : '0%';

    const step = this.nextStep(game);
    this.el.objectiveText!.textContent = step.text;
    this.el.objective!.className = `panel ${step.tone}`;

    this.el.sliceValue!.textContent = `z = ${sliceZ}`;
    (this.el.slider as HTMLInputElement).value = String(sliceZ);
    this.setGeologyActive(geologyView);

    // 警告
    const hazards = game.board.list;
    this.el.warnings!.classList.toggle('show', hazards.length > 0);
    const list = this.el.warnList!;
    list.innerHTML = '';
    for (const h of hazards.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = `warn-row ${h.phase === HazardPhase.OMEN ? 'omen' : ''}`;
      const kind = h.kind === 'tunnel' ? '坑内の緩み' : '橋脚の沈下';
      row.innerHTML =
        `<div class="r1"><span>${kind} (${h.cell.x},${h.cell.y},${h.cell.z})</span><b>${h.remaining.toFixed(1)}s</b></div>` +
        `<div class="r2">${h.reason}</div><div class="track"><div class="fill" style="width:${hazardProgress(h.remaining, h.total) * 100}%"></div></div>`;
      row.addEventListener('click', () => this.cb.onFocus(h.cell));
      list.appendChild(row);
    }

    // プラン
    const status = game.planStatus();
    this.el.plan!.classList.toggle('show', status !== null);
    if (status && game.plan) {
      const spec = BRIDGES[game.plan.type];
      this.el.planTitle!.textContent = `${spec.name}  ${game.plan.a}→${game.plan.b} (支間上限 ${spec.maxSpan})`;
      this.el.planVerdict!.className = `verdict ${status.ok ? 'ok' : 'ng'}`;
      this.el.planVerdict!.textContent = status.ok
        ? `建設可 / ¥${status.cost.toLocaleString()}  区間 ${status.span.spans.join(' · ')}`
        : status.reason;
      this.el.planBody!.innerHTML = status.loads
        .map((l) => {
          const f = game.plan!.foundations[l.coord] ?? 'none';
          return `<tr style="color:${l.ok ? 'inherit' : 'var(--bad)'}"><td>${l.isAbutment ? `橋台 ${l.coord}` : `橋脚 ${l.coord}`}</td><td>${l.carried}</td><td>${l.load}</td><td>${l.isAbutment ? '—' : l.bearing}</td><td>${l.isAbutment ? '—' : FOUNDATION_NAMES[f].replace(/ .*/, '')}</td></tr>`;
        })
        .join('');
      (this.el.commit as HTMLButtonElement).disabled = !status.ok;
      (this.el.commit as HTMLButtonElement).style.opacity = status.ok ? '1' : '0.45';
    }

    // ビネット
    this.el.vignette!.style.opacity = String(Math.min(0.85, game.board.maxProgress ** 2));

    // 勝敗
    if (game.won && !this.announcedWin) {
      this.announcedWin = true;
      this.bannerTimer = 6;
      this.el.banner!.innerHTML = `開通<small>経過 ${Math.floor(game.time)} 秒 / 残予算 ¥${Math.round(game.economy.budget).toLocaleString()} / 調査 ${game.survey.boreCount} 本 / 経路 ${game.routeLength} マス</small>`;
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      this.el.banner!.style.opacity = String(Math.min(1, this.bannerTimer));
    }
    this.el.banner!.classList.toggle('show', this.bannerTimer > 0);

    this.updateLabels(game, camera, canvas);

    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i]!;
      t.life -= dt;
      if (t.life <= 0) {
        t.el.remove();
        this.toasts.splice(i, 1);
      } else if (t.life < 0.5) {
        t.el.style.opacity = String(t.life / 0.5);
      }
    }
  }

  /** 掘ったときに何が出たかを短く伝える。 */
  describeMaterial(m: Material): string {
    return MATERIAL_NAMES[m];
  }
}
