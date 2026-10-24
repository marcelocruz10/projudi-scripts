// ==UserScript==
// @name         Revisão em Sequência - Projudi
// @namespace    tjam.projudi.revisao
// @version      2.4.1
// @description  Revisão de minutas pré-analisadas em sequência, conferência das conclusões com assinatura pendente e comparação do texto de publicação com a minuta (decisões e sentenças).
// @author       Marcelo Cruz de Oliveira
// @match        https://projudi.tjam.jus.br/projudi/*
// @updateURL    https://raw.githubusercontent.com/marcelocruz10/projudi-scripts/main/revisao-sequencia-minutas.user.js
// @downloadURL  https://raw.githubusercontent.com/marcelocruz10/projudi-scripts/main/revisao-sequencia-minutas.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
  Fluxo observado no Projudi (TJAM):
    Lista (despacharAutoConcluso.do / conclusaoJuiz.do) -> [Editar] ou [por assessor] -> preAnalise.do (movimentação)
    -> [Editar] do arquivo = editar(0) -> preAnalise.do (editor, botão Continuar)
    -> Continuar -> prévia em PDF (preAnalise.do) -> Salvar
    -> preAnalise.do (movimentação) -> Postergar Assinatura = assinarDepois()
    -> "Analisar Conclusão" (despacharAutoConclusoForm, assinaturaPostergada=true) -> Salvar
    -> volta à lista, já sem o processo postergado.
    "Assinar Conclusões" (conclusaoJuiz.do, "Conclusões Com Assinatura Pendente"):
      lista com caixas idConclusoes, link [online.html] da minuta e botão Assinar (#assinarButton).

  Novidades da 2.0.0
    - Barra com visual novo, arrastável (posição lembrada) e recolhível.
    - Aparece em toda tela de conclusões; é recolocada se o Projudi a remover.
    - Lista: aceita o link da pré-análise feito pelo assessor ("por ...") e não só o [Editar].
    - Assinatura pendente: conferência em sequência das minutas num visualizador próprio;
      cada minuta conferida tem a caixa marcada para assinatura. O clique em Assinar é sempre seu.
    - Analisar Conclusão: em DECISÃO e SENTENÇA, compara o Texto Publicação (parte dispositiva)
      com o texto da minuta. Se divergir, o salvamento automático é suspenso e as diferenças são exibidas.
      DESPACHO não é publicado e não é comparado.

  2.1.3
    - Analisar Conclusão: o botão "Publicar" marca "Publicar: Sim" e, se a publicação conferir
      com a minuta, segue como "Salvar e próxima". Se divergir, não salva e mostra as diferenças.

  2.2.0
    - Editor: em DECISÃO e SENTENÇA com publicação divergente, botão "Corrigir publicação" (Alt+D)
      substitui o texto da caixa de publicação pela parte dispositiva da minuta e confere de novo.

  2.2.1
    - Editor: a publicação é conferida na entrada e de novo na saída — em "Postergar e próxima",
      no "Continuar" da barra e no "Continuar" do próprio Projudi. Divergindo, pede confirmação.
      O "Adicionar Texto" do Projudi também dispara nova conferência.

  2.2.2
    - Assinatura pendente: minuta em PDF abre no visualizador sem passar pelo pdf.js (só exibição),
      o que eliminava o erro "Array.prototype contains unexpected enumerable properties".
    - Analisar Conclusão: antes de ler o PDF, as extensões do Prototype.js em Array.prototype
      ficam não enumeráveis, para que o pdf.js aceite abrir o documento.

  2.3.0
    - Assinatura pendente: sai "Assinar marcadas"; entram "Marcar todas" e "Só conferidas", que
      ajustam as caixas e levam o cursor à senha do certificado (o Assinar continua sendo do Projudi).
      O fim da conferência em sequência também leva à senha. "Limpar conferência" vira link no rodapé,
      que mostra quantas estão marcadas e quantas foram conferidas; a dica fica ao passar o mouse.

  2.4.0
    - Lista: "Revisar em sequência" só atua com Pessoal = Todas, Pré-Análise = Pré-Analisadas e
      Situação = Concluídas. Se o filtro estiver diferente (ou alterado sem Filtrar), marca os três,
      clica em Filtrar e inicia sozinho na lista filtrada; os demais campos ficam como o usuário escolheu.
      Na volta de cada minuta, se a lista vier sem o filtro, refiltra uma vez; não vindo, encerra.
      Filtro não localizado na tela: a revisão não começa.

  2.4.1
    - Atualização automática pela Tampermonkey (@updateURL), para instalar por link e compartilhar.
    - Parte dispositiva: o fim já não depende do nome de um juiz em particular. Encerra na linha de
      local e data de qualquer comarca ("Parintins/AM, 23 de outubro de 2026"), no cargo (Juiz ou
      Juíza de Direito, com ou sem acento) e no nome que vem logo antes do cargo.
*/

(function () {
  'use strict';

  const KEY = 'rsq_estado_v2';
  const KEY_CONF = 'rsq_conferencia_v1';
  const KEY_POS = 'rsq_posicao_v1';
  const KEY_MIN = 'rsq_recolhida_v1';
  const ATRASO_POSTERGAR_MS = 1500;

  // ---------- armazenamento ----------
  // O Projudi carrega o Prototype.js, que altera a serialização de listas (Array.prototype.toJSON).
  // Para não depender disso, as listas são gravadas como texto separado por "|".
  const paraLista = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v) return [];
    if (v.charAt(0) === '[') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch (e) { return []; } }
    return v.split('|');
  };
  const lerChave = (k, listas) => {
    try {
      const s = JSON.parse(sessionStorage.getItem(k));
      if (!s) return null;
      listas.forEach((c) => { s[c] = paraLista(s[c]); });
      return s;
    } catch (e) { return null; }
  };
  const gravarChave = (k, s) => {
    try {
      const c = {};
      Object.keys(s).forEach((x) => { c[x] = Array.isArray(s[x]) ? s[x].join('|') : s[x]; });
      sessionStorage.setItem(k, JSON.stringify(c));
    } catch (e) {}
  };
  const ler = () => lerChave(KEY, ['vistos', 'marcadas']);
  const gravar = (s) => gravarChave(KEY, s);
  const limpar = () => { try { sessionStorage.removeItem(KEY); } catch (e) {} };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- reconhecimento das telas ----------
  const ehAssinarPendentes = () => !!(document.forms.processoConclusaoForm && $('assinarButton') &&
    document.querySelector('input[type=checkbox][name=idConclusoes]'));
  const ehLista = () => !!document.forms.processoConclusaoForm && !ehAssinarPendentes();
  const ehEditor = () => {
    const b = $('submitButton');
    return !!(b && /Continuar/i.test(b.value || '') && document.forms.preAnaliseForm);
  };
  // Tela da pré-análise com o PDF e os botões Assinar / Postergar Assinatura / Alterar / Descartar / Devolver.
  // O Projudi usa id "editButton" tanto no Postergar quanto no Alterar; por isso a detecção é pelo rótulo.
  const botaoPorRotulo = (re) => [...document.querySelectorAll('input[type=button],input[type=submit],button')]
    .find((b) => re.test((b.value || b.textContent || '').trim()));
  const ehMovimentacao = () => typeof window.assinarDepois === 'function' &&
    !!($('postergarButton') || botaoPorRotulo(/^Postergar Assinatura$/i));
  const ehAnalisar = () => !!(document.forms.despacharAutoConclusoForm && $('salvarButton'));
  const postergadaMarcada = () => {
    const f = document.forms.despacharAutoConclusoForm;
    return !!(f && f.elements.assinaturaPostergada && String(f.elements.assinaturaPostergada.value) === 'true');
  };
  const ehPrevia = () => {
    const b = $('submitButton');
    return !!(b && /Salvar/i.test(b.value || '') && document.forms.preAnaliseForm && !$('postergarButton') &&
      !botaoPorRotulo(/^Postergar Assinatura$/i));
  };

  if (!ehAssinarPendentes() && !ehLista() && !ehEditor() && !ehMovimentacao() && !ehAnalisar() && !ehPrevia()) return;

  // ======================= INTERFACE =======================
  const st = document.createElement('style');
  st.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;600&display=swap');
    #rsq-barra,#rsq-barra *,#rsq-toast,.rsq-modal-fundo,.rsq-modal-fundo *{box-sizing:border-box}
    #rsq-barra{--v:#3d5233;--v2:#4f6843;--sup:#eef1e9;--btn:#ffffff;--cab:#e2e8da;--txt:#1f241c;--mut:#5f665a;--lin:#d5dccb;--bor:#bfc8b3;--sua:#e6ebdf;
      --ok:#2f7d4f;--av:#a76a10;--er:#b42318;--neu:#9a9d92;
      position:fixed;right:16px;bottom:16px;z-index:2147483000;width:318px;max-width:calc(100vw - 24px);background:var(--sup);color:var(--txt);
      font:13px/1.35 "IBM Plex Sans","Segoe UI",system-ui,Arial,sans-serif;border:1px solid var(--bor);border-radius:10px;
      box-shadow:0 1px 2px rgba(30,40,20,.10),0 12px 30px rgba(30,40,20,.22);overflow:hidden;user-select:none;text-align:left}
    #rsq-barra button{font:600 12.5px "IBM Plex Sans","Segoe UI",Arial,sans-serif;cursor:pointer;margin:0;line-height:1.2}
    #rsq-barra button:focus-visible{outline:2px solid #6a8f5a;outline-offset:2px}
    #rsq-barra .rsq-cab{display:flex;align-items:center;gap:8px;padding:9px 8px 8px 12px;cursor:grab;background:var(--cab);border-bottom:1px solid var(--lin);margin-bottom:8px}
    #rsq-barra.arrastando .rsq-cab{cursor:grabbing}
    #rsq-barra .rsq-tit{font:600 11px "IBM Plex Sans",Arial;letter-spacing:1px;text-transform:uppercase;color:var(--v)}
    #rsq-barra .rsq-cnj{margin-left:auto;font:500 12px "IBM Plex Mono",Consolas,monospace;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #rsq-barra .rsq-ic{border:0;background:none;color:var(--mut);padding:2px 6px;border-radius:4px;font:600 15px/1 Arial}
    #rsq-barra .rsq-ic:hover{background:rgba(61,82,51,.10)}
    #rsq-barra .rsq-meta{display:flex;gap:12px;align-items:center;padding:0 12px;font-size:12px;color:var(--mut)}
    #rsq-barra .rsq-meta b{color:var(--txt);font-weight:600;font-variant-numeric:tabular-nums}
    #rsq-barra .rsq-tag{margin-left:auto;font:600 10.5px "IBM Plex Sans",Arial;letter-spacing:.6px;text-transform:uppercase;color:var(--v);background:#d6e0cc;border-radius:4px;padding:1px 6px}
    #rsq-barra .rsq-prog{height:3px;background:var(--lin);margin:8px 12px 0;border-radius:2px;overflow:hidden}
    #rsq-barra .rsq-prog i{display:block;height:100%;background:var(--v2);transition:width .3s}
    #rsq-barra .rsq-corpo{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;padding:10px 12px 12px}
    #rsq-barra .rsq-corpo button{border-radius:7px;padding:7px 6px;display:flex;align-items:center;justify-content:center;gap:6px;
      background:var(--btn);color:var(--txt);border:1px solid var(--bor);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #rsq-barra .rsq-corpo button:hover{background:#f6f8f3}
    #rsq-barra .rsq-corpo button.prim{grid-column:1/-1;background:var(--v);border-color:var(--v);color:#fff;justify-content:space-between;padding:9px 12px}
    #rsq-barra .rsq-corpo button.prim:hover{background:var(--v2)}
    #rsq-barra .rsq-corpo button.larga{grid-column:1/-1}
    #rsq-barra kbd{font:500 10px "IBM Plex Mono",Consolas,monospace;color:var(--mut);border:1px solid var(--bor);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:#f3f5ef}
    #rsq-barra .prim kbd{color:#dfe8d8;border-color:rgba(255,255,255,.35);background:transparent}
    #rsq-barra .rsq-rod{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--lin);background:var(--sua);font-size:12px;min-height:34px}
    #rsq-barra .rsq-status{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
    #rsq-barra .rsq-status span.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    #rsq-barra .rsq-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--neu)}
    #rsq-barra .rsq-dot.ok{background:var(--ok)}#rsq-barra .rsq-dot.aviso{background:var(--av)}#rsq-barra .rsq-dot.erro{background:var(--er)}
    #rsq-barra .rsq-status.erro{color:var(--er);font-weight:600}#rsq-barra .rsq-status.aviso{color:#7a4f0c}
    #rsq-barra .rsq-lnk{border:0;background:none;padding:0;font:600 12px "IBM Plex Sans",Arial;color:var(--mut);text-decoration:none;white-space:nowrap}
    #rsq-barra .rsq-lnk:hover{color:var(--txt);text-decoration:underline}
    #rsq-barra .rsq-lnk.ver{color:var(--er);text-decoration:underline;text-underline-offset:2px}
    #rsq-barra .rsq-lnk.sair{margin-left:auto}
    #rsq-barra.recolhida{width:auto;border-radius:999px;background:var(--v);border-color:var(--v)}
    #rsq-barra.recolhida .rsq-meta,#rsq-barra.recolhida .rsq-prog,#rsq-barra.recolhida .rsq-corpo,#rsq-barra.recolhida .rsq-rod{display:none}
    #rsq-barra.recolhida .rsq-cab{padding:6px 6px 6px 14px;background:none;border:0;margin:0}
    #rsq-barra.recolhida .rsq-tit{color:#fff}#rsq-barra.recolhida .rsq-cnj{color:#dfe8d8;margin-left:4px}
    #rsq-barra.recolhida .rsq-ic{color:#fff}#rsq-barra.recolhida .rsq-ic:hover{background:rgba(255,255,255,.15)}
    #rsq-toast{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483001;background:#fff;color:#1f241c;border:1px solid #d6d2c3;border-left:3px solid #3d5233;
      padding:10px 14px;border-radius:8px;font:13px "IBM Plex Sans","Segoe UI",Arial,sans-serif;box-shadow:0 10px 28px rgba(30,40,20,.18);max-width:80vw;display:flex;align-items:center;gap:12px}
    #rsq-toast button{border:1px solid #d6d2c3;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font:600 12px "IBM Plex Sans",Arial;color:#1f241c}
    .rsq-modal-fundo{position:fixed;inset:0;z-index:2147483002;background:rgba(20,26,16,.45);display:flex;align-items:center;justify-content:center}
    .rsq-modal{background:#fff;color:#1f241c;width:min(1100px,94vw);height:min(88vh,1000px);border-radius:12px;display:flex;flex-direction:column;border:1px solid #d6d2c3;
      box-shadow:0 20px 60px rgba(20,26,16,.35);font:13px "IBM Plex Sans","Segoe UI",Arial,sans-serif;overflow:hidden}
    .rsq-modal .rsq-mcab{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#fff;border-bottom:1px solid #e7e4d8;flex-wrap:wrap}
    .rsq-modal .rsq-mcab b{font:600 13px "IBM Plex Mono",Consolas,monospace}
    .rsq-modal .rsq-mcab .rsq-sub{color:#6b7064;font-size:12px}
    .rsq-modal .rsq-mcab .rsq-esp{flex:1}
    .rsq-modal .rsq-mcab button{font:600 12px "IBM Plex Sans",Arial;border:1px solid #d6d2c3;border-radius:7px;padding:7px 11px;cursor:pointer;background:#fff;color:#1f241c}
    .rsq-modal .rsq-mcab button:hover{background:#f7f6f0}
    .rsq-modal .rsq-mcab button.prim{background:#3d5233;border-color:#3d5233;color:#fff}
    .rsq-modal .rsq-mcab button.perigo{color:#6b7064}
    .rsq-modal .rsq-mcorpo{flex:1;overflow:auto;padding:0;background:#f7f6f0}
    .rsq-modal iframe{width:100%;height:100%;border:0;background:#fff}
    .rsq-dif{padding:16px 20px;font:14px/1.6 Georgia,"Times New Roman",serif;background:#fff;white-space:pre-wrap}
    .rsq-dif del{background:#fdeceb;color:#9b1c10;text-decoration:line-through}
    .rsq-dif ins{background:#eaf4ee;color:#14532d;text-decoration:none}
    .rsq-leg{padding:8px 20px;font:12px "IBM Plex Sans",Arial;background:#f7f6f0;border-bottom:1px solid #e7e4d8;color:#6b7064}
    .rsq-leg del,.rsq-leg ins{padding:0 4px;border-radius:3px}
    .rsq-leg del{background:#fdeceb;color:#9b1c10}.rsq-leg ins{background:#eaf4ee;color:#14532d;text-decoration:none}
    tr.rsq-conferida>td{background:#eaf4ee !important}
    tr.rsq-atual>td{box-shadow:inset 0 2px 0 #4f6843,inset 0 -2px 0 #4f6843}
    textarea.rsq-pub-ok{box-shadow:0 0 0 2px rgba(47,125,79,.55)}
    textarea.rsq-pub-erro{box-shadow:0 0 0 2px rgba(180,35,24,.7)}
    textarea.rsq-pub-aviso{box-shadow:0 0 0 2px rgba(167,106,16,.6)}`;
  document.head.appendChild(st);

  // ---------- posição (arrastar) ----------
  function aplicarPosicao(el) {
    let p = null;
    try { p = JSON.parse(lsGet(KEY_POS)); } catch (e) {}
    if (!p || typeof p.x !== 'number') return;
    const w = el.offsetWidth || 260, h = el.offsetHeight || 60;
    const x = Math.min(Math.max(4, p.x), Math.max(4, window.innerWidth - w - 4));
    const y = Math.min(Math.max(4, p.y), Math.max(4, window.innerHeight - h - 4));
    el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
  }

  function tornarArrastavel(el, alca) {
    let ini = null;
    alca.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('button')) return;
      const r = el.getBoundingClientRect();
      ini = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, id: ev.pointerId };
      el.classList.add('arrastando');
      try { alca.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });
    alca.addEventListener('pointermove', (ev) => {
      if (!ini) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      const x = Math.min(Math.max(4, ev.clientX - ini.dx), window.innerWidth - w - 4);
      const y = Math.min(Math.max(4, ev.clientY - ini.dy), window.innerHeight - h - 4);
      el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    const fim = () => {
      if (!ini) return;
      ini = null; el.classList.remove('arrastando');
      const r = el.getBoundingClientRect();
      lsSet(KEY_POS, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    };
    alca.addEventListener('pointerup', fim);
    alca.addEventListener('pointercancel', fim);
    // Duplo clique na alça devolve a barra ao canto inferior direito.
    alca.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('button')) return;
      lsSet(KEY_POS, '');
      el.style.left = el.style.top = ''; el.style.right = '16px'; el.style.bottom = '16px';
    });
  }
  window.addEventListener('resize', () => { const el = $('rsq-barra'); if (el) aplicarPosicao(el); });

  // ---------- barra (cartão institucional) ----------
  // botoes: [rotulo, acao, classe, dica]. Rótulo "Texto (Alt+X)" vira texto + etiqueta de atalho.
  // info: objeto { proc, pos, total, feitas } durante a revisão, ou texto simples.
  // Botões com classe "perigo" (Encerrar) vão para o rodapé como link discreto.
  let ultimaBarra = null;   // para recolocar a barra se o Projudi a remover
  let tipoAto = '';         // etiqueta do tipo do ato (Sentença, Decisão, Despacho)
  const rotuloTipo = (t) => /SENTEN/i.test(t) ? 'Sentença' : /DECIS/i.test(t) ? 'Decisão' : /DESPACH/i.test(t) ? 'Despacho' : '';
  function definirTipo(t) {
    tipoAto = rotuloTipo(t || '');
    const tg = document.querySelector('#rsq-barra .rsq-tag');
    if (tg) { tg.textContent = tipoAto; tg.hidden = !tipoAto; }
  }
  function barra(botoes, info, extra) {
    ultimaBarra = { botoes, info, extra };
    let el = $('rsq-barra'); if (el) el.remove();
    el = document.createElement('div'); el.id = 'rsq-barra';
    if (lsGet(KEY_MIN) === '1') el.classList.add('recolhida');
    const obj = info && typeof info === 'object' ? info : null;
    const cnj = obj && obj.proc ? obj.proc : '';
    const pos = obj && obj.total ? `${Math.min(obj.pos || 0, obj.total)}/${obj.total}` : '';
    el.innerHTML =
      '<div class="rsq-cab" title="Arraste para mover · duplo clique volta ao canto">' +
        '<span class="rsq-tit">Revisão</span>' +
        `<span class="rsq-cnj" data-curto="${esc(pos)}">${esc(cnj)}</span>` +
        '<button class="rsq-ic rsq-min" title="Recolher ou expandir" aria-label="Recolher ou expandir">–</button></div>' +
      '<div class="rsq-meta"></div>' +
      (obj && obj.total ? `<div class="rsq-prog"><i style="width:${Math.round(100 * Math.min(obj.pos || 0, obj.total) / obj.total)}%"></i></div>` : '') +
      '<div class="rsq-corpo"></div>' +
      '<div class="rsq-rod"><div class="rsq-status"></div></div>';
    const meta = el.querySelector('.rsq-meta');
    if (obj) {
      if (obj.total) meta.insertAdjacentHTML('beforeend', `<span><b>${Math.min(obj.pos || 0, obj.total)}</b> de ${obj.total}</span>`);
      meta.insertAdjacentHTML('beforeend', `<span><b>${obj.feitas || 0}</b> postergada${(obj.feitas || 0) === 1 ? '' : 's'}</span>`);
    } else if (info) meta.insertAdjacentHTML('beforeend', `<span>${esc(info)}</span>`);
    meta.insertAdjacentHTML('beforeend', `<span class="rsq-tag"${tipoAto ? '' : ' hidden'}>${esc(tipoAto)}</span>`);
    if (!meta.textContent.trim() && !tipoAto) meta.hidden = true;

    const corpo = el.querySelector('.rsq-corpo');
    const rod = el.querySelector('.rsq-rod');
    const comuns = botoes.filter((b) => b[2] !== 'perigo');
    comuns.forEach(([rotulo, acao, cls, dica], k) => {
      const m = String(rotulo).match(/^(.*?)\s*\(Alt\+(\w)\)\s*$/);
      const texto = m ? m[1] : rotulo;
      const b = document.createElement('button');
      b.className = (cls === 'prim' || (k === 0 && !comuns.some((x) => x[2] === 'prim'))) ? 'prim' : (cls === 'ok' ? 'larga' : '');
      if (dica) b.title = dica + (m ? ` (Alt+${m[2]})` : '');
      b.innerHTML = `<span>${esc(texto.replace(/^[✔✓▶✍]\s*/, ''))}</span>` + (m ? `<kbd>${b.className === 'prim' ? 'Alt ' : ''}${esc(m[2].toUpperCase())}</kbd>` : '');
      b.addEventListener('click', (e) => { e.preventDefault(); acao(); });
      corpo.appendChild(b);
    });
    // Grade de 6 colunas: secundários ocupam 2 (três por linha); a última linha distribui o espaço restante.
    const sec = [...corpo.children].filter((b) => !b.classList.contains('prim') && !b.classList.contains('larga'));
    const resto = sec.length % 3;
    sec.forEach((b) => { b.style.gridColumn = 'span 2'; });
    if (resto === 1) sec[sec.length - 1].style.gridColumn = 'span 6';
    if (resto === 2) { sec[sec.length - 1].style.gridColumn = 'span 3'; sec[sec.length - 2].style.gridColumn = 'span 3'; }
    if (!comuns.length) corpo.hidden = true;

    if (extra) el.querySelector('.rsq-status').appendChild(extra);
    botoes.filter((b) => b[2] === 'perigo').forEach(([rotulo, acao]) => {
      const a = document.createElement('button'); a.className = 'rsq-lnk sair'; a.textContent = rotulo;
      a.addEventListener('click', (e) => { e.preventDefault(); acao(); });
      rod.appendChild(a);
    });
    if (!extra && !rod.querySelector('.sair')) rod.hidden = true;

    const min = el.querySelector('.rsq-min');
    const ajustarMin = () => {
      const rec = el.classList.contains('recolhida');
      min.textContent = rec ? '+' : '–';
      const c = el.querySelector('.rsq-cnj');
      c.textContent = rec ? (c.dataset.curto || cnj) : cnj;
    };
    min.addEventListener('click', (e) => {
      e.preventDefault();
      const rec = el.classList.toggle('recolhida');
      lsSet(KEY_MIN, rec ? '1' : '0');
      ajustarMin(); aplicarPosicao(el);
    });
    ajustarMin();
    document.body.appendChild(el);
    aplicarPosicao(el);
    tornarArrastavel(el, el.querySelector('.rsq-cab'));
    return el;
  }
  // A barra deve estar sempre presente: se algum script da página a remover, volta.
  new MutationObserver(() => {
    if (ultimaBarra && !$('rsq-barra') && document.body) {
      const u = ultimaBarra; barra(u.botoes, u.info, u.extra);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  const removerBarra = () => { ultimaBarra = null; const b = $('rsq-barra'); if (b) b.remove(); };
  const atualizarExtra = (no) => {
    if (ultimaBarra) ultimaBarra.extra = no;
    const b = $('rsq-barra'); if (!b) return;
    const ex = b.querySelector('.rsq-status'); ex.innerHTML = ''; if (no) ex.appendChild(no);
    const rod = b.querySelector('.rsq-rod'); rod.hidden = !no && !rod.querySelector('.sair');
    aplicarPosicao(b);
  };

  function toast(msg, cancelar, duracao, rotuloCancelar) {
    let t = $('rsq-toast'); if (t) t.remove();
    t = document.createElement('div'); t.id = 'rsq-toast'; const sp = document.createElement('span'); sp.textContent = msg; t.appendChild(sp);
    if (cancelar) {
      const b = document.createElement('button'); b.textContent = rotuloCancelar || 'Cancelar';
      b.onclick = () => { cancelar(); t.remove(); };
      t.appendChild(b);
    }
    document.body.appendChild(t);
    if (duracao) setTimeout(() => t.remove(), duracao);
    return t;
  }

  function atalhos(mapa) {
    const h = (ev) => {
      if (!ev.altKey) return;
      const fn = mapa[(ev.key || '').toLowerCase()];
      if (fn) { ev.preventDefault(); ev.stopPropagation(); fn(); }
    };
    document.addEventListener('keydown', h, true);
    const ligarCK = () => {
      if (!window.CKEDITOR) return;
      Object.values(window.CKEDITOR.instances).forEach((inst) => {
        const pendurar = () => { try { inst.document.$.addEventListener('keydown', h, true); } catch (e) {} };
        if (inst.document) pendurar();
        inst.on('contentDom', pendurar);
      });
    };
    ligarCK(); setTimeout(ligarCK, 1500);
    return h;
  }

  function modal(cab, conteudo) {
    const fundo = document.createElement('div'); fundo.className = 'rsq-modal-fundo';
    const m = document.createElement('div'); m.className = 'rsq-modal';
    const mc = document.createElement('div'); mc.className = 'rsq-mcab';
    const corpo = document.createElement('div'); corpo.className = 'rsq-mcorpo';
    m.appendChild(mc); m.appendChild(corpo); fundo.appendChild(m);
    const fechar = () => { fundo.remove(); document.removeEventListener('keydown', escH, true); };
    const escH = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); fechar(); } };
    document.addEventListener('keydown', escH, true);
    fundo.addEventListener('click', (ev) => { if (ev.target === fundo) fechar(); });
    cab(mc, fechar);
    if (conteudo) corpo.appendChild(conteudo);
    document.body.appendChild(fundo);
    return { fundo, corpo, cab: mc, fechar };
  }
  const botaoM = (rotulo, acao, cls, dica) => {
    const b = document.createElement('button'); b.textContent = rotulo;
    if (cls) b.className = cls; if (dica) b.title = dica;
    b.addEventListener('click', (e) => { e.preventDefault(); acao(); });
    return b;
  };

  const info = (s) => s ? { proc: s.atual || '', pos: (s.vistos || []).length, total: Number(s.total) || 0, feitas: Number(s.feitas) || 0 } : '';

  function encerrar(msg) {
    limpar();
    removerBarra();
    toast(msg || 'Revisão encerrada.', null, 3000);
  }

  function voltarParaLista() {
    const s = ler(); if (s) { s.etapa = 'proxima'; gravar(s); }
    if (typeof window.voltar === 'function') {
      const conf = window.confirm; window.confirm = () => true;
      try { window.voltar(); } finally { setTimeout(() => { window.confirm = conf; }, 500); }
    } else history.back();
  }

  // ======================= MINUTA: leitura e comparação =======================




  // ---------- cache da minuta (gravada no editor, usada na tela Analisar Conclusão) ----------
  const RE_CNJ = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;
  const procDaTela = () => ((document.body.textContent || '').match(RE_CNJ) || [])[0] || '';
  const guardarMinuta = (proc, html) => { if (!proc || !html) return; try { sessionStorage.setItem('rsq_min_' + proc, html); } catch (e) {} };
  const minutaGuardada = (proc) => { try { return proc ? sessionStorage.getItem('rsq_min_' + proc) : null; } catch (e) { return null; } };

  // ---------- minuta em PDF (tela Analisar Conclusão: ícone "Visualizar PDF" = viewArquivo('...')) ----------
  const PDFJS_VER = '3.11.174';
  let pdfjsPromessa = null;
  function carregarScript(src) {
    return new Promise((ok, falha) => {
      const sc = document.createElement('script'); sc.src = src; sc.onload = ok;
      sc.onerror = () => falha(new Error('não carregou ' + src.split('/').pop()));
      (document.head || document.documentElement).appendChild(sc);
    });
  }
  function pdfjs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsPromessa) {
      const base = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/`;
      // O worker carregado na própria página dispensa o Web Worker (evita bloqueio de origem).
      pdfjsPromessa = carregarScript(base + 'pdf.worker.min.js')
        .then(() => carregarScript(base + 'pdf.min.js'))
        .then(() => {
          const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
          if (!lib) throw new Error('pdf.js indisponível');
          lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
          return lib;
        })
        .catch((e) => { pdfjsPromessa = null; throw e; });
    }
    return pdfjsPromessa;
  }
  // O pdf.js recusa-se a abrir documento se Array.prototype tiver propriedades enumeráveis, e o Prototype.js
  // do Projudi acrescenta várias (each, grep, max...). Torná-las não enumeráveis não as remove nem muda o uso.
  function ocultarExtensoesArray() {
    for (const k in []) {
      try { Object.defineProperty(Array.prototype, k, { enumerable: false }); } catch (e) {}
    }
  }
  // Converte o PDF em HTML simples de parágrafos (<p>), removendo cabeçalho/rodapé repetidos em todas as páginas.
  async function htmlDoPdf(buf) {
    const lib = await pdfjs();
    ocultarExtensoesArray();
    const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
    const paginas = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const pg = await pdf.getPage(n);
      const tc = await pg.getTextContent();
      const linhas = [];
      tc.items.forEach((it) => {
        if (!it.str) return;
        const x = it.transform[4], y = Math.round(it.transform[5]);
        let ln = linhas.find((l) => Math.abs(l.y - y) <= 2);
        if (!ln) { ln = { y, x, partes: [] }; linhas.push(ln); }
        ln.x = Math.min(ln.x, x); ln.partes.push({ x, s: it.str });
      });
      linhas.sort((a, b) => b.y - a.y);
      linhas.forEach((l) => { l.t = norm(l.partes.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ')); });
      paginas.push(linhas.filter((l) => l.t));
    }
    // Linhas que se repetem em todas as páginas (cabeçalho/rodapé) ou números de página.
    const conta = {};
    if (paginas.length > 1) paginas.forEach((ls) => new Set(ls.map((l) => l.t)).forEach((t) => { conta[t] = (conta[t] || 0) + 1; }));
    const repetida = (t) => (paginas.length > 1 && conta[t] >= paginas.length) || /^(p[áa]gina\s*)?\d+\s*(de|\/)\s*\d+$/i.test(t);
    const paras = []; let atual = null;
    paginas.forEach((ls) => {
      const corpo = ls.filter((l) => !repetida(l.t));
      if (!corpo.length) return;
      const margem = Math.min(...corpo.map((l) => l.x));
      const gaps = []; for (let k = 1; k < corpo.length; k++) gaps.push(corpo[k - 1].y - corpo[k].y);
      const gapMed = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14;
      corpo.forEach((l, k) => {
        const recuo = l.x > margem + 12;
        const salto = k > 0 && (corpo[k - 1].y - l.y) > gapMed * 1.45;
        if (!atual || recuo || salto) { atual = { t: l.t }; paras.push(atual); }
        else if (/[A-Za-zÀ-ú]-$/.test(atual.t) && /^[a-zà-ú]/.test(l.t)) atual.t = atual.t.slice(0, -1) + l.t;
        else atual.t += ' ' + l.t;
      });
      atual = null;   // parágrafo não atravessa página por padrão
    });
    return paras.map((p) => `<p>${esc(p.t)}</p>`).join('\n');
  }
  // Baixa a minuta (HTML ou PDF). Retorna { html, pdf, blob }. Com semTexto, o PDF não é convertido (só exibição).
  async function baixarMinuta(url, semTexto) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const buf = await r.arrayBuffer();
    const cab = new TextDecoder('latin1').decode(buf.slice(0, 5));
    if (/pdf/.test(ct) || cab === '%PDF-') {
      return { pdf: true, blob: new Blob([buf], { type: 'application/pdf' }), html: semTexto ? '' : await htmlDoPdf(buf.slice(0)) };
    }
    let cs = (ct.match(/charset=([\w-]+)/) || [])[1];
    if (!cs) cs = (new TextDecoder('latin1').decode(buf.slice(0, 2048)).match(/charset=["']?([\w-]+)/i) || [])[1];
    let txt;
    try { txt = new TextDecoder(cs || 'utf-8').decode(buf); } catch (e) { txt = new TextDecoder('utf-8').decode(buf); }
    if (!cs && txt.indexOf('�') >= 0) txt = new TextDecoder('windows-1252').decode(buf);
    return { pdf: false, html: txt };
  }

  function textoDoHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,head,noscript').forEach((n) => n.remove());
    doc.querySelectorAll('p,div,br,li,tr,h1,h2,h3,h4,h5,h6,td,blockquote').forEach((n) => n.appendChild(doc.createTextNode(' ')));
    return (doc.body ? doc.body.textContent : '') || '';
  }

  const norm = (t) => String(t || '')
    .replace(/[   ]/g, ' ').replace(/­/g, '')
    .replace(/[‘’‛´`]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
  const frouxo = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]/g, '');

  // Diferença palavra a palavra (LCS). A = publicação, B = trecho da minuta.
  function diferenca(A, B, igual) {
    const n = A.length, m = B.length;
    const L = []; for (let i = 0; i <= n; i++) L.push(new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i][j] = igual(A[i], B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (igual(A[i], B[j])) { out.push(['=', A[i]]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { out.push(['-', A[i]]); i++; }
      else { out.push(['+', B[j]]); j++; }
    }
    while (i < n) out.push(['-', A[i++]]);
    while (j < m) out.push(['+', B[j++]]);
    // O trecho da minuta tem folga antes e depois; o que sobra nas pontas não é divergência.
    while (out.length && out[0][0] === '+') out.shift();
    while (out.length && out[out.length - 1][0] === '+') out.pop();
    return out;
  }

  // Compara a publicação com a minuta. Retorna {estado, titulo, detalhe, dif}
  function comparar(pub, minuta) {
    const P = norm(pub), M = norm(minuta);
    if (!P) return { estado: 'erro', titulo: 'Texto de publicação vazio', detalhe: 'Decisão/sentença sem a parte dispositiva na caixa de publicação.' };
    if (!M) return { estado: 'aviso', titulo: 'Minuta sem texto legível', detalhe: 'Não foi possível extrair o texto da minuta.' };
    if (M.indexOf(P) >= 0) return { estado: 'ok', titulo: 'Publicação idêntica à minuta', detalhe: 'O texto da caixa de publicação consta, sem alteração, no texto da minuta.' };

    const Pw = P.split(' '), Mw = M.split(' ');
    const Pf = Pw.map(frouxo), Mf = Mw.map(frouxo);
    const Pfj = Pf.filter(Boolean).join(' '), Mfj = Mf.filter(Boolean).join(' ');
    const soForma = Pfj && Mfj.indexOf(Pfj) >= 0;

    // Localiza na minuta o trecho correspondente (âncora de 6 palavras), senão usa o final (dispositivo).
    const K = 6; let inicio = -1;
    const seq = (a, i) => a.slice(i, i + K).join(' ');
    const Mjoin = Mf.map((x, i) => i).filter((i) => Mf[i]);
    const Mcomp = Mjoin.map((i) => Mf[i]);
    const Pcomp = Pf.filter(Boolean);
    for (let i = 0; i + K <= Pcomp.length && i < 40 && inicio < 0; i++) {
      const alvo = seq(Pcomp, i);
      for (let j = 0; j + K <= Mcomp.length; j++) {
        if (Mcomp[j] === Pcomp[i] && seq(Mcomp, j) === alvo) { inicio = Math.max(0, j - i); break; }
      }
    }
    let ini, fim;
    if (inicio >= 0) { ini = Mjoin[inicio] || 0; fim = Math.min(Mw.length, ini + Pw.length + 40); ini = Math.max(0, ini - 5); }
    else { fim = Mw.length; ini = Math.max(0, fim - Math.round(Pw.length * 1.4) - 20); }
    const A = Pw.slice(0, 1800), B = Mw.slice(ini, fim).slice(0, 2500);
    const dif = diferenca(A, B, soForma ? (x, y) => frouxo(x) === frouxo(y) : (x, y) => x === y);
    const divergentes = dif.filter((d) => d[0] !== '=').length;

    if (soForma) {
      const difLit = diferenca(A, B, (x, y) => x === y);
      return { estado: 'aviso', titulo: 'Só pontuação ou acentos',
        detalhe: 'As palavras coincidem, mas há diferenças de forma.', dif: difLit };
    }
    return { estado: 'erro', titulo: 'Publicação divergente',
      detalhe: inicio >= 0 ? `${divergentes} palavra(s) diferente(s) no trecho correspondente.` : 'O trecho da publicação não foi localizado na minuta; comparado com o final da minuta.',
      dif };
  }

  function mostrarDiferencas(res) {
    const leg = document.createElement('div'); leg.className = 'rsq-leg';
    leg.innerHTML = '<del>vermelho riscado</del> só na caixa de publicação &nbsp;·&nbsp; <ins>verde</ins> só na minuta';
    const d = document.createElement('div'); d.className = 'rsq-dif';
    d.innerHTML = (res.dif || []).map(([op, w]) => op === '=' ? esc(w) : op === '-' ? `<del>${esc(w)}</del>` : `<ins>${esc(w)}</ins>`).join(' ');
    const wrap = document.createElement('div'); wrap.appendChild(leg); wrap.appendChild(d);
    modal((mc, fechar) => {
      const t = document.createElement('b'); t.textContent = res.titulo; mc.appendChild(t);
      const s = document.createElement('span'); s.className = 'rsq-sub'; s.textContent = res.detalhe || ''; mc.appendChild(s);
      const e = document.createElement('span'); e.className = 'rsq-esp'; mc.appendChild(e);
      mc.appendChild(botaoM('Fechar (Esc)', fechar));
    }, wrap);
  }

  // Linha de status do rodapé: ponto de cor + texto + link opcional.
  function chip(estado, texto, rotuloBotao, acaoBotao) {
    const c = document.createElement('div'); c.className = 'rsq-status ' + estado;
    c.style.cssText = 'padding:0;border:0;background:none';
    c.innerHTML = `<span class="rsq-dot ${esc(estado)}"></span><span class="t" title="${esc(texto)}">${esc(texto)}</span>`;
    if (rotuloBotao) {
      const b = document.createElement('button'); b.className = 'rsq-lnk ver'; b.textContent = rotuloBotao;
      b.addEventListener('click', (e) => { e.preventDefault(); acaoBotao(); });
      c.appendChild(b);
    }
    return c;
  }

  // ---------- leitura da tela Analisar Conclusão ----------
  function tipoDoAto() {
    const f = document.forms.despacharAutoConclusoForm;
    const sel = f ? [...f.querySelectorAll('select')] : [];
    for (const s of sel) {
      const t = s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : '';
      if (/SENTEN|DECIS|DESPACH/i.test(t)) return t.toUpperCase();
    }
    return '';
  }
  const ehDespacho = (t) => /DESPACH/.test(t);
  const publicaAto = (t) => /SENTEN|DECIS/.test(t);

  function caixaPublicacao() {
    const f = document.forms.despacharAutoConclusoForm;
    if (!f) return null;
    const tas = [...f.querySelectorAll('textarea')];
    return tas.find((t) => /public/i.test(t.name || t.id || '')) || tas.sort((a, b) => (b.value || '').length - (a.value || '').length)[0] || null;
  }
  function publicarSim() {
    const f = document.forms.despacharAutoConclusoForm;
    const r = f ? [...f.querySelectorAll('input[type=radio]')].filter((x) => /public/i.test(x.name)) : [];
    if (!r.length) return null;
    const m = r.find((x) => x.checked);
    if (!m) return null;
    return /^(s|sim|true|1)$/i.test(m.value) || /sim/i.test((m.nextSibling && m.nextSibling.textContent) || '');
  }
  // Despacho não é publicado: marca "Publicar: Não" (o clique aciona o script do Projudi que desabilita a caixa).
  function marcarNaoPublicar() {
    const f = document.forms.despacharAutoConclusoForm;
    const r = f ? [...f.querySelectorAll('input[type=radio]')].filter((x) => /public/i.test(x.name)) : [];
    const rotulo = (x) => ((x.nextSibling && x.nextSibling.textContent) || (x.parentNode && x.parentNode.textContent) || '').trim();
    const nao = r.find((x) => /^(n|nao|não|false|0)$/i.test(x.value)) || r.find((x) => /^n[aã]o\b/i.test(rotulo(x)));
    if (!nao) return false;
    if (!nao.checked) nao.click();
    if (!nao.checked) { nao.checked = true; nao.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  }
  // Nível de sigilo do processo, como exibido no cabeçalho ("Nível de Sigilo: Público").
  function nivelSigilo() {
    const m = (document.body.textContent || '').replace(/\s+/g, ' ').match(/N[íi]vel de Sigilo:\s*([A-Za-zÀ-ú]+(?: de [A-Za-zÀ-ú]+)?)/);
    return m ? m[1].trim() : '';
  }
  function marcarSimPublicar() {
    const f = document.forms.despacharAutoConclusoForm;
    const r = f ? [...f.querySelectorAll('input[type=radio]')].filter((x) => /public/i.test(x.name)) : [];
    const sim = r.find((x) => /^(s|sim|true|1)$/i.test(x.value));
    if (!sim) return false;
    if (!sim.checked) sim.click();
    if (!sim.checked) { sim.checked = true; sim.dispatchEvent(new Event('change', { bubbles: true })); }
    const ta = caixaPublicacao(); if (ta && ta.disabled) ta.disabled = false;
    return publicarSim() === true;
  }
  const temErroProjudi = () => /Alguns erros foram encontrados/i.test(document.body.textContent || '');

  // URL da minuta: link "online.html" (lista de assinatura) ou ícone "Visualizar PDF" com viewArquivo('...').
  function urlMinuta(raiz) {
    const r = raiz || document;
    const as = [...r.querySelectorAll('a')];
    const a = as.find((x) => /\.html?\s*\]?\s*$/i.test(x.textContent.trim()) && /preAnalise\.do|\.html?/i.test(x.getAttribute('href') || '')) ||
      as.find((x) => /\.html?\s*\]?\s*$/i.test(x.textContent.trim()) && (x.getAttribute('href') || '#') !== '#');
    if (a) return a.href;
    for (const el of r.querySelectorAll('[onclick*="viewArquivo"]')) {
      const m = (el.getAttribute('onclick') || '').match(/viewArquivo\(\s*['"]([^'"]+)['"]/);
      if (m) return new URL(m[1], location.href).href;
    }
    return null;
  }

  // Executa a conferência na tela Analisar Conclusão. Retorna o resultado ({estado,...}) ou null se não se aplica.
  async function conferirPublicacao() {
    const tipo = tipoDoAto(); definirTipo(tipo);
    const ta = caixaPublicacao();
    if (ta) ta.classList.remove('rsq-pub-ok', 'rsq-pub-erro', 'rsq-pub-aviso');
    if (ehDespacho(tipo)) {
      const ok = publicarSim() === false || marcarNaoPublicar();
      return ok ? { estado: 'neutro', titulo: 'Despacho: "Publicar" marcado como Não' }
        : { estado: 'aviso', titulo: 'Despacho: não consegui marcar "Publicar: Não"' };
    }
    if (!publicaAto(tipo)) return { estado: 'neutro', titulo: 'Tipo do ato não identificado: comparação não feita' };
    if (!ta) return { estado: 'aviso', titulo: 'Caixa de publicação não encontrada' };
    if (publicarSim() === false) {
      // Decisão/sentença com "Publicar: Não": marca Sim somente se houver texto na caixa e o processo for público.
      if (!ta.value.trim()) return { estado: 'aviso', titulo: 'Marcada para NÃO publicar e sem texto de publicação' };
      const sig = nivelSigilo();
      if (!sig) return { estado: 'aviso', titulo: 'Marcada para NÃO publicar; nível de sigilo não identificado' };
      if (!/^p[úu]blico/i.test(sig)) return { estado: 'aviso', titulo: `Processo com sigilo (${sig}): mantido "Publicar: Não"` };
      // Processo público com texto: oferece o botão "Publicar" no painel (decisão do magistrado).
      return { estado: 'aviso', titulo: 'Marcada para NÃO publicar', publicar: true };
    }
    let res;
    try {
      // 1º: texto guardado quando a minuta passou pelo editor; 2º: o arquivo da tela (HTML ou PDF).
      let html = minutaGuardada(procDaTela());
      if (!html) {
        const url = urlMinuta();
        if (!url) return { estado: 'aviso', titulo: 'Minuta não disponível: abra-a pelo editor (Alterar) para conferir' };
        html = (await baixarMinuta(url)).html;
      }
      const preencheu = preencherDispositivo(ta, html);
      res = comparar(ta.value, textoDoHtml(html));
      if (preencheu && res.estado === 'ok') res.titulo = 'Dispositivo incluído na publicação (confira)';
    }
    catch (e) { return { estado: 'aviso', titulo: 'Não foi possível ler a minuta (' + e.message + ')' }; }
    ta.classList.add(res.estado === 'ok' ? 'rsq-pub-ok' : res.estado === 'erro' ? 'rsq-pub-erro' : 'rsq-pub-aviso');
    return res;
  }
  // ---------- extração da parte dispositiva ----------
  // Parágrafos do corpo da minuta, em ordem (blocos sem outros blocos dentro).
  function paragrafos(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style').forEach((n) => n.remove());
    const blocos = [...doc.body.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,td,blockquote')]
      .filter((el) => !el.querySelector('p,div,li,h1,h2,h3,h4,h5,h6,td,blockquote,table'));
    return blocos.map((el) => norm(el.textContent)).filter(Boolean);
  }
  const RE_TITULO_DISP = /^(?:[IVXL]+\s*[-–.)]\s*)?(?:DO\s+|DA\s+)?DISPOSITIVO\s*:?$/i;
  const RE_INICIO_DISP = /^(ANTE O EXPOSTO|DIANTE DO EXPOSTO|PELO EXPOSTO|POR TODO O EXPOSTO|EM FACE DO EXPOSTO|ANTE O QUE FOI EXPOSTO|DIANTE DO QUE FOI EXPOSTO|DO EXPOSTO|POSTO ISSO|ISTO POSTO|ISSO POSTO|EX POSITIS|COM ESTES FUNDAMENTOS|COM ESSES FUNDAMENTOS|NESSES TERMOS|NESTES TERMOS|DIANTE DISSO|ANTE O EXPENDIDO|PELO EXPENDIDO|ASSIM SENDO|ANTE O QUADRO)\b/i;
  const RE_FIM_DISP = /^(MANAUS\b|.*DATA DA ASSINATURA ELETR|\(?ASSINADO ELETRONICAMENTE\)?$|JU[IÍ]Z(A)? DE DIREITO\b|[A-Za-zÀ-ú' \/-]{2,40},\s*\d{1,2}º?\s+DE\s+[A-Za-zç]+\s+DE\s+\d{4})/i;
  const RE_CARGO = /^JU[IÍ]Z(A)? DE DIREITO\b/i;
  // Linha curta, sem pontuação final, logo antes do cargo: é o nome de quem assina, seja quem for.
  const ehNomeDeQuemAssina = (p, prox) => prox != null && RE_CARGO.test(prox) && p.split(/\s+/).length <= 8 && !/[.;:]$/.test(p);
  function extrairDispositivo(html) {
    const ps = paragrafos(html);
    let ini = -1;
    for (let i = ps.length - 1; i >= 0; i--) if (RE_TITULO_DISP.test(ps[i])) { ini = i + 1; break; }
    if (ini < 0) for (let i = ps.length - 1; i >= 0; i--) if (RE_INICIO_DISP.test(ps[i])) { ini = i; break; }
    if (ini < 0 || ini >= ps.length) return '';
    const out = [];
    for (let i = ini; i < ps.length; i++) { if (RE_FIM_DISP.test(ps[i]) || ehNomeDeQuemAssina(ps[i], ps[i + 1])) break; out.push(ps[i]); }
    return out.join('\n\n');
  }
  // Preenche a caixa vazia com o dispositivo. Retorna true se preencheu.
  function preencherDispositivo(ta, html) {
    if (!ta || ta.disabled || ta.value.trim()) return false;
    const d = extrairDispositivo(html);
    if (!d) return false;
    ta.value = d;
    ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
    toast('Caixa de publicação preenchida com a parte dispositiva. Confira.', null, 3500);
    return true;
  }
  const chipResultado = (res) => res ? chip(res.estado, res.titulo, res.dif ? 'Ver' : null, () => mostrarDiferencas(res)) : null;

  // ======================= LISTA DE CONCLUSÕES =======================
  if (ehLista()) {
    const linkPreAnalise = (tr) => {
      const as = [...tr.querySelectorAll('a')].filter((x) => /preAnalise\.do/.test(x.getAttribute('href') || ''));
      return as.find((x) => x.textContent.trim() === 'Editar') || as.find((x) => /^por\b/i.test(x.textContent.trim())) || as[0] || null;
    };
    const linhasDisponiveis = (s) => {
      const vistos = new Set((s && s.vistos) || []);
      return [...document.querySelectorAll('input[type=checkbox][name=listaConclusoesSelect]')].map((cb) => {
        const tr = cb.closest('tr');
        const procA = [...tr.querySelectorAll('a')].find((x) => /^\d{7}-\d{2}\.\d{4}/.test(x.textContent.trim()));
        const ed = linkPreAnalise(tr);
        const bloq = [...tr.querySelectorAll('img')].some((i) => /Bloqueado por/i.test((i.title || '') + (i.alt || '')));
        return { proc: procA ? procA.textContent.trim() : null, href: ed ? ed.href : null, bloq, marcado: cb.checked };
      }).filter((l) => l.proc && l.href && !l.bloq && !vistos.has(l.proc));
    };

    const abrirProxima = (s) => {
      let linhas = linhasDisponiveis(s);
      if (s.soMarcadas) linhas = linhas.filter((l) => s.marcadas.includes(l.proc));
      if (!linhas.length) { encerrar(`Revisão concluída: ${s.feitas} minuta(s) postergada(s).`); return; }
      const l = linhas[0];
      s.atual = l.proc; s.vistos.push(l.proc); s.etapa = 'abrir'; s.retry = 0; s.urlLista = window.location.href;
      gravar(s);
      window.location.href = l.href;
    };

    // ---- Filtro obrigatório da revisão: Pessoal = Todas, Pré-Análise = Pré-Analisadas, Situação = Concluídas ----
    // Os demais campos (tipo, agrupador, localizador, parte, assessor, data) ficam como o usuário escolheu.
    // Rádio pelo nome e valor colhidos da tela (MCP do Projudi, 13/09/2026); senão, pelo rótulo da linha e da opção.
    const textoApos = (x) => {
      const l = x.id && document.querySelector(`label[for="${x.id}"]`);
      if (l) return norm(l.textContent);
      let n = x.nextSibling; while (n && !norm(n.textContent)) n = n.nextSibling;
      return n ? norm(n.textContent) : '';
    };
    const rotuloLinha = (x) => { const tr = x.closest('tr'); const c = tr && tr.querySelector('td,th'); return c ? norm(c.textContent) : ''; };
    const radioFiltro = (nome, valor, linha, opcao) => {
      const rs = [...document.querySelectorAll('input[type=radio]')];
      return rs.find((x) => nome && x.name === nome && x.value === valor) ||
        rs.find((x) => linha.test(rotuloLinha(x)) && opcao.test(textoApos(x))) || null;
    };
    const FILTRO = [
      ['Pessoal: Todas', () => radioFiltro(null, null, /^Pessoal:?$/i, /^Todas$/i)],
      ['Pré-Análise: Pré-Analisadas', () => radioFiltro('preAnalisada', 'true', /^Pr[ée]-An[áa]lise:?$/i, /^Pr[ée]-Analisadas$/i)],
      ['Situação: Concluídas', () => radioFiltro('situacao', 'concluidas', /^Situa[çc][ãa]o:?$/i, /^Conclu[íi]das$/i)],
    ];
    const filtroCerto = () => FILTRO.every(([, r]) => { const x = r(); return !!(x && x.checked); });
    // Campo do filtro alterado depois de carregada a página: a lista exibida já não corresponde a ele.
    let filtroAlterado = false;
    document.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t && t.form && t.name !== 'listaConclusoesSelect' && !/^rsq/.test(t.id || '')) { filtroAlterado = true; atualizarExtra(chipFiltro()); }
    }, true);
    const chipFiltro = () => filtroCerto() && !filtroAlterado
      ? chip('ok', 'Filtro: Pessoal Todas · Pré-Analisadas · Concluídas')
      : chip('aviso', 'Ao iniciar, filtra por Pessoal Todas · Pré-Analisadas · Concluídas');
    // Marca os três rádios e clica em Filtrar; a revisão retoma quando a lista voltar. Retorna false se não deu.
    const aplicarFiltro = (s) => {
      const faltam = FILTRO.filter(([, r]) => !r()).map(([n]) => n);
      if (faltam.length) { toast('Revisão não iniciada: filtro não localizado nesta tela (' + faltam.join(', ') + ').', null, 6000); return false; }
      const b = botaoPorRotulo(/^Filtrar$/i);
      if (!b) { toast('Revisão não iniciada: botão Filtrar não encontrado.', null, 5000); return false; }
      // Em ordem: marcar Pré-Analisadas é o que habilita os rádios de Situação.
      FILTRO.forEach(([, r]) => { const x = r(); if (!x.checked) x.click(); if (!x.checked) x.checked = true; if (x.disabled) x.disabled = false; });
      s.etapa = 'filtrar'; s.filtrou = (Number(s.filtrou) || 0) + 1;
      gravar(s);
      b.click();
      return true;
    };

    const s0 = ler();
    if (s0 && (s0.etapa === 'proxima' || s0.etapa === 'filtrar')) {
      if (filtroCerto()) {
        if (s0.etapa === 'filtrar') toast('Filtro aplicado: Pessoal Todas · Pré-Analisadas · Concluídas.', null, 2500);
        s0.filtrou = 0;
        if (!Number(s0.total)) s0.total = linhasDisponiveis(s0).length;
        abrirProxima(s0);
        return;
      }
      // A lista voltou sem o filtro: refiltra uma vez; se ainda assim não vier, encerra.
      if (Number(s0.filtrou) >= 1) { encerrar('Revisão interrompida: não consegui aplicar o filtro Pessoal Todas · Pré-Analisadas · Concluídas.'); return; }
      if (!aplicarFiltro(s0)) limpar();
      return;
    }

    const iniciar = () => {
      if (!filtroCerto() || filtroAlterado) {
        // Ao refiltrar, a marcação das linhas se perde: a revisão percorre a lista filtrada inteira.
        aplicarFiltro({ etapa: 'filtrar', vistos: [], feitas: 0, atual: null, soMarcadas: false, marcadas: [], total: 0 });
        return;
      }
      const marcadas = linhasDisponiveis(null).filter((l) => l.marcado).map((l) => l.proc);
      const total = marcadas.length || linhasDisponiveis(null).length;
      const s = { etapa: 'proxima', vistos: [], feitas: 0, atual: null, soMarcadas: marcadas.length > 0, marcadas, total };
      abrirProxima(s);
    };

    const disp = linhasDisponiveis(null).length;
    const botoes = [['▶ Revisar em sequência', iniciar, 'prim',
      'Filtra por Pessoal Todas, Pré-Analisadas e Concluídas (os demais campos como estiverem) e abre a minuta da primeira linha livre. Se houver linhas marcadas e o filtro já estiver certo, percorre só as marcadas.']];
    if (s0) botoes.push(['Encerrar revisão', () => encerrar(), 'perigo']);
    barra(botoes, s0 ? info(s0) : `${disp} minuta${disp === 1 ? '' : 's'} disponíve${disp === 1 ? 'l' : 'is'} nesta página`, chipFiltro());
    return;
  }

  // ======================= ASSINATURA PENDENTE (conferência) =======================
  if (ehAssinarPendentes()) {
    const conf = lerChave(KEY_CONF, ['ok', 'pul']) || { ok: [], pul: [] };
    const salvarConf = () => gravarChave(KEY_CONF, conf);

    const linhas = () => [...document.querySelectorAll('input[type=checkbox][name=idConclusoes]')].map((cb) => {
      const tr = cb.closest('tr');
      const procA = [...tr.querySelectorAll('a')].find((x) => /^\d{7}-\d{2}\.\d{4}/.test(x.textContent.trim()));
      const cel = [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim());
      return { cb, tr, proc: procA ? procA.textContent.trim() : '', procHref: procA ? procA.href : null,
        min: urlMinuta(tr), tipo: cel[3] || '', partes: (cel[5] || '').slice(0, 140) };
    }).filter((l) => l.proc);

    const pintar = () => linhas().forEach((l) => {
      const ok = conf.ok.includes(l.proc);
      l.tr.classList.toggle('rsq-conferida', ok);
      if (ok && !l.cb.checked) l.cb.click();
    });

    // Rodapé: quantas estão marcadas e quantas foram conferidas, atualizado a cada clique nas caixas.
    const contagem = () => {
      const ls = linhas();
      const marc = ls.filter((l) => l.cb.checked).length;
      const ok = ls.filter((l) => conf.ok.includes(l.proc)).length;
      const c = chip(marc && marc > ok ? 'aviso' : ok ? 'ok' : 'neutro',
        `${marc} marcada${marc === 1 ? '' : 's'} · ${ok} conferida${ok === 1 ? '' : 's'}`);
      c.title = 'Dica: use 50 ou 100 por página para conferir o lote inteiro de uma vez.';
      return c;
    };
    const atualizarContagem = () => atualizarExtra(contagem());
    document.addEventListener('change', (ev) => {
      if (ev.target && ev.target.name === 'idConclusoes') atualizarContagem();
    });

    // Depois de escolher as caixas, o cursor vai para a senha do certificado; o Assinar é do Projudi.
    const irParaSenha = () => {
      const pw = document.querySelector('input[type=password]');
      if (!pw) { const b = $('assinarButton'); if (b) b.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      pw.scrollIntoView({ block: 'center', behavior: 'smooth' });
      pw.focus(); pw.select();
    };
    const marcarTodas = () => {
      linhas().forEach((l) => { if (!l.cb.checked) l.cb.click(); });
      atualizarContagem(); irParaSenha();
    };
    const soConferidas = () => {
      const ls = linhas();
      if (!ls.some((l) => conf.ok.includes(l.proc))) { toast('Nenhuma minuta conferida nesta página.', null, 2500); return; }
      ls.forEach((l) => { if (l.cb.checked !== conf.ok.includes(l.proc)) l.cb.click(); });
      atualizarContagem(); irParaSenha();
    };
    const limparConferencia = () => {
      conf.ok = []; conf.pul = []; salvarConf();
      linhas().forEach((l) => { l.tr.classList.remove('rsq-conferida'); if (l.cb.checked) l.cb.click(); });
      montarBarra();
    };

    const montarBarra = () => {
      const n = linhas().length;
      barra([
        ['▶ Conferir em sequência', () => conferir(null), 'prim', 'Abre as minutas uma a uma; cada conferida tem a caixa marcada para assinatura'],
        ['Marcar todas', marcarTodas, '', 'Marca todas as caixas desta página e leva o cursor à senha do certificado'],
        ['Só conferidas', soConferidas, '', 'Deixa marcadas só as minutas conferidas no visualizador e leva o cursor à senha do certificado'],
        ['Limpar conferência', limparConferencia, 'perigo'],
      ], `${n} conclus${n === 1 ? 'ão' : 'ões'} nesta página`, contagem());
    };

    function conferir(inicial) {
      const ls = linhas();
      let i = inicial != null ? inicial : ls.findIndex((l) => !conf.ok.includes(l.proc) && !conf.pul.includes(l.proc));
      if (i < 0) i = ls.findIndex((l) => !conf.ok.includes(l.proc));
      if (i < 0) { toast('Todas as minutas desta página já foram conferidas.', null, 3000); return; }

      const ifr = document.createElement('iframe');
      ifr.setAttribute('sandbox', 'allow-same-origin');
      let tit, sub, h;
      const m = modal((mc, fechar) => {
        tit = document.createElement('b'); mc.appendChild(tit);
        sub = document.createElement('span'); sub.className = 'rsq-sub'; mc.appendChild(sub);
        const e = document.createElement('span'); e.className = 'rsq-esp'; mc.appendChild(e);
        mc.appendChild(botaoM('◀ Anterior (Alt+K)', () => ir(i - 1)));
        mc.appendChild(botaoM('Pular (Alt+J)', pular));
        mc.appendChild(botaoM('Autos (Alt+A)', autos));
        mc.appendChild(botaoM('✔ Conferida (Alt+P)', conferida, 'prim', 'Marca a caixa para assinatura e abre a próxima'));
        mc.appendChild(botaoM('Fechar (Esc)', () => { fechar(); finalizar(); }, 'perigo'));
      }, ifr);
      const fecharTudo = () => { m.fechar(); document.removeEventListener('keydown', h, true); };
      h = atalhos({ p: conferida, j: pular, k: () => ir(i - 1), a: autos });
      m.fundo.addEventListener('click', (ev) => { if (ev.target === m.fundo) document.removeEventListener('keydown', h, true); });

      function ir(n) {
        const ls2 = linhas();
        if (n < 0) n = 0;
        if (n >= ls2.length) { fecharTudo(); finalizar(); return; }
        i = n; const l = ls2[i];
        ls2.forEach((x) => x.tr.classList.remove('rsq-atual')); l.tr.classList.add('rsq-atual');
        tit.textContent = `${i + 1}/${ls2.length} · ${l.proc}`;
        sub.textContent = [l.tipo, l.partes].filter(Boolean).join(' · ') + (conf.ok.includes(l.proc) ? ' · já conferida' : '');
        ifr.srcdoc = '<p style="font:14px Arial;padding:20px;color:#666">Carregando a minuta...</p>';
        if (!l.min) { ifr.srcdoc = '<p style="font:14px Arial;padding:20px;color:#a00">Minuta não encontrada nesta linha.</p>'; return; }
        baixarMinuta(l.min, true).then((mi) => {
          if (i !== n) return;
          if (mi.pdf) {          // PDF: precisa do visualizador do navegador (sem sandbox)
            ifr.removeAttribute('sandbox'); ifr.removeAttribute('srcdoc');
            if (ifr.dataset.blob) URL.revokeObjectURL(ifr.dataset.blob);
            ifr.dataset.blob = URL.createObjectURL(mi.blob); ifr.src = ifr.dataset.blob;
            return;
          }
          ifr.setAttribute('sandbox', 'allow-same-origin');
          ifr.srcdoc = mi.html;
          ifr.onload = () => { try { ifr.contentDocument.addEventListener('keydown', h, true); } catch (e) {} };
        }).catch((e) => { ifr.srcdoc = `<p style="font:14px Arial;padding:20px;color:#a00">Erro ao abrir a minuta: ${esc(e.message)}</p>`; });
      }
      function proxima() {
        const ls2 = linhas();
        let n = ls2.findIndex((l, k) => k > i && !conf.ok.includes(l.proc));
        if (n < 0) n = ls2.length;
        ir(n);
      }
      function conferida() {
        const l = linhas()[i]; if (!l) return;
        if (!conf.ok.includes(l.proc)) conf.ok.push(l.proc);
        conf.pul = conf.pul.filter((p) => p !== l.proc);
        salvarConf();
        if (!l.cb.checked) l.cb.click();
        l.tr.classList.add('rsq-conferida');
        proxima();
      }
      function pular() {
        const l = linhas()[i]; if (!l) return;
        if (!conf.pul.includes(l.proc)) conf.pul.push(l.proc);
        salvarConf();
        proxima();
      }
      function autos() { const l = linhas()[i]; if (l && l.procHref) window.open(l.procHref, '_blank'); }
      ir(i);
    }

    function finalizar() {
      linhas().forEach((x) => x.tr.classList.remove('rsq-atual'));
      montarBarra();
      const ls = linhas(); const ok = ls.filter((l) => conf.ok.includes(l.proc)).length;
      if (ok) {
        toast(`${ok} conclusão(ões) conferida(s) e marcada(s). Digite a senha do certificado e assine.`, null, 4000);
        irParaSenha();
      }
    }

    pintar();
    montarBarra();
    return;
  }

  const s = ler();

  // ======================= EDITOR (Digitar Documento) =======================
  if (ehEditor()) {
    if (s && s.etapa !== 'editor') { s.etapa = 'editor'; gravar(s); }

    // Conferência na saída: a publicação ou a minuta podem ter sido editadas depois da conferência da entrada.
    // Se divergir, pede confirmação; recusada, mostra as diferenças e fica na tela.
    let saidaConferida = false;
    const liberaSaida = (acao) => {
      try { conferirEditor(); } catch (x) {}
      if (!resEd || resEd.estado !== 'erro') return true;
      if (window.confirm(resEd.titulo + ' (conferido de novo na saída).\n\n' + acao + ' mesmo assim?')) return true;
      mostrarDiferencas(resEd);
      return false;
    };
    const sair = () => { saidaConferida = true; $('submitButton').click(); };
    // O Continuar do próprio Projudi também passa pela conferência.
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest || !ev.target.closest('#submitButton')) return;
      if (saidaConferida) { saidaConferida = false; return; }
      if (!liberaSaida('Continuar')) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    }, true);

    const postergarEProxima = () => {
      if (!liberaSaida('Postergar')) return;
      const e = ler() || { etapa: '', vistos: [], feitas: 0, avulsa: true };
      e.etapa = 'postergar'; gravar(e);
      sair();
    };
    const autos = () => { const b = $('navegarProcessoButton'); if (b) b.click(); };
    const soContinuar = () => {
      if (!liberaSaida('Continuar')) return;
      const e = ler(); if (e) { e.etapa = 'manual'; gravar(e); }
      sair();
    };
    const pular = () => voltarParaLista();

    // Substitui o texto da caixa de publicação pela parte dispositiva da minuta.
    const corrigirPublicacao = () => {
      const ta = caixaPubEditor();
      const inst = window.CKEDITOR && Object.values(window.CKEDITOR.instances)[0];
      if (!ta || !inst) { toast('Caixa de publicação ou minuta não encontrada.', null, 3000); return; }
      const d = extrairDispositivo(inst.getData());
      if (!d) { toast('Dispositivo não localizado na minuta: selecione o trecho e use "Adicionar Texto".', null, 4000); return; }
      ta.value = d;
      ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
      conferirEditor();
      toast('Publicação substituída pela parte dispositiva da minuta. Confira.', null, 3500);
    };
    // O botão "Corrigir publicação" só aparece quando a publicação diverge da minuta.
    let comCorrigir = null;
    const montarBarraEd = (corrigir) => {
      if (corrigir === comCorrigir) return;
      comCorrigir = corrigir;
      const botoes = [['✔ Postergar e próxima (Alt+P)', postergarEProxima, 'prim', 'Continuar + Postergar Assinatura + abrir a minuta do próximo processo']];
      if (corrigir) botoes.push(['Corrigir publicação (Alt+D)', corrigirPublicacao, 'ok', 'Substitui o texto da caixa de publicação pela parte dispositiva da minuta']);
      botoes.push(['Autos (Alt+A)', autos, '', 'Abre o Navegar (F12) do processo em nova janela'],
        ['Continuar (Alt+C)', soContinuar, '', 'Vai à tela da movimentação sem postergar (assinar, ajustar intimação etc.)']);
      if (s && !s.avulsa) botoes.push(['Pular (Alt+J)', pular, '', 'Sem salvar; abre a próxima minuta'], ['Encerrar', () => encerrar(), 'perigo']);
      barra(botoes, s && !s.avulsa ? info(s) : '', ultimaBarra && ultimaBarra.extra);
    };
    montarBarraEd(false);
    atalhos({ p: postergarEProxima, a: autos, c: soContinuar, j: pular, d: corrigirPublicacao });

    // ---- Conferência da publicação já no editor (texto do CKEditor x caixa de publicação) ----
    const caixaPubEditor = () => {
      const vis = [...document.querySelectorAll('textarea')].filter((t) => t.offsetParent !== null && !t.closest('.cke'));
      return vis.find((t) => /public/i.test((t.name || '') + (t.id || ''))) || vis.sort((a, b) => b.offsetHeight - a.offsetHeight)[0] || null;
    };
    const textoEditor = () => {
      const inst = window.CKEDITOR && Object.values(window.CKEDITOR.instances)[0];
      return inst ? textoDoHtml(inst.getData()) : '';
    };
    let resEd = null, limpouDespacho = false, preencheuEd = false;
    // Tipo do ato: parágrafo isolado com DESPACHO / SENTENÇA / DECISÃO (ignora "cumprimento de sentença" do cabeçalho).
    const tipoNoEditor = () => {
      const inst = window.CKEDITOR && Object.values(window.CKEDITOR.instances)[0];
      if (!inst) return '';
      const doc = new DOMParser().parseFromString(inst.getData(), 'text/html');
      for (const el of doc.body.querySelectorAll('p,h1,h2,h3,h4,div,td,strong,b,span')) {
        const t = norm(el.textContent).toUpperCase();
        if (t.length <= 40 && /^(DESPACHO|SENTEN[ÇC]A|DECIS[ÃA]O)\b/.test(t)) return t;
      }
      return '';
    };
    const conferirEditor = () => {
      const ta = caixaPubEditor(); const txt = textoEditor();
      if (!txt) return;
      { const inst0 = window.CKEDITOR && Object.values(window.CKEDITOR.instances)[0];
        guardarMinuta(procDaTela() || ((norm(txt).match(RE_CNJ) || [])[0]) || (s && s.atual), inst0 && inst0.getData()); }
      if (!ta) return;
      ta.classList.remove('rsq-pub-ok', 'rsq-pub-erro', 'rsq-pub-aviso');
      const tipo = tipoNoEditor(); definirTipo(tipo);
      if (/DESPACH/.test(tipo)) {
        // Despacho não é publicado: limpa a caixa de publicação (uma vez; se o senhor digitar depois, respeita).
        if (!limpouDespacho && ta.value.trim()) {
          ta.value = '';
          ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
          toast('Despacho: texto de publicação removido.', null, 2500);
        }
        limpouDespacho = true;
        resEd = { estado: 'neutro', titulo: 'Despacho: sem texto de publicação ("Publicar: Não" na etapa seguinte)' };
      }
      else if (/SENTEN|DECIS/.test(tipo)) {
        const inst = window.CKEDITOR && Object.values(window.CKEDITOR.instances)[0];
        const preencheu = !preencheuEd && inst && preencherDispositivo(ta, inst.getData());
        if (preencheu) preencheuEd = true;
        if (!ta.value.trim()) { resEd = { estado: 'aviso', titulo: 'Caixa de publicação vazia e dispositivo não localizado: selecione o trecho e use "Adicionar Texto"' }; atualizarExtra(chipResultado(resEd)); return; }
        resEd = comparar(ta.value, txt);
        if (preencheu && resEd.estado === 'ok') resEd.titulo = 'Dispositivo incluído na publicação (confira)';
        ta.classList.add(resEd.estado === 'ok' ? 'rsq-pub-ok' : resEd.estado === 'erro' ? 'rsq-pub-erro' : 'rsq-pub-aviso');
      } else resEd = { estado: 'neutro', titulo: 'Tipo do ato não identificado no texto: comparação não feita' };
      montarBarraEd(/SENTEN|DECIS/.test(tipo) && (resEd.estado === 'erro' || resEd.estado === 'aviso'));
      atualizarExtra(chipResultado(resEd));
    };
    let tmEd;
    const agendar = () => { clearTimeout(tmEd); tmEd = setTimeout(conferirEditor, 900); };
    const ligarEd = () => {
      const ta = caixaPubEditor(); if (ta && !ta.dataset.rsq) { ta.dataset.rsq = '1'; ta.addEventListener('input', agendar); }
      if (window.CKEDITOR) Object.values(window.CKEDITOR.instances).forEach((inst) => { if (!inst.rsq) { inst.rsq = 1; inst.on('change', agendar); } });
      conferirEditor();
    };
    // "Adicionar Texto" do Projudi altera a caixa sem disparar evento: confere logo depois.
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest && ev.target.closest('input[type=button],input[type=submit],button');
      if (b && /^Adicionar Texto$/i.test((b.value || b.textContent || '').trim())) setTimeout(conferirEditor, 300);
    });
    // Espera o CKEditor ficar pronto (até ~15 s).
    let tent = 0;
    const esperarCK = () => {
      const pronto = window.CKEDITOR && Object.values(window.CKEDITOR.instances).some((i) => i.status === 'ready');
      if (pronto) ligarEd(); else if (++tent < 30) setTimeout(esperarCK, 500);
    };
    esperarCK();

    return;
  }

  // ======================= PRÉVIA EM PDF (depois do Continuar) =======================
  if (ehPrevia()) {
    const salvarPrevia = () => $('submitButton').click();
    const emRevisao = s && !s.avulsa;
    if (s && s.etapa === 'postergar') {
      let cancelado = false;
      const t = toast('Salvando a minuta...', () => {
        cancelado = true;
        const e = ler(); if (e && e.avulsa) limpar(); else if (e) { e.etapa = 'manual'; gravar(e); }
        barra([['Salvar (Alt+S)', salvarPrevia, 'prim']], emRevisao ? info(ler()) : '');
      });
      setTimeout(() => { if (!cancelado) { t.remove(); salvarPrevia(); } }, ATRASO_POSTERGAR_MS);
      return;
    }
    barra([['Salvar (Alt+S)', salvarPrevia, 'prim']].concat(emRevisao ? [['Encerrar', () => encerrar(), 'perigo']] : []), emRevisao ? info(s) : '');
    atalhos({ s: salvarPrevia });
    return;
  }

  // ======================= ANALISAR CONCLUSÃO =======================
  if (ehAnalisar()) {
    const salvar = () => {
      const e = ler();
      if (e && e.avulsa) limpar();
      else if (e) { e.etapa = 'proxima'; e.feitas = (e.feitas || 0) + 1; gravar(e); }
      $('salvarButton').click();
    };
    // O Salvar anterior foi recusado pelo Projudi (ex.: publicação exigida): desfaz a contagem e retoma o fluxo.
    if (s && s.etapa === 'proxima' && temErroProjudi()) {
      s.feitas = Math.max(0, (s.feitas || 0) - 1);
      s.retry = (Number(s.retry) || 0) + 1;
      s.etapa = s.retry > 1 ? 'manual' : 'salvar';   // uma única nova tentativa automática
      gravar(s);
    }
    const emRevisao = s && !s.avulsa;
    let resultado = null;
    const conferirDeNovo = async () => {
      atualizarExtra(chip('neutro', 'Comparando publicação e minuta...'));
      resultado = await conferirPublicacao();
      atualizarExtra(extraResultado());
      return resultado;
    };
    const extraResultado = () => {
      const c = chipResultado(resultado);
      return c;
    };

    // Botão "Publicar": aparece quando decisão/sentença de processo público veio com "Publicar: Não" e texto na caixa.
    // Marca "Publicar: Sim", confere o texto com a minuta e, se conferido, segue como "Salvar e próxima".
    const publicar = async () => {
      if (!marcarSimPublicar()) { toast('Não consegui marcar "Publicar: Sim".', null, 3000); return; }
      barra(botoesAnalisar(false), emRevisao ? info(ler()) : '', chip('neutro', 'Comparando publicação e minuta...'));
      const res = await conferirDeNovo();
      if (res && res.estado === 'ok') { salvar(); return; }
      toast('Publicação marcada, mas não salva: ' + (res ? res.titulo : 'falha na comparação') + '.',
        res && res.dif ? () => mostrarDiferencas(res) : null, 8000, 'Ver diferenças');
      if (res && res.dif) mostrarDiferencas(res);
    };
    function botoesAnalisar(comPublicar) {
      const b = [['✔ Salvar' + (emRevisao ? ' e próxima' : '') + ' (Alt+P)', salvar, 'prim',
        postergadaMarcada() ? 'Salva com a assinatura postergada' : 'Atenção: esta tela não está marcada como assinatura postergada']];
      if (comPublicar) b.push(['Publicar' + (emRevisao ? ' e próxima' : '') + ' (Alt+U)', publicar, '',
        'Marca "Publicar: Sim", confere o texto com a minuta e, se conferido, salva' + (emRevisao ? ' e abre a próxima' : '')]);
      if (emRevisao) b.push(['Pular (Alt+J)', voltarParaLista, ''], ['Encerrar', () => encerrar(), 'perigo']);
      return b;
    }

    const automatico = s && (s.etapa === 'postergar' || s.etapa === 'salvar') && postergadaMarcada();
    barra(botoesAnalisar(), emRevisao ? info(s) : '', chip('neutro', 'Comparando publicação e minuta...'));
    atalhos({ p: salvar, j: voltarParaLista });

    // Revalida quando a caixa de publicação for editada.
    const ta = caixaPublicacao();
    if (ta) { let tm; ta.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(conferirDeNovo, 800); }); }

    atalhos({ u: () => { if (resultado && resultado.publicar) publicar(); } });
    conferirDeNovo().then((res) => {
      if (res && res.publicar) barra(botoesAnalisar(true), emRevisao ? info(s) : '', chipResultado(res));
      if (!automatico) return;
      // Chegou pelo "Postergar e próxima": só salva sozinho se a publicação estiver conferida (ou se for despacho).
      const liberado = res && (res.estado === 'ok' || res.estado === 'neutro');
      if (!liberado) {
        const e = ler(); if (e && e.avulsa) limpar(); else if (e) { e.etapa = 'manual'; gravar(e); }
        toast('Salvamento automático suspenso: ' + (res ? res.titulo : 'falha na comparação') + '.',
          res && res.dif ? () => mostrarDiferencas(res) : null, 8000, 'Ver diferenças');
        if (res && res.dif) mostrarDiferencas(res);
        return;
      }
      let cancelado = false;
      const t = toast('Salvando com assinatura postergada...', () => {
        cancelado = true;
        const e = ler(); if (e && e.avulsa) limpar(); else if (e) { e.etapa = 'manual'; gravar(e); }
      });
      setTimeout(() => { if (!cancelado) { t.remove(); salvar(); } }, ATRASO_POSTERGAR_MS);
    });
    return;
  }

  // ======================= MOVIMENTAÇÃO =======================
  if (ehMovimentacao()) {
    // "Alterar" = editar(0): abre o editor da minuta.
    const editar0 = () => {
      const b = botaoPorRotulo(/^Alterar$/i);
      if (b) b.click(); else if (typeof window.editar === 'function') window.editar(0);
    };

    if (s && s.etapa === 'abrir') {
      s.etapa = 'editor'; gravar(s);
      editar0();
      return;
    }

    const postergar = () => {
      const e = ler();
      if (e && e.avulsa) limpar();
      else if (e) { e.etapa = 'salvar'; gravar(e); }
      window.assinarDepois();
    };

    if (s && s.etapa === 'postergar') {
      let cancelado = false;
      const t = toast('Postergando assinatura...', () => {
        cancelado = true;
        const e = ler(); if (e && e.avulsa) limpar(); else if (e) { e.etapa = 'manual'; gravar(e); }
      });
      setTimeout(() => { if (!cancelado) { t.remove(); postergar(); } }, ATRASO_POSTERGAR_MS);
      return;
    }

    const emRevisao = s && !s.avulsa;
    const botoes = [
      ['✔ Postergar' + (emRevisao ? ' e próxima' : '') + ' (Alt+P)', postergar, 'prim'],
      ['Alterar (Alt+E)', editar0, '', 'Abre o editor da minuta'],
    ];
    if (emRevisao) botoes.push(['Pular (Alt+J)', voltarParaLista, ''], ['Encerrar', () => encerrar(), 'perigo']);
    barra(botoes, emRevisao ? info(s) : '');
    atalhos({ p: postergar, e: editar0, j: voltarParaLista });
  }
})();
