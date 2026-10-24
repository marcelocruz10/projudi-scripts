// ==UserScript==
// @name         Painel de Navegação - Projudi
// @namespace    tjam.projudi.navegador
// @version      1.15.1
// @description  Acesso direto às unidades e filas do Projudi: busca, árvore, quadro por unidade e configurações.
// @author       Marcelo Cruz de Oliveira
// @match        https://projudi.tjam.jus.br/projudi/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/marcelocruz10/projudi-scripts/main/projudi-navegador-rapido.user.js
// @downloadURL  https://raw.githubusercontent.com/marcelocruz10/projudi-scripts/main/projudi-navegador-rapido.user.js
// @run-at       document-idle
// ==/UserScript==

/*
 * Funcionamento
 * - O Projudi usa tokens opacos (_tj) e guarda a "Atuação" (unidade) na sessão do servidor.
 *   Por isso o script não guarda endereços: guarda apenas os RÓTULOS (competência, unidade, fila)
 *   e, a cada acesso, percorre a cadeia Início > Competência > Unidade obtendo tokens novos.
 * - Mapeamento ("Atualizar dados"): percorre, em sequência, todas as unidades visíveis ao usuário,
 *   em quantos níveis o Projudi apresentar (ex.: Comarca > Competência > Vara), e lê as filas e
 *   quantitativos. Ao final, restaura a Atuação em que o usuário estava.
 *   Duas modalidades: "Parcial" relê apenas as unidades que tinham filas com processos na última leitura
 *   (mais rápida); "Total" percorre novamente toda a hierarquia. O botão ⟳ ao lado de "mesa", na linha de cada
 *   unidade, relê só aquela unidade: as demais conservam os dados e a variação que tinham.
 * - Nada é assinado, movimentado ou alterado nos processos: apenas leitura e cliques de navegação.
 * - Atalho: Alt+J (configurável) abre/fecha o painel com o cursor na busca.
 * - Aba lateral: clique abre/fecha o painel; arrastar para cima ou para baixo muda a posição (gravada neste navegador).
 * - Borda interna do painel: arrastar ajusta a largura (até o limite definido nas configurações);
 *   clique duplo recolhe o painel.
 * - Engrenagem: configurações de exibição, ordenação, comportamento e aparência, gravadas neste navegador,
 *   com barra de busca que filtra as opções pelo termo digitado (sem acentos, várias palavras),
 *   com exportação e importação em arquivo JSON.
 * - Tela de Conclusões: ao chegar a ela, aplica automaticamente o filtro configurado (padrão: Pré-Analisadas
 *   e Concluídas) e a ordenação (padrão: Agrupador crescente) e clica em Filtrar. Não interfere quando o próprio usuário filtra ou limpa o filtro.
 *   Vale também para a entrada pelo contador de ASSESSORIA (no painel ou na mesa do Projudi), que já chega com
 *   Pré-Analisadas marcado: nesse caso mantém Pré-Analisadas e aplica a Situação e a ordenação configuradas.
 * - Assessores (cada recurso pode ser ativado ou desativado na engrenagem, seção "Assessores"):
 *   . no painel, o botão ≡ ao lado de uma fila lê, sob demanda, as minutas concluídas da fila e as agrupa por
 *     assessor (coluna "Pré-análise" da tela de Conclusões); o clique no assessor abre a fila já filtrada por ele
 *     e sempre ordenada pelo Agrupador (crescente);
 *   . na tela de Conclusões, a coluna Pré-análise ganha seta de ordenação pelo nome do assessor (e data da
 *     pré-análise); se a fila ocupar mais de uma página, todas as páginas são reunidas na mesma tabela antes de ordenar.
 * - Filas-mãe: na árvore, cada unidade mostra primeiro só as filas de primeiro nível; as subfilas de DECISÃO,
 *   DESPACHO e SENTENÇA (ex.: DECISÃO SANEADORA, EMBARGOS DE DECLARAÇÃO) ficam recolhidas sob a mãe e se exibem
 *   pelo botão ▸ ao lado do nome dela. A filiação é a do seletor "Tipo de conclusão" da tela de Conclusões.
 * - Variação: a cada atualização, compara o total de cada fila com a leitura anterior e com a última leitura
 *   do dia anterior, sinalizando aumentos (▲) e reduções (▼).
 */

(function () {
  'use strict';

  // Letra do atalho (Alt + letra), configurável no painel; padrão J.
  const hotkeyLetter = () => {
    try { const c = JSON.parse(localStorage.getItem('pnr.cfg.v1') || '{}'); return /^[A-Za-z0-9]$/.test(c.hotkey || '') ? c.hotkey.toUpperCase() : 'J'; } catch (_) { return 'J'; }
  };
  const HOTKEY = (e) => e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && typeof e.key === 'string' && e.key.toUpperCase() === hotkeyLetter();

  // Filtro automático na tela de Conclusões (conclusaoJuiz.do), que abre no quadro interno da mesa.
  // Só vale para a fila aberta pelo painel (marca pnr.viaPainel, 30 s): pelo link da própria mesa, a fila abre como
  // o Projudi manda, com todos os processos (decisão dele, 17/10/2026).
  // Aplica-se apenas na chegada à tela com o filtro no estado padrão (Todas/Todas). Quando a carga da página
  // resulta de um filtro (automático ou do próprio usuário, inclusive "Limpar filtro"), nada é feito.
  function autoFilterConclusoes() {
    if (!/conclusaoJuiz\.do/.test(location.pathname)) return;
    let c = {};
    try { c = JSON.parse(localStorage.getItem('pnr.cfg.v1') || '{}') || {}; } catch (_) { c = {}; }
    const form = document.forms.processoConclusaoForm;
    if (!form) return;
    const KEY = 'pnr.cfFlag';
    // Pedido vindo do submenu de assessores: filtra a fila pelas minutas concluídas daquele assessor.
    let ass = null;
    try { ass = JSON.parse(sessionStorage.getItem('pnr.assessor') || 'null'); } catch (_) { ass = null; }
    sessionStorage.removeItem('pnr.assessor');
    if (ass && ass.login && Date.now() - ass.ts < 60000 && form.elements.loginAssessor) {
      const sel = form.elements.loginAssessor;
      const opt = [...sel.options].find((o) => o.value.toLowerCase() === String(ass.login).toLowerCase());
      if (opt) {
        sel.value = opt.value;
        const r = (name, value) => form.querySelector('input[type=radio][name="' + name + '"][value="' + value + '"]');
        const rp = r('preAnalisada', 'true'), rs = r('situacao', 'concluidas');
        if (rp) rp.checked = true;
        if (rs) rs.checked = true;
        // Ordenação: sempre Agrupador crescente, independentemente da engrenagem.
        // A seta por assessor é desligada, pois reordenaria as linhas.
        const fcA = form.elements.conclusaoSortColumn, foA = form.elements.conclusaoSortOrder;
        if (fcA && foA) { fcA.value = 'agr.descricao'; foA.value = 'ASC'; }
        try { sessionStorage.removeItem('pnr.preSort'); } catch (_) { /* ignora */ }
        if (form.elements.conclusaoPageNumber) form.elements.conclusaoPageNumber.value = '1';
        sessionStorage.setItem(KEY, 'auto');
        const b = [...form.querySelectorAll('input[type=submit],button[type=submit]')].find((x) => /filtrar/i.test(x.value || x.textContent || ''));
        if (b) b.click(); else form.submit();
        return;
      }
    }
    if (c.autoFilter === false) return;
    const via = +sessionStorage.getItem('pnr.viaPainel') || 0;
    sessionStorage.removeItem('pnr.viaPainel');
    const flag = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const markUser = () => { if (!sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, 'user'); };
    form.addEventListener('submit', markUser, true);
    form.querySelectorAll('input[type=button],input[type=submit],button').forEach((b) => {
      if (/filtrar|limpar/i.test(b.value || b.textContent || '')) b.addEventListener('click', markUser, true);
    });
    if (flag) return;
    // Recarga vinda da própria tela (filtro, limpar, paginação): respeita o que está na tela.
    if (/conclusaoJuiz\.do/.test(document.referrer || '')) return;
    // Chegada pelo link da mesa, não pelo painel: nada a fazer.
    if (Date.now() - via > 30000) return;
    const pre = typeof c.autoFilterPre === 'string' ? c.autoFilterPre : 'true';
    const sit = typeof c.autoFilterSit === 'string' ? c.autoFilterSit : 'concluidas';
    const sortCol = typeof c.autoSortCol === 'string' ? c.autoSortCol : 'agr.descricao';
    const sortOrd = typeof c.autoSortOrd === 'string' ? c.autoSortOrd : 'ASC';
    const radio = (name, value) => form.querySelector('input[type=radio][name="' + name + '"][value="' + value + '"]');
    let changed = false;
    // Filtro de Pré-Análise e Situação: só se a tela chegar num dos estados de entrada do Projudi:
    // - nome da fila: Todas/Todas;
    // - contador de ASSESSORIA (painel ou mesa): Pré-Analisadas/Todas. Aqui a Pré-Análise é mantida
    //   (é o que distingue a assessoria) e aplica-se apenas a Situação configurada.
    const dp = radio('preAnalisada', 'ambos'), dpa = radio('preAnalisada', 'true'), ds = radio('situacao', 'todas');
    const entradaFila = dp && dp.checked;
    const entradaAssessoria = dpa && dpa.checked;
    const rp = entradaAssessoria ? dpa : radio('preAnalisada', pre), rs = radio('situacao', sit);
    if (rp && rs && ds && ds.checked && (entradaFila || entradaAssessoria) && !(rp.checked && rs.checked)) {
      rp.click();
      rs.click();
      changed = true;
    }
    // Ordenação (ex.: Agrupador crescente): só se a tela estiver na ordenação padrão do Projudi.
    const fc = form.elements.conclusaoSortColumn, fo = form.elements.conclusaoSortOrder;
    if (sortCol && fc && fo && /con\.urgente DESC/i.test(fc.value) && fc.value !== sortCol) {
      fc.value = sortCol;
      fo.value = sortOrd;
      if (form.elements.conclusaoPageNumber) form.elements.conclusaoPageNumber.value = '1';
      changed = true;
    }
    if (!changed) return;
    sessionStorage.setItem(KEY, 'auto');
    const btn = [...form.querySelectorAll('input[type=submit],button[type=submit]')].find((b) => /filtrar/i.test(b.value || b.textContent || ''));
    if (btn) btn.click(); else form.submit();
  }

  // Ordenação pela coluna Pré-análise na tela de Conclusões (conclusaoJuiz.do).
  // O Projudi não oferece essa ordenação no servidor. O script acrescenta a seta ao cabeçalho e ordena as
  // linhas no próprio navegador, pelo nome do assessor (lido do título do link "por login") e, em seguida,
  // pela data da pré-análise. Se a fila tiver mais registros do que a página exibe, as demais páginas são
  // lidas em segundo plano (somente leitura) e reunidas na mesma tabela; ao final, a paginação original
  // é restabelecida no servidor. Cliques: 1º crescente, 2º decrescente, 3º volta à ordem do Projudi.
  // A escolha vale para a aba (sessionStorage) e é desfeita quando o usuário usa outra seta de ordenação.
  function ordenarPreAnalise() {
    if (!/conclusaoJuiz\.do/.test(location.pathname)) return;
    const d = document;
    const form = d.forms.processoConclusaoForm;
    if (!form) return;
    const th = [...d.querySelectorAll('th')].find((t) => /pr[ée]-an[áa]lise/i.test(t.textContent));
    if (!th || th.querySelector('a.pnr-pre')) return;
    const table = th.closest('table');
    const col = th.cellIndex;
    const nCols = th.parentElement.cells.length;
    const tbody = table.tBodies[0] || table;
    const KEY = 'pnr.preSort';
    const dataRows = (tbl) => [...tbl.querySelectorAll('tr')].filter((tr) =>
      tr.parentElement.closest('table') === tbl && tr.cells.length === nCols && tr.querySelector('td'));

    let rows = dataRows(table);
    rows.forEach((tr, i) => { tr.dataset.pnrIdx = String(i); });
    let merged = false;
    let busy = false;

    // Chave de ordenação: nome completo (título do link), login como alternativa, data aa-mm-dd.
    const info = (tr) => {
      const c = tr.cells[col];
      const a = c && c.querySelector('a');
      const login = a ? a.textContent.replace(/[[\]]/g, '').replace(/^\s*por\s+/i, '').trim() : '';
      const nome = a ? (a.getAttribute('title') || '').trim() || login : '';
      const m = (c ? c.textContent : '').match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
      const data = m ? m[3].slice(-2) + m[2] + m[1] : '';
      return { nome, login, data };
    };
    const coll = new Intl.Collator('pt-BR', { sensitivity: 'base' });

    // Contagem por assessor, numa linha de resumo logo acima da tabela.
    const resumo = d.createElement('div');
    resumo.style.cssText = 'font-size:11px;margin:4px 0;color:#3d4a3b';
    const nav = d.getElementById('navigator');
    const contagem = nav && [...nav.querySelectorAll('div')].find((e) => /registro\(s\) encontrado/.test(e.textContent));

    const link = d.createElement('a');
    link.href = '#';
    link.className = 'orderOff pnr-pre';
    link.textContent = th.textContent.trim();
    link.style.cssText = 'color:inherit;text-decoration:none;cursor:pointer';
    th.textContent = '';
    th.appendChild(link);
    const status = d.createElement('span');
    status.style.cssText = 'display:block;font-size:10px;font-weight:normal';
    th.appendChild(status);

    const nativeLinks = [...table.querySelectorAll('th a[href*="conclusaoSortColumn"]')];
    const nativeClass = new Map(nativeLinks.map((a) => [a, a.className]));
    nativeLinks.forEach((a) => a.addEventListener('click', () => { try { sessionStorage.removeItem(KEY); } catch (_) { /* ignora */ } }, true));

    function pintar(ordem) {
      link.className = 'pnr-pre ' + (ordem === 'asc' ? 'orderAsc' : ordem === 'desc' ? 'orderDesc' : 'orderOff');
      link.title = ordem === 'asc' ? 'Ordenar pelo assessor, decrescente' : ordem === 'desc' ? 'Voltar à ordem do Projudi' : 'Ordenar pelo assessor, crescente';
      nativeLinks.forEach((a) => { a.className = ordem ? 'orderOff' : nativeClass.get(a); });
      rows.forEach((tr, i) => { if (tr.classList.contains('even') || tr.classList.contains('odd')) { tr.classList.toggle('even', i % 2 === 0); tr.classList.toggle('odd', i % 2 === 1); } });
      const cont = {};
      rows.forEach((tr) => { const x = info(tr); const k = x.nome || 'Sem pré-análise'; cont[k] = (cont[k] || 0) + 1; });
      resumo.textContent = 'Por assessor: ' + Object.keys(cont).sort(coll.compare).map((k) => k + ' (' + cont[k] + ')').join(' · ');
    }

    function aplicar(ordem) {
      const base = rows.slice().sort((a, b) => +a.dataset.pnrIdx - +b.dataset.pnrIdx);
      if (ordem) {
        const s = ordem === 'desc' ? -1 : 1;
        base.sort((a, b) => {
          const x = info(a), y = info(b);
          if (!x.nome !== !y.nome) return x.nome ? -1 : 1; // sem pré-análise sempre ao final
          return s * coll.compare(x.nome, y.nome) || x.data.localeCompare(y.data) || +a.dataset.pnrIdx - +b.dataset.pnrIdx;
        });
      }
      const anchor = rows.length ? rows[rows.length - 1].nextSibling : null;
      const parent = rows.length ? rows[0].parentNode : tbody;
      const frag = d.createDocumentFragment();
      base.forEach((tr) => frag.appendChild(tr));
      parent.insertBefore(frag, anchor);
      rows = base;
      pintar(ordem);
    }

    // Codificação ISO-8859-1, usada pelo Projudi nos formulários.
    const enc = (s) => [...String(s)].map((ch) => {
      const c = ch.charCodeAt(0);
      if (/[A-Za-z0-9\-_.*]/.test(ch)) return ch;
      if (c === 32) return '+';
      return c < 256 ? '%' + c.toString(16).toUpperCase().padStart(2, '0') : encodeURIComponent(ch);
    }).join('');

    async function pagina(num, tam) {
      const pares = [];
      [...form.elements].forEach((e) => {
        if (!e.name || e.disabled) return;
        if (/^(listaConclusoesSelect|checker)$/.test(e.name)) return;
        if ((e.type === 'checkbox' || e.type === 'radio') && !e.checked) return;
        if (/^(submit|button|reset|file|image)$/.test(e.type)) return;
        let v = e.value;
        if (e.name === 'conclusaoPageNumber') v = String(num);
        if (e.name === 'conclusaoPageSize' || e.name === 'pagerConfigPageSize') v = String(tam);
        pares.push(enc(e.name) + '=' + enc(v));
      });
      const r = await fetch(form.action, {
        method: 'POST', credentials: 'include', body: pares.join('&'),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const buf = await r.arrayBuffer();
      const cs = ((r.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1] || 'iso-8859-1';
      const doc = new DOMParser().parseFromString(new TextDecoder(cs).decode(buf), 'text/html');
      const t = [...doc.querySelectorAll('th')].find((x) => /pr[ée]-an[áa]lise/i.test(x.textContent));
      return t ? dataRows(t.closest('table')) : [];
    }

    const chave = (tr) => {
      const cb = tr.querySelector('input[name=listaConclusoesSelect]');
      return cb ? 'cb:' + cb.value : 'tx:' + tr.textContent.replace(/\s+/g, ' ').trim();
    };

    async function reunir() {
      const m = (contagem ? contagem.textContent : '').match(/(\d+)\s*registro/);
      const total = m ? +m[1] : rows.length;
      if (merged || total <= rows.length) return;
      const TAM = 100, MAX_PAG = 30;
      const pags = Math.min(Math.ceil(total / TAM), MAX_PAG);
      const orig = {
        num: (form.elements.conclusaoPageNumber || {}).value || '1',
        tam: (form.elements.conclusaoPageSize || {}).value || '20',
      };
      const vistos = new Set(rows.map(chave));
      const novas = [];
      try {
        for (let p = 1; p <= pags; p++) {
          status.textContent = 'reunindo páginas ' + p + '/' + pags + '…';
          (await pagina(p, TAM)).forEach((tr) => {
            const k = chave(tr);
            if (vistos.has(k)) return;
            vistos.add(k);
            novas.push(d.importNode(tr, true));
          });
        }
      } finally {
        try { await pagina(orig.num, orig.tam); } catch (_) { /* a paginação original volta no próximo filtro */ }
      }
      const parent = rows.length ? rows[0].parentNode : tbody;
      const anchor = rows.length ? rows[rows.length - 1].nextSibling : null;
      novas.forEach((tr, i) => { tr.dataset.pnrIdx = String(rows.length + i); parent.insertBefore(tr, anchor); });
      // Os scripts das linhas (cadeado/semáforo da pré-análise) não rodam quando importados: são recriados.
      novas.forEach((tr) => tr.querySelectorAll('script').forEach((old) => {
        if (old.src) return;
        const s = d.createElement('script');
        s.textContent = old.textContent;
        old.replaceWith(s);
      }));
      rows = rows.concat(novas);
      merged = true;
      const n = rows.length;
      if (contagem) contagem.textContent = total + ' registro(s) encontrado(s), exibindo todos os ' + n + ' (páginas reunidas pelo Painel)';
      // Com tudo reunido, as setas e números de página deixam de fazer sentido: ficam ocultos (o seletor de tamanho permanece).
      const navR = nav && nav.querySelector('.navRight');
      if (navR) [...navR.children].forEach((e) => { if (e.tagName !== 'SELECT') e.style.display = 'none'; });
      status.textContent = total > n ? 'atenção: ' + n + ' de ' + total + ' reunidos' : '';
    }

    async function escolher(ordem) {
      if (busy) return;
      busy = true;
      try {
        if (ordem) await reunir();
        aplicar(ordem);
        try { if (ordem) sessionStorage.setItem(KEY, ordem); else sessionStorage.removeItem(KEY); } catch (_) { /* ignora */ }
      } catch (_) {
        status.textContent = 'falha ao reunir as páginas; ordenada apenas a página atual';
        aplicar(ordem);
      } finally {
        busy = false;
      }
    }

    link.addEventListener('click', (e) => {
      e.preventDefault();
      let atual = null;
      try { atual = sessionStorage.getItem(KEY); } catch (_) { /* ignora */ }
      escolher(atual === 'asc' ? 'desc' : atual === 'desc' ? null : 'asc');
    });

    if (nav && nav.parentNode) nav.parentNode.insertBefore(resumo, nav.nextSibling);
    else table.parentElement.insertBefore(resumo, table);

    let salvo = null;
    try { salvo = sessionStorage.getItem(KEY); } catch (_) { /* ignora */ }
    if (salvo === 'asc' || salvo === 'desc') escolher(salvo); else pintar(null);
  }

  // Em qualquer quadro que não seja o principal, repassa o atalho e cuida do filtro automático.
  if (window.name !== 'mainFrame') {
    document.addEventListener('keydown', (e) => {
      if (!HOTKEY(e)) return;
      e.preventDefault();
      try { top.frames['mainFrame'].postMessage({ pnr: 'toggle' }, location.origin); } catch (_) { /* sem mainFrame */ }
    }, true);
    // Clique ou Esc em qualquer outro quadro da página (mesa, conclusões, cabeçalho) fecha os painéis, que vivem no
    // quadro principal (ver abasDoProjudi). Uma vez por quadro, qualquer que seja o script que chegue primeiro.
    if (!window.__projudiAbasQuadro) {
      window.__projudiAbasQuadro = true;
      const avisar = () => { try { top.frames['mainFrame'].postMessage({ projudiAbas: 'fechar' }, location.origin); } catch (_) { /* sem mainFrame */ } };
      document.addEventListener('pointerdown', avisar, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') avisar(); }, true);
    }
    try { autoFilterConclusoes(); } catch (_) { /* nunca atrapalhar a tela do Projudi */ }
    // Se o filtro automático acabou de reenviar a tela, a ordenação fica para a carga seguinte.
    // A seta de ordenação por assessor pode ser desativada nas configurações (engrenagem > Assessores).
    try {
      let c = {};
      try { c = JSON.parse(localStorage.getItem('pnr.cfg.v1') || '{}') || {}; } catch (_) { c = {}; }
      if (c.preSort !== false && sessionStorage.getItem('pnr.cfFlag') !== 'auto') ordenarPreAnalise();
    } catch (_) { /* idem */ }
    return;
  }

  /* ---------------------------------------------------------------- utilidades */
  const LS_TREE = 'pnr.tree.v1';
  const LS_UI = 'pnr.ui.v1';
  const LS_BASE = 'pnr.base.v1';
  const SS_PENDING = 'pnr.pending';
  const SS_REOPEN = 'pnr.reopen';
  const SS_TOP = 'pnr.top';
  const COUNT_RE = /\((\d+)\)\s*$/;

  // Normalização para comparação e busca: sem acentos, maiúsculas, "2ª" = "2A", "2º" = "2O".
  const norm = (s) => (s || '').replace(/ª/g, 'a').replace(/[º°]/g, 'o').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim().toUpperCase();
  const pretty = (s) => (s || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('pt-BR');
  // Abreviações apenas para exibição (o nome completo fica na dica ao passar o mouse).
  const short = (s) => s
    .replace(/\s+DA COMARCA DE MANAUS/g, '')
    .replace(/N[ÚU]CLEO DA JUSTI[ÇC]A 4\.0/g, 'NJ 4.0')
    .replace(/PREVIDENCI[ÁA]RIO/g, 'PREV.')
    .replace(/E DE ACIDENTES DE TRABALHO/g, 'E AC. TRAB.')
    .replace(/VARA DE GARANTIAS INQU[ÉE]RITOS - INQU[ÉE]RITOS/g, 'GARANTIAS · INQUÉRITOS')
    .replace(/VARA DE GARANTIAS CUST[ÓO]DIA - CUST[ÓO]DIA/g, 'GARANTIAS · CUSTÓDIA ')
    .replace(/\s+/g, ' ').trim();
  const abs = (h, base) => new URL(h, base).href;
  // O Projudi carrega a biblioteca Prototype.js, que altera Array.prototype.toJSON e faz o JSON.stringify
  // gravar listas como texto. A serialização abaixo neutraliza essa alteração apenas durante a gravação.
  const toJson = (v) => {
    const own = Object.prototype.hasOwnProperty.call(Array.prototype, 'toJSON');
    const saved = Array.prototype.toJSON;
    if (own) delete Array.prototype.toJSON;
    try { return JSON.stringify(v); } finally { if (own) Array.prototype.toJSON = saved; }
  };
  // A Prototype.js (1.5.1.1) também substitui Array.prototype.reduce por uma versão sem acumulador,
  // que devolve a própria lista: as somas viravam "[object Object],[object Object]" nas telas que a carregam.
  // Por isso as somas usam laço próprio, independente dos métodos de Array alterados pela biblioteca.
  const sumBy = (arr, f) => { let s = 0; for (const x of arr || []) s += (+f(x) || 0); return s; };
  const fixArrays = (o) => {
    if (typeof o === 'string' && /^\s*\[/.test(o)) { try { return fixArrays(JSON.parse(o)); } catch (_) { return o; } }
    if (Array.isArray(o)) return o.map(fixArrays);
    if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = fixArrays(o[k]); }
    return o;
  };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? fixArrays(JSON.parse(v)) : d; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, toJson(v)); } catch (_) { /* ignora */ } };

  function splitLabel(t) {
    t = (t || '').replace(/\s+/g, ' ').trim();
    const m = t.match(COUNT_RE);
    return m ? { label: pretty(t.slice(0, m.index)), count: +m[1] } : null;
  }

  async function getDoc(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('O Projudi respondeu HTTP ' + r.status + '.');
    const buf = await r.arrayBuffer();
    const cs = ((r.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1] || 'iso-8859-1';
    let txt;
    try { txt = new TextDecoder(cs).decode(buf); } catch (_) { txt = new TextDecoder('iso-8859-1').decode(buf); }
    const doc = new DOMParser().parseFromString(txt, 'text/html');
    if (doc.querySelector('input[type=password]')) throw new Error('Sessão do Projudi expirada. Faça login novamente.');
    return { url: r.url, doc };
  }

  function contentDocs() {
    const out = [];
    const f = document.querySelector('iframe[name=userMainFrame]');
    try { if (f && f.contentDocument) out.push(f.contentDocument); } catch (_) { /* ignora */ }
    out.push(document);
    return out;
  }

  // Links do caminho de navegação (":: MANAUS :: VARA CÍVEL"): links sem contador.
  function crumbAnchors(doc) {
    return [...doc.querySelectorAll('a[href*="mesaJuiz.do"]')].filter((x) => {
      const t = x.textContent.replace(/\s+/g, ' ').trim();
      return t.length > 1 && !COUNT_RE.test(t) && !/^In[ií]cio$|^Alterar/i.test(t) && /_tj=/.test(x.getAttribute('href') || '');
    });
  }

  // Filhos de uma tela de escolha (competências ou unidades): links para mesaJuiz.do com "(n)" no fim.
  function childLinks(doc, base) {
    const seen = new Set(), out = [];
    for (const a of doc.querySelectorAll('a[href*="mesaJuiz.do"]')) {
      const s = splitLabel(a.textContent);
      if (!s || !s.label) continue;
      const k = norm(s.label);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ label: s.label, count: s.count, url: abs(a.getAttribute('href'), base) });
    }
    return out;
  }

  // Topo da hierarquia. O link "Início" do Projudi leva à mesa da unidade atual, e a tela de topo
  // (ex.: "COMARCAS") não aparece no caminho de navegação. Por isso o script memoriza os links da tela
  // de escolha mais alta exibida nesta sessão (em geral, a tela mostrada logo após o login).
  function captureTop() {
    if (document.querySelector('iframe[name=userMainFrame]')) return;
    const links = childLinks(document, location.href);
    if (!links.length) return;
    const depth = crumbAnchors(document).length;
    let cur = null;
    try { cur = JSON.parse(sessionStorage.getItem(SS_TOP) || 'null'); } catch (_) { cur = null; }
    if (!cur || depth <= cur.depth) sessionStorage.setItem(SS_TOP, toJson({ depth, links }));
  }

  async function topLinks() {
    let t = null;
    try { t = JSON.parse(sessionStorage.getItem(SS_TOP) || 'null'); } catch (_) { t = null; }
    if (t && Array.isArray(t.links) && t.links.length) return t.links;
    // Sem registro do topo: usa o primeiro link do caminho de navegação (serve para quem atua numa só comarca).
    for (const d of contentDocs()) {
      const a = crumbAnchors(d)[0];
      if (a) { const pg = await getDoc(a.href); return childLinks(pg.doc, pg.url); }
    }
    throw new Error('Não localizei a tela inicial da mesa. Volte à tela inicial do Projudi (a que aparece logo após o login) e tente novamente.');
  }

  // Percorre, a partir do topo, os rótulos informados e devolve a última página obtida (com seus links).
  async function walk(path) {
    let links = await topLinks();
    let cur = { doc: null, url: null, links };
    for (let i = 0; i < path.length; i++) {
      const lab = path[i];
      const next = links.find((l) => norm(l.label) === norm(lab));
      if (!next) {
        if (i === 0) sessionStorage.removeItem(SS_TOP);
        throw new Error('Não localizei "' + lab + '" no Projudi. Volte à tela inicial do Projudi e clique em "Atualizar: Total".');
      }
      cur = await getDoc(next.url);
      cur.link = next;
      links = cur.links = childLinks(cur.doc, cur.url);
    }
    return cur;
  }

  // O "grupo" de uma unidade é o caminho até ela (ex.: "MANAUS|VARA CÍVEL"); vazio quando está no topo.
  const compPath = (label) => (label ? String(label).split('|') : []);
  const compName = (c) => (c.display || (c.label ? compPath(c.label).join(' › ') : 'UNIDADES'));

  /* ------------------------------------------------------------ filas da mesa */
  function linkKind(a) {
    const t = a.textContent.replace(/\s+/g, ' ').trim();
    if (/^ASSESSORIA/i.test(t)) return 'assess';
    const redInside = a.querySelector('font[color]');
    const redAround = a.closest('font[color]');
    if ((redInside && /red/i.test(redInside.getAttribute('color'))) || (redAround && /red/i.test(redAround.getAttribute('color')))) return 'red';
    return 'total';
  }

  // Nome da fila: texto da célula anterior ao primeiro link (o <b> engloba também os contadores).
  function titleOf(td) {
    let s = '';
    const w = td.ownerDocument.createTreeWalker(td, 4 /* SHOW_TEXT */);
    let n;
    while ((n = w.nextNode())) {
      if (n.parentElement && n.parentElement.closest('a')) break;
      s += ' ' + n.textContent;
    }
    // Os contadores ficam como "(<a>000</a>)": remove o "(" solto e eventuais "(n)".
    return pretty(s.replace(/\(\d+\)/g, '').replace(/[\s(]+$/, ''));
  }

  function queueCells(doc) {
    const out = [], occ = {};
    for (const td of doc.querySelectorAll('td')) {
      const b = td.querySelector(':scope > b');
      if (!b) continue;
      const links = [...td.querySelectorAll('a[href]')].filter((a) => {
        const h = a.getAttribute('href') || '';
        return /_tj=/.test(h) && !/mesaJuiz\.do|usuario\.do|areaAtuacao/.test(h);
      });
      if (!links.length) continue;
      const title = titleOf(td);
      if (!title) continue;
      const n = (occ[norm(title)] = (occ[norm(title)] || 0) + 1);
      out.push({ td, title, n, links });
    }
    return out;
  }

  function parseQueues(doc) {
    return queueCells(doc).map(({ title, n, links }) => {
      const q = { title, n, total: null, red: null, assess: null };
      for (const a of links) {
        const k = linkKind(a);
        const num = +((a.textContent.match(/(\d+)/) || [])[1] || 0);
        if (q[k] === null) q[k] = num;
      }
      return q;
    });
  }

  function findQueueAnchor(doc, title, n, kind) {
    const cell = queueCells(doc).find((c) => norm(c.title) === norm(title) && c.n === (n || 1));
    if (!cell) return null;
    return cell.links.find((a) => linkKind(a) === (kind || 'total')) || null;
  }

  function currentAtuacao() {
    for (const d of contentDocs()) {
      const a = d.querySelector('a[href*="areaAtuacao"]');
      if (a) return a.textContent.replace(/\s+/g, ' ').trim();
    }
    return null;
  }

  /* ------------------------------------------------------ mapeamento completo */
  // Atualização parcial: relê apenas as unidades que, na última leitura, tinham ao menos uma fila com processos
  // (ou que terminaram com erro). As demais conservam os dados anteriores. Não descobre unidades novas.
  const unitHasQueues = (u) => (u.queues || []).some((q) => (q.total || 0) > 0 || (q.red || 0) > 0 || (q.assess || 0) > 0);
  // Com `only` ({ c, u }: rótulos), relê apenas essa unidade, tenha ou não processos.
  async function crawlPartial(old, progress, only) {
    const comps = JSON.parse(toJson(old.comps));
    const todo = [];
    for (const c of comps) for (const u of c.units || []) {
      if (only ? c.label === only.c && u.label === only.u : u.error || unitHasQueues(u)) todo.push([c, u]);
    }
    if (only && !todo.length) throw new Error('A unidade não está no mapeamento. Clique em "Atualizar: Total".');
    let i = 0;
    for (const [c, u] of todo) {
      i++;
      progress((only ? 'Atualizando ' : 'Atualização parcial: ') + compPath(c.label).concat(u.label).map(short).join(' › ') + ' (' + i + ' de ' + todo.length + ')');
      try {
        const pg = await walk(compPath(c.label).concat(u.label));
        if (pg.link && typeof pg.link.count === 'number') u.count = pg.link.count;
        const ifr = pg.doc.querySelector('iframe[name=userMainFrame]');
        if (!ifr) throw new Error('A unidade não abriu a mesa esperada.');
        u.queues = parseQueues((await getDoc(abs(ifr.getAttribute('src'), pg.url))).doc);
        delete u.error;
      } catch (e) { u.error = e.message; }
    }
    return { comps, nRead: todo.length };
  }

  async function crawl(progress, mode, only) {
    const atuacaoOriginal = currentAtuacao();
    const prevTree = lsGet(LS_TREE, null);
    const hasPrev = prevTree && Array.isArray(prevTree.comps) && prevTree.comps.length > 0;
    if (only && !hasPrev) throw new Error('Sem mapeamento. Clique em "Atualizar: Total".');
    const partial = (only || mode === 'parcial') && hasPrev;
    let comps = [];
    let nUnits = 0;
    // Percorre a hierarquia em profundidade: cada link é um grupo (outra tela de escolha) ou uma unidade (abre a mesa).
    async function explore(path, page, count, depth) {
      const kids = page.links.filter((l) => !path.some((p) => norm(p) === norm(l.label)));
      const group = { label: path.join('|'), display: path.length ? path.join(' › ') : 'UNIDADES', count, units: [] };
      const subgroups = [];
      for (const k of kids) {
        if (!cfg.crawlZeros && !k.count) continue; // sem conclusões: não percorre (economiza tempo em logins com muitas comarcas)
        const p = path.concat(k.label);
        progress('Lendo ' + p.map(short).join(' › ') + ' (' + nUnits + ' unidades lidas)');
        let pg;
        try { pg = await walk(p); } catch (e) { group.units.push({ label: k.label, count: k.count, queues: [], error: e.message }); continue; }
        const ifr = pg.doc.querySelector('iframe[name=userMainFrame]');
        if (ifr) {
          const u = { label: k.label, count: k.count, queues: [] };
          try { u.queues = parseQueues((await getDoc(abs(ifr.getAttribute('src'), pg.url))).doc); } catch (e) { u.error = e.message; }
          group.units.push(u);
          nUnits++;
        } else if (depth < 6 && pg.links.some((l) => !p.some((x) => norm(x) === norm(l.label)))) {
          subgroups.push([p, pg, k.count]);
        } else {
          group.units.push({ label: k.label, count: k.count, queues: [], error: 'Tela do Projudi não reconhecida neste nível.' });
        }
      }
      if (group.units.length) comps.push(group);
      for (const [p, pg, cnt] of subgroups) await explore(p, pg, cnt, depth + 1);
    }
    if (partial) {
      const r = await crawlPartial(prevTree, progress, only);
      comps = r.comps;
      nUnits = r.nRead;
    } else {
      const top = { links: await topLinks() };
      await explore([], top, 0, 0);
    }
    const restored = await restoreAtuacao(atuacaoOriginal, comps, progress);
    // Variação: compara com a leitura anterior e com a base do dia (última leitura antes de hoje).
    const old = lsGet(LS_TREE, null);
    const mapOf = (t) => {
      const m = {};
      if (t && Array.isArray(t.comps)) for (const c of t.comps) for (const u of c.units || []) for (const q of u.queues || []) m[c.label + '|' + u.label + '|' + q.title + '|' + q.n] = q.total;
      return m;
    };
    const today = new Date().toLocaleDateString('pt-BR');
    let base = lsGet(LS_BASE, null);
    if (!base || base.day !== today) { base = { day: today, updated: old ? old.updated : null, map: mapOf(old) }; lsSet(LS_BASE, base); }
    const last = mapOf(old);
    for (const c of comps) for (const u of c.units) {
      // Só a unidade: as demais não foram relidas e guardam a comparação que já tinham.
      if (only && !(c.label === only.c && u.label === only.u)) continue;
      for (const q of u.queues || []) {
        const k = c.label + '|' + u.label + '|' + q.title + '|' + q.n;
        q.prevLast = k in last ? last[k] : null;
        q.prevDay = k in base.map ? base.map[k] : null;
      }
    }
    if (only) {
      // A data geral continua a da última leitura de todas; a unidade relida leva o próprio horário.
      const tree = Object.assign({}, old, { comps, unitUpdate: { c: only.c, u: only.u, ts: new Date().toISOString() } });
      lsSet(LS_TREE, tree);
      return { tree, atuacaoOriginal, restored };
    }
    const tree = { updated: new Date().toISOString(), prevUpdated: old ? old.updated : null, baseUpdated: base.updated, mode: partial ? 'parcial' : 'total', nRead: partial ? nUnits : null, comps };
    lsSet(LS_TREE, tree);
    return { tree, atuacaoOriginal, restored };
  }

  // Restaura a Atuação original: escolhe a unidade cujo nome (e, havendo homônimas, cujo caminho) corresponde à Atuação.
  async function restoreAtuacao(atuacaoOriginal, comps, progress) {
    if (!atuacaoOriginal) return null;
    const alvo = norm(atuacaoOriginal);
    const cands = [];
    for (const c of comps) for (const u of c.units || []) {
      const n = norm(u.label);
      if (!u.error && (n === alvo || n.startsWith(alvo) || alvo.startsWith(n))) {
        const score = compPath(c.label).filter((seg) => alvo.includes(norm(seg))).length;
        cands.push({ c, u, score });
      }
    }
    cands.sort((x, y) => y.score - x.score);
    if (!(cands.length === 1 || (cands.length > 1 && cands[0].score > cands[1].score))) return null;
    const { c, u } = cands[0];
    if (progress) progress('Restaurando a Atuação: ' + short(u.label));
    await readUnit(c.label, u.label);
    return u.label;
  }

  async function postDoc(url, params) {
    const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!r.ok) throw new Error('O Projudi respondeu HTTP ' + r.status + '.');
    const buf = await r.arrayBuffer();
    const cs = ((r.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1] || 'iso-8859-1';
    let txt;
    try { txt = new TextDecoder(cs).decode(buf); } catch (_) { txt = new TextDecoder('iso-8859-1').decode(buf); }
    const doc = new DOMParser().parseFromString(txt, 'text/html');
    if (doc.querySelector('input[type=password]')) throw new Error('Sessão do Projudi expirada. Faça login novamente.');
    return { url: r.url, doc };
  }

  // Campos de um formulário como seriam enviados pelo navegador (sem botões).
  function formParams(form) {
    const p = new URLSearchParams();
    for (const el of form.elements) {
      if (!el.name || el.disabled || /^(submit|button|reset|file|image)$/i.test(el.type)) continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      if (el.tagName === 'SELECT' && el.multiple) { for (const o of el.selectedOptions) p.append(el.name, o.value); continue; }
      p.append(el.name, el.value);
    }
    return p;
  }

  // Minutas concluídas de uma fila, agrupadas pelo login do assessor que fez a pré-análise.
  // Entra na unidade (troca a Atuação), abre a fila, aplica o filtro "Pré-Analisadas / Concluídas" com 100 por página,
  // lê todas as páginas, devolve o filtro da tela ao estado em que a fila abriu e restaura a Atuação original.
  async function readAssessores(c, u, q, progress) {
    const atuacaoOriginal = currentAtuacao();
    let out;
    try {
      progress('Abrindo ' + short(u.label) + ' › ' + q.title + '...');
      const shell = await walk(compPath(c.label).concat(u.label));
      const ifr = shell.doc.querySelector('iframe[name=userMainFrame]');
      if (!ifr) throw new Error('A unidade não abriu a mesa esperada.');
      const mesa = await getDoc(abs(ifr.getAttribute('src'), shell.url));
      const a = findQueueAnchor(mesa.doc, q.title, q.n, 'total');
      if (!a) throw new Error('Não localizei a fila "' + q.title + '" na mesa da unidade.');
      const lst = await getDoc(abs(a.getAttribute('href'), mesa.url));
      const form = lst.doc.forms.processoConclusaoForm;
      if (!form) throw new Error('A fila não abriu a tela de Conclusões.');
      const action = abs(form.getAttribute('action') || lst.url, lst.url);
      const original = formParams(form);
      const names = {};
      if (form.elements.loginAssessor) for (const o of form.elements.loginAssessor.options) if (o.value) names[o.value.toLowerCase()] = o.textContent.replace(/\s+/g, ' ').trim();
      const counts = {};
      let total = null, read = 0;
      for (let page = 1; page <= 50; page++) {
        const p = formParams(form);
        p.set('preAnalisada', 'true');
        p.set('situacao', 'concluidas');
        p.set('loginAssessor', '');
        p.set('conclusaoPageSize', '100');
        p.set('pagerConfigPageSize', '100');
        p.set('conclusaoPageNumber', String(page));
        progress('Lendo assessores de ' + q.title + (total ? ' (' + Math.min(read, total) + ' de ' + total + ')' : '') + '...');
        const pg = await postDoc(action, p);
        if (total === null) {
          const m = (pg.doc.body ? pg.doc.body.textContent : '').match(/(\d+)\s*registro\(s\)\s*encontrado/i);
          total = m ? +m[1] : 0;
        }
        let rows = 0;
        // Cada processo é uma linha com muitas células (que contém tabelas internas); a célula "Pré-análise" traz "[ por login ]".
        for (const tr of pg.doc.querySelectorAll('tr')) {
          if (tr.cells.length < 8) continue;
          const cell = [...tr.cells].find((td) => /\[\s*por\s+[^\]\s]+\s*\]/i.test(td.textContent));
          if (!cell) continue;
          const m = cell.textContent.match(/\[\s*por\s+([^\]\s]+)\s*\]/i);
          const login = m[1].toLowerCase();
          counts[login] = (counts[login] || 0) + 1;
          rows++;
        }
        read += rows;
        if (!rows || read >= total) break;
      }
      // Devolve o filtro da tela de Conclusões ao estado em que a fila abriu.
      try { await postDoc(action, original); } catch (_) { /* ignora */ }
      const list = Object.keys(counts).map((login) => ({ login, name: assessorName(login, names[login]), n: counts[login] }))
        .sort((x, y) => y.n - x.n || x.name.localeCompare(y.name, 'pt-BR'));
      out = { list, total: total || read, ts: Date.now() };
    } finally {
      try { await restoreAtuacao(atuacaoOriginal, (lsGet(LS_TREE, null) || { comps: [] }).comps || [], progress); } catch (_) { /* ignora */ }
    }
    return out;
  }

  async function readUnit(compLabel, unitLabel) {
    const shell = await walk(compPath(compLabel).concat(unitLabel));
    const ifr = shell.doc.querySelector('iframe[name=userMainFrame]');
    if (!ifr) throw new Error('A unidade não abriu a mesa esperada.');
    const mesa = await getDoc(abs(ifr.getAttribute('src'), shell.url));
    return parseQueues(mesa.doc);
  }

  /* -------------------------------------------------------------- navegação */
  async function openTarget(t) {
    setStatus('Abrindo ' + short(t.unit) + (t.q ? ' › ' + t.q : '') + '...');
    const comp = await walk(compPath(t.comp));
    const link = comp.links.find((l) => norm(l.label) === norm(t.unit));
    if (!link) throw new Error('Não localizei a unidade "' + t.unit + '". Atualize o mapeamento.');
    if (t.q) sessionStorage.setItem(SS_PENDING, toJson({ q: t.q, n: t.n || 1, kind: t.kind || 'total', ts: Date.now() }));
    else sessionStorage.removeItem(SS_PENDING);
    if (cfg.keepOpen) sessionStorage.setItem(SS_REOPEN, '1');
    location.href = link.url;
  }

  function handlePending() {
    let p;
    try { p = JSON.parse(sessionStorage.getItem(SS_PENDING) || 'null'); } catch (_) { p = null; }
    if (!p) return;
    if (Date.now() - p.ts > 60000) { sessionStorage.removeItem(SS_PENDING); return; }
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (Date.now() - t0 > 25000) {
        clearInterval(iv);
        sessionStorage.removeItem(SS_PENDING);
        toast('A unidade foi aberta, mas não localizei a fila "' + p.q + '".');
        return;
      }
      const f = document.querySelector('iframe[name=userMainFrame]');
      let d = null;
      try { d = f && f.contentDocument; } catch (_) { d = null; }
      if (!d || d.readyState !== 'complete') return;
      const a = findQueueAnchor(d, p.q, p.n, p.kind);
      if (!a) return;
      clearInterval(iv);
      sessionStorage.removeItem(SS_PENDING);
      sessionStorage.setItem('pnr.viaPainel', String(Date.now())); // o filtro automático só vale para esta abertura
      a.click();
    }, 300);
  }

  /* -------------------------------------------------------------------- UI */
  const LS_CFG = 'pnr.cfg.v1';
  const DEFAULTS = {
    view: 'ultima',          // vista inicial: 'arvore' | 'quadro' | 'ultima'
    treeOpen: 'lembrar',     // ao abrir o painel: 'lembrar' | 'tudo' | 'nada' | 'competencias'
    zeros: false,            // mostrar unidades e filas zeradas
    zeroRule: 'conclusoes',  // unidade zerada: 'conclusoes' (contador da unidade = 0) | 'filas' (nenhuma fila com processos)
    hiddenQueues: [],        // nomes de filas ocultas em todas as unidades
    showTotal: true,
    showRed: true,
    showAssess: true,
    hideZeroChips: true,     // oculta contadores com valor 0
    queueSort: 'projudi',    // 'projudi' | 'alfa' | 'total'
    unitSort: 'projudi',     // 'projudi' | 'alfa' | 'total'
    abbreviate: true,
    titleClick: 'total',     // clique no nome da fila: 'total' | 'assess'
    keepOpen: false,         // reabrir o painel depois de navegar
    favoritesOnTop: true,
    favorites: [],           // chaves "COMPETÊNCIA|UNIDADE"
    hidden: [],
    side: 'right',
    width: 460,
    fontSize: 12,
    hotkey: 'J',
    autoRefreshMin: 0,       // 0 = nunca
    crawlZeros: false,       // ler também comarcas, competências e unidades com contador 0
    showDelta: true,         // sinalizar variação dos totais
    deltaBase: 'ultima',     // comparar com: 'ultima' (leitura anterior) | 'dia' (última leitura do dia anterior)
    deltaMin: 1,             // variação mínima para sinalizar
    showDecrease: true,      // sinalizar também reduções
    favQueues: [],           // chaves "COMPETÊNCIA|UNIDADE|FILA|n"
    favQueuesOnTop: true,
    cfgVer: 2,               // versão do formato das configurações
    autoFilter: true,        // tela de Conclusões: aplicar filtro automático
    autoFilterPre: 'true',   // Pré-Análise: 'true' (Pré-Analisadas) | 'false' (Sem Pré-Análise) | 'ambos' (Todas)
    autoFilterSit: 'concluidas', // Situação: 'todas' | 'concluidas' | 'devolvidas' | 'refeitas' | 'emAnalise'
    autoSortCol: 'agr.descricao', // ordenação automática ('' = manter a do Projudi)
    autoSortOrd: 'ASC',
    assessorNames: '',       // nomes dos assessores: uma linha por assessor, "login = Nome"
    assessorMenu: true,      // painel: botão ≡ nas filas (minutas concluídas por assessor)
    preSort: true,           // tela de Conclusões: seta de ordenação por assessor na coluna Pré-análise
  };
  const storedCfg = lsGet(LS_CFG, {}) || {};
  const cfg = Object.assign({}, DEFAULTS, storedCfg);
  if (!Array.isArray(cfg.favorites)) cfg.favorites = [];
  if (!Array.isArray(cfg.hidden)) cfg.hidden = [];
  if (!Array.isArray(cfg.hiddenQueues)) cfg.hiddenQueues = [];
  if (!Array.isArray(cfg.favQueues)) cfg.favQueues = [];
  const saveCfg = () => lsSet(LS_CFG, cfg);
  // Nome exibido do assessor: o cadastrado nas configurações; na falta, primeiro e último nome do cadastro do Projudi.
  const assessorName = (login, projudiName) => {
    for (const line of String(cfg.assessorNames || '').split(/\r?\n/)) {
      const m = line.match(/^\s*([^=\s]+)\s*=\s*(.+?)\s*$/);
      if (m && m[1].toLowerCase() === String(login).toLowerCase()) return m[2];
    }
    const full = String(projudiName || '').replace(/\(.*?\)/g, '').trim();
    if (!full) return login;
    const w = full.split(/\s+/).map((x) => x.charAt(0).toLocaleUpperCase('pt-BR') + x.slice(1).toLocaleLowerCase('pt-BR'));
    return w.length > 1 ? w[0] + ' ' + w[w.length - 1] : w[0];
  };
  // Migração: a partir da 1.4.1 o painel reabre como foi deixado (vista, galhos abertos e rolagem).
  if (!(+storedCfg.cfgVer >= 2)) { cfg.view = 'ultima'; cfg.treeOpen = 'lembrar'; cfg.cfgVer = 2; saveCfg(); }

  const ui = Object.assign({ view: 'arvore', open: {}, sort: { k: 'total', d: -1 }, qunit: '', onlyFav: false, onlyGrowth: false, scroll: {} }, lsGet(LS_UI, {}));
  if (!ui.scroll || typeof ui.scroll !== 'object') ui.scroll = {};
  if (!ui.open || typeof ui.open !== 'object') ui.open = {};
  const saveUi = () => lsSet(LS_UI, ui);

  const ukey = (c, u) => c.label + '|' + u.label;
  const isFav = (c, u) => cfg.favorites.includes(ukey(c, u));
  const isHidden = (c, u) => cfg.hidden.includes(ukey(c, u));
  const nameOf = (label) => (cfg.abbreviate ? short(label) : label);
  const qHasWork = (q) => !!((cfg.showTotal && q.total) || (cfg.showRed && q.red) || (cfg.showAssess && q.assess));
  const qShown = (q) => !cfg.hiddenQueues.includes(q.title);
  const uHasWork = (u) => (cfg.zeroRule === 'filas' ? (u.queues || []).some((q) => qShown(q) && qHasWork(q)) : (+u.count || 0) > 0);
  const uTotal = (u) => sumBy(u.queues, (q) => q.total);
  const qkey = (c, u, q) => c.label + '|' + u.label + '|' + q.title + '|' + q.n;
  const isFavQ = (c, u, q) => cfg.favQueues.includes(qkey(c, u, q));
  // Filas favoritas da unidade. Se houver alguma, a unidade aparece em "Favoritas" só com elas;
  // se não houver e a unidade for favorita, aparece com todas as filas.
  const favQsOf = (c, u) => (u.queues || []).filter((q) => isFavQ(c, u, q));
  const inFav = (c, u) => isFav(c, u) || favQsOf(c, u).length > 0;
  const deltaOf = (q) => {
    const prev = cfg.deltaBase === 'dia' ? q.prevDay : q.prevLast;
    if (prev === null || prev === undefined || q.total === null || q.total === undefined) return 0;
    return q.total - prev;
  };
  const deltaShown = (d) => cfg.showDelta && Math.abs(d) >= Math.max(1, +cfg.deltaMin || 1) && (d > 0 || cfg.showDecrease);
  const grew = (q) => cfg.showDelta && deltaOf(q) >= Math.max(1, +cfg.deltaMin || 1);
  const uDelta = (u) => sumBy((u.queues || []).filter(qShown), deltaOf);
  const deltaBadge = (d, since) => (deltaShown(d)
    ? `<span class="delta ${d > 0 ? 'up' : 'down'}" title="${d > 0 ? 'Aumentou' : 'Diminuiu'} ${Math.abs(d)} desde ${esc(since)}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`
    : '<span class="delta ghost">▲0</span>');
  const sinceText = (tree) => {
    const iso = cfg.deltaBase === 'dia' ? tree.baseUpdated : tree.prevUpdated;
    if (!iso) return cfg.deltaBase === 'dia' ? 'o dia anterior' : 'a leitura anterior';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };
  let SINCE = 'a leitura anterior';
  const visibleQueues = (u) => {
    let qs = (u.queues || []).filter((q) => qShown(q) && (cfg.zeros || qHasWork(q)));
    if (ui.onlyGrowth) qs = qs.filter(grew);
    if (cfg.queueSort === 'alfa') qs.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
    else if (cfg.queueSort === 'total') qs.sort((a, b) => (b.total || 0) - (a.total || 0));
    return qs;
  };
  // A Mesa lista todas as filas no mesmo nível, mas o Projudi as organiza em três tipos de conclusão, cada um
  // com subtipos: é o que mostra o seletor "Tipo de conclusão" da tela de Conclusões (colhido em 22/10/2026).
  // Fila fora desta lista fica no primeiro nível.
  const SUBFILAS = {
    'DECISÃO': ['ANÁLISE DE ALVARÁ', 'ARQUIVAMENTO', 'CUMPRIMENTO DE SENTENÇA', 'DECISÃO EM EMBARGOS DE DECLARAÇÃO', 'DECISÃO INICIAL',
      'DECISÃO SANEADORA', 'LEVANTAMENTO DE MEDIDA DE SEGURANÇA', 'PEDIDO DE URGÊNCIA', 'REJEIÇÃO DE DENÚNCIA', 'SAÍDA TEMPORÁRIA'],
    'DESPACHO': ['ANÁLISE DE PROVIMENTO DA CORREGEDORIA', 'ANÁLISE DE RECURSO', 'ANÁLISE DE RETORNO 2º GRAU',
      'AUTORIZAÇÃO DE DISTRIBUIÇÃO POR DEPENDÊNCIA', 'DILIGÊNCIA', 'EXECUÇÃO DE TÍTULO', 'RETORNO DA TURMA RECURSAL'],
    'SENTENÇA': ['ABSOLUTÓRIA', 'COM JULGAMENTO DE MÉRITO', 'CONDENATÓRIA', 'EMBARGOS DE DECLARAÇÃO', 'EXTINÇÃO COM JULGAMENTO',
      'EXTINÇÃO DA PUNIBILIDADE', 'EXTINÇÃO SEM JULGAMENTO', 'HOMOLOGATÓRIA DE ACORDO', 'HOMOLOGAÇÃO', 'HOMOLOGAÇÃO DE COMPOSIÇÃO CIVIL',
      'HOMOLOGAÇÃO DE MEDIDA SÓCIO-EDUCATIVA', 'HOMOLOGAÇÃO DE TRANSAÇÃO PENAL', 'HOMOLOGAÇÃO DECISÃO JUIZ LEIGO', 'IMPROCEDÊNCIA',
      'PROCEDÊNCIA', 'PROCEDÊNCIA PARCIAL', 'SEM JULGAMENTO DE MÉRITO', 'SENTENÇA DE ARQUIVAMENTO'],
  };
  const MAE_DE = {};
  for (const [mae, subs] of Object.entries(SUBFILAS)) for (const t of subs) MAE_DE[norm(t)] = mae;
  // Agrupa as filas exibidas sob a mãe, na posição em que a mãe (ou, sem ela, a primeira filha) aparece.
  // A mãe zerada ou oculta pelo filtro é buscada no mapeamento, para a subfila exibida ter onde se pendurar.
  const groupQueues = (u, qs) => {
    const items = [], grp = new Map();
    const slot = (t) => {
      const k = norm(t);
      if (!grp.has(k)) { const g = { title: t, mae: null, subs: [] }; grp.set(k, g); items.push(g); }
      return grp.get(k);
    };
    for (const q of qs) {
      const mae = MAE_DE[norm(q.title)];
      if (mae) slot(mae).subs.push(q);
      else if (SUBFILAS[q.title] && q.n === 1) slot(q.title).mae = q;
      else items.push({ q });
    }
    for (const g of grp.values()) {
      if (!g.mae) g.mae = (u.queues || []).find((x) => norm(x.title) === norm(g.title) && x.n === 1) || null;
    }
    return items;
  };
  const visibleUnits = (c) => {
    let us = (c.units || []).filter((u) => !isHidden(c, u) && (cfg.zeros || uHasWork(u)));
    if (ui.onlyFav) us = us.filter((u) => inFav(c, u));
    if (ui.onlyGrowth) us = us.filter((u) => (u.queues || []).some((q) => qShown(q) && grew(q)));
    if (cfg.unitSort === 'alfa') us = us.slice().sort((a, b) => nameOf(a.label).localeCompare(nameOf(b.label), 'pt-BR'));
    else if (cfg.unitSort === 'total') us = us.slice().sort((a, b) => uTotal(b) - uTotal(a));
    return us;
  };

  const host = document.createElement('div');
  host.id = 'pnr-host';
  host.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host{all:initial}
  *{box-sizing:border-box;font-family:Verdana,Arial,sans-serif}
  button{font-family:inherit}
  /* O rótulo da aba é uma imagem gerada em tempo real (ver tabLabel): texto girado por CSS fica deformado
     no Windows, sobretudo com escala de tela fracionária (ex.: 125%, 131%). */
  .tab{position:fixed;top:120px;background:#4e5f45;border:none;padding:8px 5px;line-height:0;font-size:0;
       cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,.35);touch-action:none;user-select:none}
  .tab canvas{display:block;pointer-events:none}
  .tab.right{right:0;border-radius:6px 0 0 6px}
  .tab.left{left:0;border-radius:0 6px 6px 0}
  .tab:hover{background:#3b4a33}
  .tab.ativa{background:#2f3b29;box-shadow:inset 0 0 0 2px rgba(255,255,255,.55)}
  .tab.dragging{cursor:grabbing;background:#3b4a33;box-shadow:0 2px 10px rgba(0,0,0,.45)}
  .panel{position:fixed;top:0;height:100vh;max-width:100vw;background:#fbfaf5;
         box-shadow:0 0 14px rgba(0,0,0,.25);display:none;flex-direction:column;font-size:12px;color:#222}
  .panel.right{right:0;border-left:3px solid #4e5f45}
  .panel.left{left:0;border-right:3px solid #4e5f45}
  .panel.on{display:flex}
  .grip{position:absolute;top:0;bottom:0;width:9px;cursor:ew-resize;z-index:5;touch-action:none}
  .panel.right .grip{left:-6px}
  .panel.left .grip{right:-6px}
  .grip:hover,.grip.drag{background:rgba(78,95,69,.35)}
  .panel.resizing{user-select:none}
  header{background:#4e5f45;color:#fff;padding:8px 10px;display:flex;align-items:center;gap:6px}
  header b{flex:1;font-size:12px;letter-spacing:.3px}
  header button{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:4px;cursor:pointer;font-size:12px;padding:2px 7px;line-height:1.2}
  header button:hover,header button.on{background:rgba(255,255,255,.18)}
  header button[hidden]{display:none}
  header button.save{background:#fff;color:#3b4a33;border-color:#fff;font-weight:bold}
  header button.save:hover{background:#e3edd9}
  .upd{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#3b4a33}
  .bar{padding:8px 10px;border-bottom:1px solid #ddd8c4;background:#f1eee1;display:flex;flex-direction:column;gap:6px}
  input[type=search]{width:100%;padding:6px 8px;border:1px solid #b9b39a;border-radius:4px;font-size:12px}
  .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .seg{display:inline-flex}
  .seg button{border:1px solid #4e5f45;background:#fff;color:#4e5f45;padding:3px 9px;font-size:11px;cursor:pointer}
  .seg button:first-child{border-radius:4px 0 0 4px}.seg button:last-child{border-radius:0 4px 4px 0}
  .seg button+button{border-left:none}
  .seg button.on{background:#4e5f45;color:#fff}
  .btn{border:1px solid #8a8466;background:#fff;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;color:#333}
  .btn:hover{background:#ece8d6}
  .btn.on{background:#4e5f45;color:#fff;border-color:#4e5f45}
  .btn:disabled{opacity:.5;cursor:default}
  .tools{display:flex;gap:4px;flex-wrap:wrap}
  .status{font-size:10px;color:#666;min-height:12px}
  .status.err{color:#b00020;font-weight:bold}
  .body{flex:1;overflow:auto;padding:6px 8px 20px}
  details{margin:2px 0}
  summary{cursor:pointer;padding:4px 4px;border-radius:3px;list-style:none;display:flex;align-items:center;gap:6px}
  summary::-webkit-details-marker{display:none}
  summary::before{content:'▸';color:#4e5f45;width:10px;flex:none}
  details[open]>summary::before{content:'▾'}
  summary:hover{background:#ece8d6}
  .comp>summary{font-weight:bold;color:#3b4a33;background:#e6e1cc}
  .comp.fav>summary{background:#efe3b8}
  .unit{margin-left:10px}
  .unit>summary .lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .unit>summary .lbl small{color:#888;font-size:9px;margin-right:4px}
  .star{border:none;background:none;cursor:pointer;font-size:13px;color:#b9b39a;padding:0 2px;flex:none;line-height:1}
  .star.on{color:#c9a227}
  .go{border:1px solid #4e5f45;color:#4e5f45;background:#fff;border-radius:3px;font-size:10px;padding:1px 6px;cursor:pointer;flex:none}
  .go:hover{background:#4e5f45;color:#fff}
  .go.upd{margin-right:3px;padding:1px 4px}
  .go:disabled{opacity:.4;cursor:default}
  .cnt{font-size:10px;color:#555;flex:none}
  .q{display:flex;align-items:center;gap:4px;margin-left:26px;padding:2px 4px;border-bottom:1px dotted #e0dcc8}
  .q .t{flex:1;cursor:pointer}
  .q .t:hover{text-decoration:underline}
  .chip{font-size:10px;border-radius:9px;padding:1px 7px;cursor:pointer;border:1px solid #bbb;background:#fff;min-width:32px;text-align:center;flex:none}
  .chip.total{border-color:#4e5f45;color:#3b4a33;font-weight:bold}
  .chip.red{border-color:#c62828;color:#c62828}
  .chip.assess{border-color:#8a8466;color:#6b6650}
  .chip.zero{opacity:.35}
  .chip.ghost{visibility:hidden}
  .chip:hover{filter:brightness(.9)}
  .delta{font-size:9px;font-weight:bold;min-width:30px;text-align:right;flex:none}
  .delta.up{color:#d35400}
  .delta.down{color:#2e7d32}
  .delta.ghost{visibility:hidden}
  .qstar{border:none;background:none;cursor:pointer;font-size:11px;color:#cfc9b0;padding:0 1px;flex:none;line-height:1}
  .qstar.on{color:#c9a227}
  .q .t small{color:#888;font-size:9px;margin-left:4px}
  .abtn{border:1px solid #cfc9b0;background:#fff;color:#6b6650;border-radius:3px;font-size:10px;line-height:1;padding:1px 4px;cursor:pointer;flex:none}
  .abtn:hover,.abtn.on{background:#4e5f45;border-color:#4e5f45;color:#fff}
  .sbtn{border:1px solid #b9b39a;background:#f1eee1;color:#3b4a33;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;cursor:pointer;flex:none}
  .sbtn:hover,.sbtn.on{background:#4e5f45;border-color:#4e5f45;color:#fff}
  .subs .q{margin-left:42px;background:#faf8f0}
  .subs .q.sub{margin-left:60px}
  .q.sub{margin-left:44px;background:#f6f4ea;cursor:pointer;border-bottom:1px dotted #e6e1cc}
  .q.sub:hover{background:#e3edd9}
  .q.sub .t{font-size:11px}
  .q.sub.info{cursor:default;color:#777;font-size:10px}
  .q.sub.info:hover{background:#f6f4ea}
  .q.sub.err{color:#b00020}
  .cfg textarea{width:100%;min-height:110px;font:11px Consolas,monospace;padding:4px;border:1px solid #b9b39a;border-radius:3px}
  .res{padding:4px 6px;border-radius:4px;display:flex;gap:6px;align-items:center;cursor:pointer}
  .res.sel,.res:hover{background:#e3edd9}
  .res .p{flex:1;min-width:0}
  .res small{display:block;color:#777;font-size:10px}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{background:#4e5f45;color:#fff;padding:4px;text-align:left;cursor:pointer;white-space:nowrap}
  th.n{text-align:right}
  td{padding:3px 4px;border-bottom:1px solid #e4e0cd;vertical-align:top}
  td.n{text-align:right;font-variant-numeric:tabular-nums}
  tr.click:hover td{background:#e3edd9;cursor:pointer}
  tr.sum td{background:#eeeadb;font-weight:bold}
  .qsec{margin:0 0 14px}
  .qsec h4{margin:8px 0 4px;color:#3b4a33;font-size:11px;display:flex;gap:6px;align-items:center}
  .qsec h4 span{flex:1}
  select{font-size:11px;padding:3px;border:1px solid #b9b39a;border-radius:4px;max-width:100%}
  .empty{color:#666;padding:16px 8px;line-height:1.5}
  .toast{position:fixed;bottom:16px;right:16px;background:#333;color:#fff;padding:8px 12px;border-radius:5px;font-size:12px;display:none;max-width:380px}
  .toast.on{display:block}
  /* configurações */
  .cfg{display:flex;flex-direction:column;gap:12px}
  .cfg fieldset{border:1px solid #ddd8c4;border-radius:5px;padding:8px 10px;margin:0;display:flex;flex-direction:column;gap:7px}
  .cfg legend{font-weight:bold;color:#3b4a33;font-size:11px;padding:0 4px}
  .cfg label{display:flex;gap:6px;align-items:center;font-size:11px}
  .cfg label.col{flex-direction:column;align-items:stretch;gap:3px}
  .cfg .hint{font-size:10px;color:#777;line-height:1.4}
  .cfg .units{max-height:220px;overflow:auto;border:1px solid #eee9d6;border-radius:4px;padding:4px}
  .cfg .units div{display:flex;gap:6px;align-items:center;font-size:10px;padding:2px 0}
  .cfg .units div span{flex:1}
  .cfg .foot{display:flex;gap:8px;justify-content:space-between}
  .cfg .hit{background:#fff4c2;border-radius:3px;box-shadow:0 0 0 2px #fff4c2}
  .cfgq-info{font-size:10px;color:#666;min-height:12px}
  .cfgq-info.err{color:#b00020}
  input[type=number],input[type=text].k{width:60px;font-size:11px;padding:2px 4px;border:1px solid #b9b39a;border-radius:3px}
</style>
<button class="tab" data-a="tab"></button>
<div class="panel">
  <div class="grip" title="Arraste para ajustar a largura. Clique duas vezes para recolher o painel."></div>
  <header>
    <b>Painel de Navegação - Projudi</b>
    <button data-a="cfg" title="Configurações">⚙</button>
    <button data-a="close" title="Fechar (Esc)">✕</button>
    <button class="save" data-a="cfgsave" data-cfgbtn hidden title="Salvar as configurações e voltar ao painel">Salvar</button>
    <button data-a="cfgback" data-cfgbtn hidden title="Descartar as alterações feitas nesta tela e voltar ao painel">Voltar</button>
  </header>
  <div class="bar main-bar">
    <input type="search" placeholder="Buscar unidade ou fila (ex.: 3a unid decisão)" />
    <div class="row">
      <span class="seg"><button data-v="arvore">Árvore</button><button data-v="quadro">Quadro por unidade</button></span>
      <span class="upd">Atualizar:<span class="seg"><button data-a="crawl" data-mode="parcial" title="Mais rápida: relê só as unidades que tinham filas com processos na última leitura. Unidades zeradas e unidades novas não são lidas.">Parcial</button><button data-a="crawl" data-mode="total" title="Percorre novamente todas as unidades e lê todas as filas">Total</button></span></span>
    </div>
    <div class="row tools" data-tools="arvore">
      <button class="btn" data-t="expand" title="Expandir todas as unidades">Expandir tudo</button>
      <button class="btn" data-t="collapse" title="Recolher tudo">Recolher tudo</button>
      <button class="btn" data-t="comps" title="Mostrar só as unidades, sem as filas">Só unidades</button>
      <button class="btn" data-t="fav" title="Mostrar apenas unidades favoritas">★ Favoritas</button>
      <button class="btn" data-t="zeros" title="Mostrar unidades e filas sem processos">Zeradas</button>
      <button class="btn" data-t="growth" title="Mostrar só filas que aumentaram">▲ Cresceram</button>
    </div>
    <div class="status"></div>
  </div>
  <div class="bar cfg-bar" style="display:none">
    <input type="search" data-a="cfgq" placeholder="Buscar nas configurações (ex.: assessor, largura, zeradas)" title="Filtra as opções pelo termo. Esc limpa a busca." />
    <div class="cfgq-info"></div>
  </div>
  <div class="body"></div>
</div>
<div class="toast"></div>`;

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel'), body = $('.body'), search = $('.main-bar input[type=search]'), cfgQ = $('input[data-a=cfgq]'), cfgQInfo = $('.cfgq-info'), statusEl = $('.status'), tab = $('.tab'), grip = $('.grip');
  /* Abas dos painéis do Projudi (Navegação e Agrupadores) — trecho IDÊNTICO nos dois scripts. Um só lado, as abas
   * empilhadas como as de um mesmo conjunto e encostadas na borda do painel aberto; abrir uma fecha a outra; o
   * arraste de qualquer uma move o par. Clique fora dos painéis ou Esc fecham o que estiver aberto (os outros
   * quadros da página avisam por mensagem: ver avisarFechamentoDosPaineis). Lado e posição em localStorage (mesma
   * origem); a coordenação entre os dois scripts, que rodam na mesma página, pelo objeto window.__projudiAbas.
   * Decisões dele, 17/10/2026. */
  function abasDoProjudi(membro) {
    const K_LADO = 'projudi.abas.lado', K_TOPO = 'projudi.abas.topo';
    const ler = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } };
    const gravar = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) { /* ignora */ } };
    const g = window.__projudiAbas || (window.__projudiAbas = { membros: [] });
    const outros = [];
    for (const m of g.membros) if (m.id !== membro.id) outros.push(m);
    outros.push(membro);
    outros.sort((a, b) => a.ordem - b.ordem);
    g.membros = outros;
    if (!g.fechamento) {
      // Uma vez por página, qualquer que seja o script que chegue primeiro.
      g.fechamento = true;
      const fecharTodos = () => { for (const m of g.membros) if (m.aberto()) m.fechar(); };
      const dentro = (e) => {
        const caminho = e.composedPath ? e.composedPath() : [];
        for (const m of g.membros) if (caminho.indexOf(m.host) >= 0) return true;
        return false;
      };
      document.addEventListener('pointerdown', (e) => { if (!dentro(e)) fecharTodos(); }, true);
      // Esc: o que o painel já tratou (limpar a busca) chega com defaultPrevented; o resto fecha.
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) fecharTodos(); });
      window.addEventListener('message', (e) => {
        if (e.origin === location.origin && e.data && e.data.projudiAbas === 'fechar') fecharTodos();
      });
    }
    const lado = () => (ler(K_LADO, 'right') === 'left' ? 'left' : 'right');
    const topoSalvo = () => { const v = +ler(K_TOPO, 120); return Number.isFinite(v) ? v : 120; };
    const topoAtual = () => { const t = parseInt(g.membros[0].tab.style.top, 10); return Number.isFinite(t) ? t : topoSalvo(); };
    function posicionar(topo) {
      let alt = 0;
      for (const m of g.membros) alt += (m.tab.offsetHeight || 0) + 2;
      let y = Math.round(Math.min(Math.max(0, window.innerHeight - alt), Math.max(0, topo === undefined ? topoSalvo() : topo)));
      let aberto = null;
      for (const m of g.membros) if (!aberto && m.aberto()) aberto = m;
      const desloc = aberto ? Math.round(aberto.largura()) : 0;
      const l = lado();
      for (const m of g.membros) {
        m.tab.style.top = y + 'px';
        m.tab.style.left = l === 'left' ? desloc + 'px' : '';
        m.tab.style.right = l === 'right' ? desloc + 'px' : '';
        m.tab.classList.toggle('ativa', m === aberto);
        y += (m.tab.offsetHeight || 0) + 2;
      }
    }
    return {
      lado,
      topoAtual,
      posicionar,
      salvar() { gravar(K_TOPO, topoAtual()); posicionar(); },
      definirLado(v) { gravar(K_LADO, v === 'left' ? 'left' : 'right'); for (const m of g.membros) m.aplicar(); },
      abriu() { for (const m of g.membros) if (m !== membro && m.aberto()) m.fechar(); posicionar(); },
      fechou() { posicionar(); },
    };
  }
  const abas = abasDoProjudi({ id: 'navegacao', ordem: 1, tab, host, aberto: () => panel.classList.contains('on'),
    largura: () => panel.getBoundingClientRect().width, fechar: () => toggle(false), aplicar: () => applyLayout() });

  let showingCfg = false;

  function setStatus(msg, err) { statusEl.textContent = msg || ''; statusEl.classList.toggle('err', !!err); }
  function toast(msg) { const t = $('.toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 6000); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v) => (v === null || v === undefined ? '' : String(v));

  function applyLayout() {
    const side = abas.lado();
    panel.classList.remove('left', 'right'); panel.classList.add(side);
    tab.classList.remove('left', 'right'); tab.classList.add(side);
    const z = Math.max(0.75, Math.min(1.5, (+cfg.fontSize || 12) / 12));
    panel.style.zoom = z;
    panel.style.width = Math.round(panelWidth() / z) + 'px';
    panel.style.height = Math.round(100 / z) + 'vh';
    tabLabel('NAVEGAR');
    tab.title = 'Painel de Navegação · atalho Alt+' + (cfg.hotkey || 'J').toUpperCase() + '. Arraste para cima ou para baixo para mover as abas.';
    placeTab();
  }

  // Rótulo da aba: o texto é desenhado na horizontal (com o ajuste fino normal das letras), na resolução
  // real da tela, e a imagem pronta é girada 90° (giro que apenas reposiciona pixels, sem perda de nitidez).
  let tabText = '', tabDpr = 0;
  function tabLabel(text) {
    const dpr = window.devicePixelRatio || 1;
    if (text === tabText && dpr === tabDpr) return;
    tabText = text; tabDpr = dpr;
    const font = 'bold 11px Verdana, Tahoma, "Segoe UI", Arial, sans-serif';
    const setup = (c) => { c.font = font; if ('letterSpacing' in c) c.letterSpacing = '0.5px'; };
    const m = document.createElement('canvas').getContext('2d');
    setup(m);
    const W = Math.ceil(Math.ceil(m.measureText(text).width) * dpr), H = Math.ceil(13 * dpr);
    const hc = document.createElement('canvas');
    hc.width = W; hc.height = H;
    const c = hc.getContext('2d');
    c.scale(dpr, dpr); setup(c);
    c.fillStyle = '#fff';
    c.fillText(text, 0, Math.round(10 * dpr) / dpr);
    const rc = document.createElement('canvas');
    rc.width = H; rc.height = W;
    const r = rc.getContext('2d');
    r.translate(0, W); r.rotate(-Math.PI / 2); r.drawImage(hc, 0, 0);
    rc.style.width = (H / dpr) + 'px';
    rc.style.height = (W / dpr) + 'px';
    tab.replaceChildren(rc);
    tab.setAttribute('aria-label', text);
  }

  // Posição vertical: a do conjunto de abas (abasDoProjudi), sempre dentro da janela.
  function placeTab() { abas.posicionar(); }

  // Largura efetiva: a ajustada pelo arraste na borda (ui.panelW), limitada à largura das configurações.
  const PANEL_MIN = 260;
  const maxWidth = () => Math.max(PANEL_MIN, +cfg.width || 460);
  const panelWidth = () => {
    const w = +ui.panelW || 0;
    return w ? Math.max(PANEL_MIN, Math.min(maxWidth(), w)) : maxWidth();
  };

  function defaultOpen(key) {
    if (cfg.treeOpen === 'tudo') return true;
    if (cfg.treeOpen === 'nada') return false;
    if (key.startsWith('s:')) return false; // subfilas: recolhidas até o clique em ▸
    const isUnit = key.startsWith('u:') || key.startsWith('f:');
    if (cfg.treeOpen === 'competencias') return !isUnit;
    return !isUnit; // "lembrar": na primeira vez, grupos abertos e unidades recolhidas
  }
  const isOpen = (key) => (key in ui.open ? !!ui.open[key] : defaultOpen(key));

  function toggle(force) {
    const on = force !== undefined ? force : !panel.classList.contains('on');
    panel.classList.toggle('on', on);
    if (on) abas.abriu(); else abas.fechou();
    if (!on) return;
    if (cfg.treeOpen !== 'lembrar') { ui.open = {}; saveUi(); }
    if (cfg.view !== 'ultima') { ui.view = cfg.view; }
    showingCfg = false;
    render();
    restoreScroll();
    setTimeout(() => search.focus({ preventScroll: true }), 30);
    const tree = lsGet(LS_TREE, null);
    const min = +cfg.autoRefreshMin || 0;
    if (min > 0 && (!tree || Date.now() - new Date(tree.updated).getTime() > min * 60000)) doCrawl('total');
  }

  function chips(c, u, q) {
    const mk = (kind, v, tip, on) => {
      if (!on) return '';
      if (v === null) return '<span class="chip ghost">0</span>';
      const ghost = cfg.hideZeroChips && v === 0;
      return `<span class="chip ${kind}${v === 0 ? ' zero' : ''}${ghost ? ' ghost' : ''}" data-go="${kind}" data-c="${esc(c.label)}" data-u="${esc(u.label)}" data-q="${esc(q.title)}" data-n="${q.n}" title="${tip}">${v}</span>`;
    };
    return mk('total', q.total, 'Total da fila', cfg.showTotal) + mk('red', q.red, 'Contador em vermelho do Projudi', cfg.showRed) + mk('assess', q.assess, 'Assessoria', cfg.showAssess);
  }

  function statusLine(tree) {
    if (!tree) return 'Sem mapeamento. Clique em "Atualizar: Total".';
    const d = new Date(tree.updated);
    let txt = 'Dados de ' + d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      + (tree.mode === 'parcial' ? ' (atualização parcial' + (typeof tree.nRead === 'number' ? ': ' + tree.nRead + (tree.nRead === 1 ? ' unidade' : ' unidades') : '') + ')' : '') + '.';
    if (tree.unitUpdate) {
      const du = new Date(tree.unitUpdate.ts);
      txt += ' ' + nameOf(tree.unitUpdate.u) + ' relida em ' + du.toLocaleDateString('pt-BR') + ' às ' + du.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '.';
    }
    if (cfg.showDelta && Array.isArray(tree.comps)) {
      let n = 0;
      for (const c of tree.comps) for (const u of c.units || []) if (!isHidden(c, u)) for (const q of u.queues || []) if (qShown(q) && grew(q)) n++;
      txt += n ? ' ' + n + (n === 1 ? ' fila aumentou' : ' filas aumentaram') + ' desde ' + sinceText(tree) + '.' : ' Nenhuma fila aumentou desde ' + sinceText(tree) + '.';
    }
    return txt;
  }

  let results = [], sel = 0;

  // Rolagem do painel: gravada por vista (árvore ou quadro) e restaurada ao reabrir.
  let scrollTimer = null;
  function restoreScroll() {
    const y = +ui.scroll[ui.view] || 0;
    requestAnimationFrame(() => { body.scrollTop = y; });
  }

  function syncBar() {
    root.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === ui.view));
    root.querySelector('[data-tools]').hidden = ui.view !== 'arvore' || showingCfg;
    root.querySelector('.main-bar').style.display = showingCfg ? 'none' : '';
    root.querySelector('.cfg-bar').style.display = showingCfg ? '' : 'none';
    root.querySelector('[data-t=fav]').classList.toggle('on', !!ui.onlyFav);
    root.querySelector('[data-t=zeros]').classList.toggle('on', !!cfg.zeros);
    root.querySelector('[data-t=growth]').classList.toggle('on', !!ui.onlyGrowth);
    root.querySelector('[data-t=growth]').hidden = !cfg.showDelta;
    root.querySelector('[data-a=cfg]').classList.toggle('on', showingCfg);
    root.querySelectorAll('[data-cfgbtn]').forEach((b) => { b.hidden = !showingCfg; });
  }

  function render() {
    syncBar();
    if (showingCfg) return renderCfg();
    const tree = lsGet(LS_TREE, null);
    if (tree) SINCE = sinceText(tree);
    if (!statusEl.classList.contains('err') && !busy) setStatus(statusLine(tree));
    if (!tree || !Array.isArray(tree.comps) || !tree.comps.length) {
      body.innerHTML = '<div class="empty">Ainda não há mapeamento das unidades.<br><br>Clique em <b>Atualizar: Total</b>. O script percorrerá, em sequência, as competências e unidades às quais o senhor tem acesso, lerá as filas e, ao final, restaurará a Atuação atual.<br><br>Evite usar o Projudi em outra aba durante essa leitura.</div>';
      return;
    }
    const qy = norm(search.value);
    if (qy) return renderSearch(tree, qy);
    return ui.view === 'quadro' ? renderQuadro(tree) : renderTree(tree);
  }

  // Submenu de assessores (sob demanda): chave da fila -> { list, total, ts } ou { loading } ou { error }.
  const assOpen = new Set();
  const assData = new Map();
  function assessorRows(c, u, q) {
    const k = qkey(c, u, q);
    const d = assData.get(k);
    const attrs = `data-c="${esc(c.label)}" data-u="${esc(u.label)}" data-q="${esc(q.title)}" data-n="${q.n}"`;
    if (!d || d.loading) return '<div class="q sub info">Lendo as minutas concluídas por assessor...</div>';
    if (d.error) return `<div class="q sub info err">${esc(d.error)} <button class="abtn" data-ass="${esc(k)}" data-reload="1" ${attrs}>tentar de novo</button></div>`;
    const hora = new Date(d.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    let h = d.list.length
      ? d.list.map((a) => `<div class="q sub" data-go="total" data-login="${esc(a.login)}" ${attrs} title="Abrir a fila filtrada pelas minutas concluídas de ${esc(a.name)} (${esc(a.login)})"><span class="t">${esc(a.name)}</span><span class="chip total">${a.n}</span></div>`).join('')
      : '<div class="q sub info">Nenhuma minuta concluída nesta fila.</div>';
    h += `<div class="q sub info"><span class="t">${d.total} concluída(s), lidas às ${hora}</span><button class="abtn" data-ass="${esc(k)}" data-reload="1" ${attrs} title="Ler novamente">atualizar</button></div>`;
    return h;
  }

  function queueRow(c, u, q, showUnit, after) {
    const fq = isFavQ(c, u, q);
    const k = qkey(c, u, q);
    const open = cfg.assessorMenu && assOpen.has(k);
    return `<div class="q"><button class="qstar${fq ? ' on' : ''}" data-favq="${esc(k)}" title="${fq ? 'Remover das filas favoritas' : 'Marcar fila como favorita'}">${fq ? '★' : '☆'}</button>`
      + `<span class="t" data-go="${cfg.titleClick}" data-c="${esc(c.label)}" data-u="${esc(u.label)}" data-q="${esc(q.title)}" data-n="${q.n}">${esc(q.title)}${showUnit ? '<small>' + esc(nameOf(u.label)) + '</small>' : ''}</span>`
      + (after || '')
      + (!cfg.assessorMenu ? '' : `<button class="abtn${open ? ' on' : ''}" data-ass="${esc(k)}" data-c="${esc(c.label)}" data-u="${esc(u.label)}" data-q="${esc(q.title)}" data-n="${q.n}" title="Minutas concluídas por assessor">≡</button>`)
      + (cfg.showDelta ? deltaBadge(deltaOf(q), SINCE) : '') + chips(c, u, q) + '</div>'
      + (open ? assessorRows(c, u, q) : '');
  }

  // Fila-mãe com o botão que exibe ou recolhe as subfilas. Com "▲ Cresceram" ligado, as subfilas já vêm abertas,
  // porque o filtro só deixa na lista o que o usuário quer ver.
  function groupRows(c, u, g) {
    if (!g.subs.length) return g.mae ? queueRow(c, u, g.mae, false) : '';
    const k = 's:' + ukey(c, u) + '|' + norm(g.title);
    const open = ui.onlyGrowth || isOpen(k);
    const n = g.subs.length, tot = sumBy(g.subs, (q) => q.total);
    const tip = `${n} ${n === 1 ? 'subfila' : 'subfilas'} com ${tot} ${tot === 1 ? 'processo' : 'processos'}: `
      + (n ? g.subs.map((q) => q.title).join(', ') : '') + '. Clique para ' + (open ? 'recolher.' : 'exibir.');
    const tg = `<button class="sbtn${open ? ' on' : ''}" data-grp="${esc(k)}" title="${esc(tip)}">${open ? '▾' : '▸'} ${n}</button>`;
    const head = g.mae ? queueRow(c, u, g.mae, false, tg)
      : `<div class="q"><span class="qstar"></span><span class="t" style="cursor:default;text-decoration:none">${esc(g.title)}</span>${tg}</div>`;
    return head + (open ? '<div class="subs">' + g.subs.map((q) => queueRow(c, u, q, false)).join('') + '</div>' : '');
  }

  async function toggleAssessores(el) {
    const k = el.dataset.ass;
    const reload = !!el.dataset.reload;
    if (!reload && assOpen.has(k)) { assOpen.delete(k); return render(); }
    assOpen.add(k);
    const d = assData.get(k);
    if (d && !reload && !d.error) return render();
    if (busy) { toast('Aguarde a leitura em andamento terminar.'); if (!d) assOpen.delete(k); return render(); }
    const tree = lsGet(LS_TREE, null);
    const c = tree && (tree.comps || []).find((x) => x.label === el.dataset.c);
    const u = c && (c.units || []).find((x) => x.label === el.dataset.u);
    const q = u && (u.queues || []).find((x) => x.title === el.dataset.q && String(x.n) === String(el.dataset.n));
    if (!q) { assData.set(k, { error: 'Fila não encontrada no mapeamento. Atualize os dados.' }); return render(); }
    assData.set(k, { loading: true });
    render();
    busy = true;
    root.querySelectorAll('button[data-a=crawl]').forEach((b) => { b.disabled = true; });
    try {
      assData.set(k, await readAssessores(c, u, q, (m) => setStatus(m)));
      busy = false;
      setStatus(statusLine(lsGet(LS_TREE, null)));
    } catch (e) {
      busy = false;
      assData.set(k, { error: e.message });
      setStatus(e.message, true);
    } finally {
      busy = false;
      root.querySelectorAll('button[data-a=crawl]').forEach((b) => { b.disabled = false; });
      if (!showingCfg) render();
    }
  }

  function unitBlock(c, u, showComp) {
    // No grupo Favoritas a unidade tem chave própria, para abrir e fechar independentemente do galho original.
    const k = (showComp ? 'f:' : 'u:') + ukey(c, u);
    let qs = visibleQueues(u);
    const favMode = showComp || ui.onlyFav;
    const onlyFavQs = favMode && favQsOf(c, u).length > 0;
    if (onlyFavQs) qs = qs.filter((q) => isFavQ(c, u, q));
    const fav = isFav(c, u);
    let h = `<details class="unit" data-k="${esc(k)}" ${isOpen(k) ? 'open' : ''}><summary>`
      + `<button class="star${fav ? ' on' : ''}" data-fav="${esc(ukey(c, u))}" title="${fav ? 'Remover das favoritas' : 'Marcar como favorita'}">${fav ? '★' : '☆'}</button>`
      + `<span class="lbl" title="${esc(u.label)}">${showComp ? '<small>' + esc(compName(c)) + '</small>' : ''}${esc(nameOf(u.label))}</span>`
      + (cfg.showDelta ? deltaBadge(uDelta(u), SINCE) : '')
      + `<span class="cnt">(${u.count})</span><button class="go upd" data-upd="1" data-c="${esc(c.label)}" data-u="${esc(u.label)}" title="Atualizar só esta unidade">⟳</button><button class="go" data-mesa="1" data-c="${esc(c.label)}" data-u="${esc(u.label)}" title="Abrir a mesa da unidade">mesa</button></summary>`;
    if (u.error) h += `<div class="q" style="color:#b00020">${esc(u.error)}</div>`;
    // Filas favoritas escolhidas uma a uma ficam sem galhos: cada uma já foi marcada pelo usuário.
    if (onlyFavQs) for (const q of qs) h += queueRow(c, u, q, false);
    else for (const it of groupQueues(u, qs)) h += it.q ? queueRow(c, u, it.q, false) : groupRows(c, u, it);
    if (!qs.length && !u.error) h += `<div class="q" style="color:#888">${onlyFavQs ? 'Nenhuma fila favorita com processos.' : 'Nenhuma fila com processos.'}</div>`;
    return h + '</details>';
  }

  function renderTree(tree) {
    let h = '';
    const favPairs = [];
    if (cfg.favoritesOnTop && !ui.onlyFav) {
      for (const c of tree.comps) for (const u of c.units || []) if (inFav(c, u) && !isHidden(c, u)) favPairs.push([c, u]);
      if (favPairs.length) {
        h += `<details class="comp fav" data-k="c:★" ${isOpen('c:★') ? 'open' : ''}><summary>★ FAVORITAS <span class="cnt">(${favPairs.length})</span></summary>`;
        for (const [c, u] of favPairs) h += unitBlock(c, u, true);
        h += '</details>';
      }
    }
    for (const c of tree.comps) {
      const us = visibleUnits(c);
      if (!us.length) continue;
      const k = 'c:' + c.label;
      // Total do cabeçalho: soma dos contadores das unidades exibidas (e não o contador do Projudi para o grupo).
      const cTot = sumBy(us, (u) => u.count);
      h += `<details class="comp" data-k="${esc(k)}" ${isOpen(k) ? 'open' : ''}><summary>${esc(compName(c))} <span class="cnt" title="Soma das unidades exibidas">(${cTot})</span></summary>`;
      for (const u of us) h += unitBlock(c, u, false);
      h += '</details>';
    }
    body.innerHTML = h || `<div class="empty">Nenhuma unidade para exibir com os filtros atuais.${ui.onlyGrowth ? ' Nenhuma fila aumentou desde ' + esc(SINCE) + '.' : ui.onlyFav ? ' Marque unidades ou filas com ☆ para vê-las em "Favoritas".' : ' Ative "Zeradas" para ver unidades sem processos.'}</div>`;
  }

  function renderSearch(tree, qy) {
    const toks = qy.split(' ').filter(Boolean);
    results = [];
    for (const c of tree.comps) for (const u of c.units || []) {
      if (isHidden(c, u)) continue;
      const base = norm(compName(c) + ' ' + u.label + ' ' + short(u.label));
      if (toks.every((t) => base.includes(t))) results.push({ c, u, fav: isFav(c, u) });
      for (const q of u.queues || []) {
        if (!qShown(q) || (!cfg.zeros && !qHasWork(q))) continue;
        const hay = base + ' ' + norm(q.title);
        if (toks.every((t) => hay.includes(t))) results.push({ c, u, q, fav: isFav(c, u) || isFavQ(c, u, q) });
      }
    }
    results.sort((a, b) => (b.fav - a.fav));
    results = results.slice(0, 150);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    body.innerHTML = results.length
      ? results.map((r, i) => `<div class="res${i === sel ? ' sel' : ''}" data-i="${i}"><div class="p">${r.q ? esc(r.q.title) : '<b>Mesa da unidade</b>'}<small>${r.fav ? '★ ' : ''}${esc(compName(r.c))} › ${esc(nameOf(r.u.label))}</small></div>${r.q && cfg.showDelta ? deltaBadge(deltaOf(r.q), SINCE) : ''}${r.q ? chips(r.c, r.u, r.q) : ''}</div>`).join('')
      : '<div class="empty">Nada encontrado. Enter abre o item selecionado; as setas mudam a seleção.</div>';
  }

  function renderQuadro(tree) {
    const pairs = [];
    for (const c of tree.comps) for (const u of visibleUnits(c)) pairs.push([c, u]);
    if (!pairs.length) { body.innerHTML = '<div class="empty">Nenhuma unidade para exibir com os filtros atuais.</div>'; return; }
    if (ui.qunit && !pairs.some(([c, u]) => ukey(c, u) === ui.qunit)) ui.qunit = '';
    let h = '<div class="row" style="margin:4px 0 8px"><select id="qunit" data-a="qunit"><option value="">Todas as unidades (uma tabela por unidade)</option>'
      + pairs.map(([c, u]) => `<option value="${esc(ukey(c, u))}" ${ui.qunit === ukey(c, u) ? 'selected' : ''}>${isFav(c, u) ? '★ ' : ''}${esc(compName(c))} › ${esc(nameOf(u.label))}</option>`).join('')
      + '</select></div>';
    const s = ui.sort;
    const arrow = (k) => (s.k === k ? (s.d > 0 ? ' ▲' : ' ▼') : '');
    const cols = [['fila', 'Fila', ''], ['total', 'Total', 'n', cfg.showTotal], ['delta', 'Var.', 'n', cfg.showDelta], ['red', 'Verm.', 'n', cfg.showRed], ['assess', 'Assess.', 'n', cfg.showAssess]]
      .filter((x) => x[3] !== false);
    for (const [c, u] of pairs) {
      if (ui.qunit && ukey(c, u) !== ui.qunit) continue;
      const qs = visibleQueues(u).slice();
      const val = (q) => (s.k === 'fila' ? q.title : s.k === 'delta' ? deltaOf(q) : (q[s.k] || 0));
      qs.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * s.d; });
      const sum = (k) => sumBy(qs, (q) => (k === 'delta' ? deltaOf(q) : q[k]));
      const fmtD = (d) => (d > 0 ? '<span class="delta up">▲' + d + '</span>' : d < 0 ? '<span class="delta down">▼' + (-d) + '</span>' : '0');
      h += `<div class="qsec"><h4><span title="${esc(u.label)}">${esc(compName(c))} › ${esc(nameOf(u.label))}</span><button class="go upd" data-upd="1" data-c="${esc(c.label)}" data-u="${esc(u.label)}" title="Atualizar só esta unidade">⟳</button><button class="go" data-mesa="1" data-c="${esc(c.label)}" data-u="${esc(u.label)}">mesa</button></h4>`;
      if (!qs.length) { h += '<div class="empty" style="padding:4px 0">Nenhuma fila com processos.</div></div>'; continue; }
      h += '<table><tr>' + cols.map(([k, t, cl]) => `<th data-s="${k}" class="${cl}">${t}${arrow(k)}</th>`).join('') + '</tr>';
      h += qs.map((q) => `<tr class="click" data-go="${cfg.titleClick}" data-c="${esc(c.label)}" data-u="${esc(u.label)}" data-q="${esc(q.title)}" data-n="${q.n}">`
        + cols.map(([k]) => (k === 'fila' ? `<td>${isFavQ(c, u, q) ? '★ ' : ''}${esc(q.title)}</td>` : k === 'delta' ? `<td class="n">${fmtD(deltaOf(q))}</td>` : `<td class="n">${k === 'total' ? '<b>' + num(q[k]) + '</b>' : num(q[k])}</td>`)).join('') + '</tr>').join('');
      h += '<tr class="sum">' + cols.map(([k]) => (k === 'fila' ? '<td>Total da unidade</td>' : k === 'delta' ? `<td class="n">${fmtD(sum(k))}</td>` : `<td class="n">${sum(k)}</td>`)).join('') + '</tr></table></div>';
    }
    body.innerHTML = h;
  }

  /* ------------------------------------------------------------ configurações */
  function renderCfg() {
    setStatus('');
    const tree = lsGet(LS_TREE, null);
    const opt = (v, cur, t) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${t}</option>`;
    const chk = (k, t) => `<label><input type="checkbox" data-c="${k}" ${cfg[k] ? 'checked' : ''}> ${t}</label>`;
    let unitsHtml = '<div class="hint">Faça o primeiro mapeamento para listar as unidades.</div>';
    if (tree && Array.isArray(tree.comps)) {
      unitsHtml = '<div class="units">' + tree.comps.map((c) => (c.units || []).map((u) => {
        const k = ukey(c, u);
        return `<div><input type="checkbox" data-show="${esc(k)}" ${cfg.hidden.includes(k) ? '' : 'checked'} title="Exibir"><button class="star${cfg.favorites.includes(k) ? ' on' : ''}" data-fav="${esc(k)}" title="Favorita">${cfg.favorites.includes(k) ? '★' : '☆'}</button><span title="${esc(u.label)}">${esc(compName(c))} › ${esc(short(u.label))}</span></div>`;
      }).join('')).join('') + '</div>';
    }
    let queuesHtml = '<div class="hint">Faça o primeiro mapeamento para listar as filas.</div>';
    if (tree && Array.isArray(tree.comps)) {
      const titles = [...new Set(tree.comps.flatMap((c) => (c.units || []).flatMap((u) => (u.queues || []).map((q) => q.title))).concat(cfg.hiddenQueues))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      queuesHtml = '<div class="units">' + titles.map((t) => `<div><input type="checkbox" data-showq="${esc(t)}" ${cfg.hiddenQueues.includes(t) ? '' : 'checked'}><span>${esc(t)}</span></div>`).join('') + '</div>';
    }
    body.innerHTML = `<div class="cfg">
  <fieldset><legend>Ao abrir o painel</legend>
    <label class="col">Vista inicial<select data-c="view">${opt('arvore', cfg.view, 'Árvore')}${opt('quadro', cfg.view, 'Quadro por unidade')}${opt('ultima', cfg.view, 'Última usada')}</select></label>
    <label class="col">Estado da árvore<select data-c="treeOpen">${opt('lembrar', cfg.treeOpen, 'Lembrar como deixei')}${opt('tudo', cfg.treeOpen, 'Tudo expandido')}${opt('competencias', cfg.treeOpen, 'Só competências abertas (unidades recolhidas)')}${opt('nada', cfg.treeOpen, 'Tudo recolhido')}</select></label>
    <label class="col">Atualizar dados automaticamente<select data-c="autoRefreshMin">${opt(0, cfg.autoRefreshMin, 'Nunca (só pelo botão)')}${opt(15, cfg.autoRefreshMin, 'Se tiverem mais de 15 min')}${opt(60, cfg.autoRefreshMin, 'Se tiverem mais de 1 hora')}${opt(240, cfg.autoRefreshMin, 'Se tiverem mais de 4 horas')}</select></label>
    ${chk('crawlZeros', 'Ler também comarcas, competências e unidades sem conclusões (mais lento)')}
    <div class="hint">A atualização automática é sempre total. A atualização percorre as unidades e troca a Atuação temporariamente; ao final, a Atuação original é restaurada.</div>
  </fieldset>
  <fieldset><legend>O que exibir</legend>
    ${chk('zeros', 'Mostrar unidades e filas zeradas')}
    <label class="col">Considerar unidade zerada quando<select data-c="zeroRule">${opt('conclusoes', cfg.zeroRule, 'Não há conclusões (contador da unidade igual a 0)')}${opt('filas', cfg.zeroRule, 'Nenhuma fila exibida tem processos')}</select></label>
    ${chk('showTotal', 'Contador total')}
    ${chk('showRed', 'Contador em vermelho')}
    ${chk('showAssess', 'Contador da assessoria')}
    ${chk('hideZeroChips', 'Ocultar contadores com valor zero')}
    ${chk('abbreviate', 'Abreviar nomes das unidades (ex.: NJ 4.0, PREV.)')}
    ${chk('favoritesOnTop', 'Grupo "Favoritas" no topo da árvore')}
  </fieldset>
  <fieldset><legend>Variação desde a última leitura</legend>
    ${chk('showDelta', 'Sinalizar filas que aumentaram (▲) ou diminuíram (▼)')}
    <label class="col">Comparar com<select data-c="deltaBase">${opt('ultima', cfg.deltaBase, 'A atualização anterior')}${opt('dia', cfg.deltaBase, 'A última leitura do dia anterior')}</select></label>
    <label>Variação mínima para sinalizar <input type="number" min="1" max="999" step="1" data-c="deltaMin" value="${Math.max(1, +cfg.deltaMin || 1)}"></label>
    ${chk('showDecrease', 'Sinalizar também reduções (▼)')}
    <div class="hint">A variação é calculada sobre o total de cada fila a cada atualização (parcial ou total).</div>
  </fieldset>
  <fieldset><legend>Tela de Conclusões</legend>
    ${chk('autoFilter', 'Aplicar filtro e ordenação automaticamente ao abrir uma fila pelo painel (pelos links da mesa, a fila abre sem filtro)')}
    <label class="col">Pré-Análise<select data-c="autoFilterPre">${opt('true', cfg.autoFilterPre, 'Pré-Analisadas')}${opt('false', cfg.autoFilterPre, 'Sem Pré-Análise')}${opt('ambos', cfg.autoFilterPre, 'Todas')}</select></label>
    <label class="col">Situação<select data-c="autoFilterSit">${opt('todas', cfg.autoFilterSit, 'Todas')}${opt('concluidas', cfg.autoFilterSit, 'Concluídas')}${opt('devolvidas', cfg.autoFilterSit, 'Devolvidas')}${opt('refeitas', cfg.autoFilterSit, 'Refeitas')}${opt('emAnalise', cfg.autoFilterSit, 'Em Análise')}</select></label>
    <label class="col">Ordenar por<select data-c="autoSortCol">${opt('', cfg.autoSortCol, 'Ordem padrão do Projudi')}${opt('agr.descricao', cfg.autoSortCol, 'Agrupador')}${opt('con.dataEnvio', cfg.autoSortCol, 'Entrada')}${opt('pro.numeroProcesso', cfg.autoSortCol, 'Processo')}${opt('con.seqGrupo', cfg.autoSortCol, 'ID Grupo')}${opt('pro.ordem', cfg.autoSortCol, 'Sequencial')}</select></label>
    <label class="col">Ordem<select data-c="autoSortOrd">${opt('ASC', cfg.autoSortOrd, 'Crescente')}${opt('DESC', cfg.autoSortOrd, 'Decrescente')}</select></label>
    <div class="hint">O filtro é aplicado só na chegada à tela. Se o senhor mudar ou limpar o filtro manualmente, a escolha é respeitada.</div>
  </fieldset>
  <fieldset><legend>Assessores</legend>
    ${chk('assessorMenu', 'Painel: botão ≡ nas filas, com as minutas concluídas por assessor')}
    ${chk('preSort', 'Tela de Conclusões: seta de ordenação por assessor na coluna Pré-análise')}
    <div class="hint">A seta ordena pelo nome do assessor e, em seguida, pela data da pré-análise; se a fila ocupar mais de uma página, as páginas são reunidas antes de ordenar. A mudança vale a partir da próxima abertura da tela de Conclusões.</div>
    <div class="hint">Nomes exibidos no submenu ≡ das filas. Uma linha por assessor, no formato <b>login = Nome</b> (ex.: leonardo.raposo = Leonardo Raposo). Sem cadastro, usa o primeiro e o último nome do Projudi.</div>
    <textarea data-c="assessorNames" spellcheck="false">${esc(cfg.assessorNames || '')}</textarea>
  </fieldset>
  <fieldset><legend>Ordenação</legend>
    <label class="col">Unidades<select data-c="unitSort">${opt('projudi', cfg.unitSort, 'Ordem do Projudi')}${opt('alfa', cfg.unitSort, 'Alfabética')}${opt('total', cfg.unitSort, 'Mais processos primeiro')}</select></label>
    <label class="col">Filas<select data-c="queueSort">${opt('projudi', cfg.queueSort, 'Ordem do Projudi')}${opt('alfa', cfg.queueSort, 'Alfabética')}${opt('total', cfg.queueSort, 'Mais processos primeiro')}</select></label>
  </fieldset>
  <fieldset><legend>Comportamento</legend>
    <label class="col">Clique no nome da fila abre<select data-c="titleClick">${opt('total', cfg.titleClick, 'Todos os processos da fila')}${opt('assess', cfg.titleClick, 'Os processos da assessoria')}</select></label>
    ${chk('keepOpen', 'Manter o painel aberto depois de abrir uma fila')}
    <label>Atalho: Alt + <input class="k" type="text" maxlength="1" data-c="hotkey" value="${esc(cfg.hotkey || 'J')}"></label>
  </fieldset>
  <fieldset><legend>Aparência</legend>
    <label class="col">Lado das abas (vale para os dois painéis)<select data-c="side">${opt('right', abas.lado(), 'Direita')}${opt('left', abas.lado(), 'Esquerda')}</select></label>
    <label>Largura (px) <input type="number" min="320" max="900" step="20" data-c="width" value="${+cfg.width || 460}"></label>
    <label>Tamanho da letra <input type="number" min="9" max="18" step="1" data-c="fontSize" value="${+cfg.fontSize || 12}"></label>
  </fieldset>
  <fieldset><legend>Filas exibidas</legend>
    <div class="hint">Desmarque para ocultar a fila em todas as unidades (ex.: painéis informativos como "Prisões provisórias sem sentença").</div>
    ${queuesHtml}
  </fieldset>
  <fieldset><legend>Unidades exibidas e favoritas</legend>
    <div class="hint">Desmarque para ocultar a unidade da árvore, do quadro e da busca. A estrela fixa a unidade no grupo "Favoritas".</div>
    ${unitsHtml}
  </fieldset>
  <fieldset><legend>Filas favoritas</legend>
    <div class="hint">Marque com ☆ ao lado do nome da fila, na árvore. A unidade passa a aparecer em "Favoritas" apenas com as filas marcadas; sem filas marcadas, a unidade favorita aparece com todas as filas. ${cfg.favQueues.length ? cfg.favQueues.length + ' fila(s) marcada(s).' : 'Nenhuma fila marcada.'}</div>
    ${cfg.favQueues.length ? '<div><button class="btn" data-a="clearfavq">Desmarcar todas as filas favoritas</button></div>' : ''}
  </fieldset>
  <fieldset><legend>Levar as configurações para outro computador</legend>
    <div class="hint">O arquivo inclui preferências, favoritas e itens ocultos. As contagens não são exportadas.</div>
    <div class="row"><button class="btn" data-a="export">Exportar (.json)</button><button class="btn" data-a="import">Importar arquivo...</button><input type="file" accept=".json,application/json" data-a="importfile" hidden></div>
  </fieldset>
  <div class="foot"><button class="btn" data-a="reset">Restaurar padrões</button><span class="row"><button class="btn" data-a="cfgback" title="Descartar as alterações feitas nesta tela">Voltar</button><button class="btn on" data-a="cfgsave">Salvar</button></span></div>
</div>`;
    filterCfg();
  }

  // Busca nas configurações: cada termo (sem acentos, sem distinguir maiúsculas) deve constar do texto
  // da opção ou do título do grupo. Título do grupo que contém todos os termos exibe o grupo inteiro.
  // Listas (filas e unidades) são filtradas linha a linha. Campos sem texto próprio (ex.: a caixa de
  // nomes dos assessores) acompanham o elemento anterior.
  function filterCfg() {
    const box = body.querySelector('.cfg');
    if (!box) return;
    const raw = cfgQ.value.trim();
    const terms = norm(raw).split(' ').filter(Boolean);
    const show = (el, on) => { el.style.display = on ? '' : 'none'; };
    let found = 0;
    box.querySelectorAll('.hit').forEach((el) => el.classList.remove('hit'));
    box.querySelectorAll('fieldset').forEach((fs) => {
      const leg = norm(fs.querySelector('legend').textContent);
      const legAll = terms.length > 0 && terms.every((t) => leg.includes(t));
      const test = (el) => {
        const own = norm(el.textContent + ' ' + (el.title || '') + ' ' + [...el.querySelectorAll('[title]')].map((x) => x.title).join(' '));
        const ok = !terms.length || legAll || terms.every((t) => (leg + ' ' + own).includes(t));
        if (ok && terms.length && terms.some((t) => own.includes(t))) el.classList.add('hit');
        return ok;
      };
      let any = false, prev = false;
      [...fs.children].forEach((el) => {
        if (el.tagName === 'LEGEND') return;
        if (el.classList.contains('units')) {
          let n = 0;
          [...el.children].forEach((row) => { const ok = test(row); show(row, ok); if (ok) n++; });
          if (terms.length && !legAll) found += n;
          show(el, n > 0); prev = n > 0; if (n) any = true;
          return;
        }
        const ok = el.tagName === 'TEXTAREA' ? prev : test(el);
        show(el, ok); prev = ok;
        if (ok) { any = true; if (terms.length && !legAll && !el.classList.contains('hint') && el.tagName !== 'TEXTAREA') found++; }
      });
      if (legAll) found++;
      show(fs, any);
    });
    cfgQInfo.classList.remove('err');
    if (!terms.length) cfgQInfo.textContent = '';
    else if (!found && !box.querySelector('fieldset:not([style*="none"])')) { cfgQInfo.textContent = 'Nenhuma opção corresponde a "' + raw + '".'; cfgQInfo.classList.add('err'); }
    else cfgQInfo.textContent = found ? found + (found === 1 ? ' resultado.' : ' resultados.') + ' Esc limpa a busca.' : 'Resultados apenas em textos explicativos. Esc limpa a busca.';
  }

  function setCfg(key, raw) {
    const d = DEFAULTS[key];
    let v = raw;
    if (typeof d === 'boolean') v = !!raw;
    else if (typeof d === 'number') { v = +raw; if (!isFinite(v)) v = d; }
    else if (key === 'assessorNames') { v = String(raw || ''); }
    else if (key === 'hotkey') { v = String(raw || '').trim().toUpperCase().slice(0, 1); if (!/^[A-Z0-9]$/.test(v)) return; }
    cfg[key] = v;
    saveCfg();
    if (key === 'side') abas.definirLado(v); // o lado é comum aos dois painéis
    // Nova largura nas configurações: o painel volta a usá-la integralmente.
    if (key === 'width' && ui.panelW) { delete ui.panelW; saveUi(); }
    applyLayout();
  }

  function toggleFavQ(k) {
    const i = cfg.favQueues.indexOf(k);
    if (i >= 0) cfg.favQueues.splice(i, 1); else cfg.favQueues.push(k);
    saveCfg();
    render();
  }

  function exportCfg() {
    const data = toJson({ app: 'projudi-navegador-rapido', formato: 1, exportadoEm: new Date().toISOString(), configuracoes: cfg });
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'navegador-projudi-configuracoes.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Arquivo de configurações exportado.');
  }

  function importCfg(file) {
    const rd = new FileReader();
    rd.onload = () => {
      let obj;
      try { obj = fixArrays(JSON.parse(String(rd.result))); } catch (_) { return toast('O arquivo não é um JSON válido.'); }
      const src = obj && obj.app === 'projudi-navegador-rapido' ? obj.configuracoes : null;
      if (!src || typeof src !== 'object') return toast('Este arquivo não é uma exportação do Painel de Navegação.');
      let n = 0;
      for (const k of Object.keys(DEFAULTS)) {
        if (!(k in src)) continue;
        const d = DEFAULTS[k], v = src[k];
        if (Array.isArray(d) ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === typeof d) { cfg[k] = Array.isArray(v) ? v.slice() : v; n++; }
      }
      saveCfg(); applyLayout(); render();
      toast(n + ' configurações importadas.');
    };
    rd.readAsText(file);
  }

  function toggleFav(k) {
    const i = cfg.favorites.indexOf(k);
    if (i >= 0) cfg.favorites.splice(i, 1); else cfg.favorites.push(k);
    saveCfg();
    render();
  }

  /* -------------------------------------------------------------- ações */
  function go(el) {
    if (el.dataset.login) sessionStorage.setItem('pnr.assessor', toJson({ login: el.dataset.login, ts: Date.now() }));
    else sessionStorage.removeItem('pnr.assessor');
    const t = { comp: el.dataset.c, unit: el.dataset.u };
    if (el.dataset.q) { t.q = el.dataset.q; t.n = +el.dataset.n || 1; t.kind = el.dataset.go || 'total'; }
    openTarget(t).catch((e) => setStatus(e.message, true));
  }

  function openFromResult(it) {
    const t = { comp: it.c.label, unit: it.u.label };
    if (it.q) { t.q = it.q.title; t.n = it.q.n; t.kind = cfg.titleClick; }
    openTarget(t).catch((e) => setStatus(e.message, true));
  }

  function treeAction(t) {
    const all = [...body.querySelectorAll('details[data-k]')];
    if (t === 'expand') all.forEach((d) => { d.open = true; });
    else if (t === 'collapse') all.forEach((d) => { d.open = false; });
    else if (t === 'comps') all.forEach((d) => { d.open = d.classList.contains('comp'); });
    all.forEach((d) => { ui.open[d.dataset.k] = d.open; });
    const grps = [...body.querySelectorAll('[data-grp]')];
    grps.forEach((b) => { ui.open[b.dataset.grp] = t === 'expand'; });
    saveUi();
    if (grps.length) render();
  }

  // Configurações: as alterações valem na hora (pré-visualização). "Salvar" as mantém; "Voltar" restaura
  // o estado de quando a tela foi aberta (inclusive importação e "Restaurar padrões" feitos nela).
  let cfgSnap = null;
  function openCfg() {
    cfgSnap = { cfg: JSON.parse(toJson(cfg)), panelW: ui.panelW, tabTop: ui.tabTop };
    showingCfg = true;
    cfgQ.value = '';
    render();
    body.scrollTop = 0;
    setTimeout(() => cfgQ.focus({ preventScroll: true }), 30);
  }
  function closeCfg(save) {
    if (!save && cfgSnap) {
      for (const k of Object.keys(cfg)) delete cfg[k];
      Object.assign(cfg, cfgSnap.cfg);
      if (cfgSnap.panelW === undefined) delete ui.panelW; else ui.panelW = cfgSnap.panelW;
      if (cfgSnap.tabTop === undefined) delete ui.tabTop; else ui.tabTop = cfgSnap.tabTop;
      saveUi();
      applyLayout();
    }
    saveCfg();
    cfgSnap = null;
    showingCfg = false;
    cfgQ.value = '';
    render();
    restoreScroll();
    toast(save ? 'Configurações salvas.' : 'Alterações descartadas.');
  }

  let busy = false;
  async function doCrawl(mode, only) {
    if (busy) return;
    busy = true;
    const btns = [...root.querySelectorAll('button[data-a=crawl], button[data-upd]')];
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await crawl((m) => setStatus(m), mode === 'parcial' ? 'parcial' : 'total', only);
      busy = false;
      setStatus(statusLine(r.tree) + (r.atuacaoOriginal && !r.restored ? ' Atenção: não consegui restaurar a Atuação original; reabra a unidade antes de trabalhar.' : ''), !!(r.atuacaoOriginal && !r.restored));
      if (!showingCfg) render();
    } catch (e) {
      setStatus(e.message + ' Recarregue a página antes de continuar trabalhando.', true);
    } finally {
      busy = false;
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  /* -------------------------------------------------------------- eventos */
  root.addEventListener('click', (e) => {
    const ass = e.target.closest('[data-ass]');
    if (ass) { e.preventDefault(); e.stopPropagation(); return toggleAssessores(ass); }
    const favq = e.target.closest('[data-favq]');
    if (favq) { e.preventDefault(); e.stopPropagation(); return toggleFavQ(favq.dataset.favq); }
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.preventDefault(); e.stopPropagation(); return toggleFav(fav.dataset.fav); }
    const a = e.target.closest('[data-a]');
    if (a) {
      const act = a.dataset.a;
      if (act === 'tab') { if (tabMoved) { tabMoved = false; return; } return toggle(); }
      if (act === 'close') return toggle(false);
      if (act === 'crawl') return doCrawl(a.dataset.mode);
      if (act === 'cfg') { if (showingCfg) { cfgSnap = null; showingCfg = false; render(); return restoreScroll(); } return openCfg(); }
      if (act === 'cfgsave') return closeCfg(true);
      if (act === 'cfgback') return closeCfg(false);
      if (act === 'export') return exportCfg();
      if (act === 'import') return root.querySelector('input[data-a=importfile]').click();
      if (act === 'clearfavq') { cfg.favQueues = []; saveCfg(); return render(); }
      if (act === 'reset') {
        const fav = cfg.favorites.slice(), hid = cfg.hidden.slice(), hq = cfg.hiddenQueues.slice(), fq = cfg.favQueues.slice();
        Object.assign(cfg, DEFAULTS, { favorites: fav, hidden: hid, hiddenQueues: hq, favQueues: fq });
        delete ui.panelW; delete ui.tabTop; saveUi();
        saveCfg(); applyLayout(); toast('Configurações restauradas. Favoritas, unidades e filas ocultas foram mantidas.');
        return render();
      }
    }
    const t = e.target.closest('[data-t]');
    if (t) {
      if (t.dataset.t === 'fav') { ui.onlyFav = !ui.onlyFav; saveUi(); return render(); }
      if (t.dataset.t === 'zeros') { cfg.zeros = !cfg.zeros; saveCfg(); return render(); }
      if (t.dataset.t === 'growth') { ui.onlyGrowth = !ui.onlyGrowth; saveUi(); return render(); }
      return treeAction(t.dataset.t);
    }
    const v = e.target.closest('[data-v]');
    if (v) { ui.view = v.dataset.v; search.value = ''; saveUi(); render(); return restoreScroll(); }
    const th = e.target.closest('th[data-s]');
    if (th) { ui.sort = { k: th.dataset.s, d: ui.sort.k === th.dataset.s ? -ui.sort.d : (th.dataset.s === 'fila' ? 1 : -1) }; saveUi(); return render(); }
    const upd = e.target.closest('[data-upd]');
    if (upd) { e.preventDefault(); e.stopPropagation(); return doCrawl('unidade', { c: upd.dataset.c, u: upd.dataset.u }); }
    const mesa = e.target.closest('[data-mesa]');
    if (mesa) { e.preventDefault(); e.stopPropagation(); return go(mesa); }
    const grp = e.target.closest('[data-grp]');
    if (grp) { e.preventDefault(); e.stopPropagation(); ui.open[grp.dataset.grp] = !isOpen(grp.dataset.grp); saveUi(); return render(); }
    const g = e.target.closest('[data-go]');
    if (g && !showingCfg) { e.preventDefault(); return go(g); }
    const r = e.target.closest('.res');
    if (r) { const it = results[+r.dataset.i]; if (it) openFromResult(it); }
  });
  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('select[data-a=qunit]')) { ui.qunit = el.value; saveUi(); return render(); }
    if (el.matches('input[data-a=importfile]')) { if (el.files && el.files[0]) importCfg(el.files[0]); el.value = ''; return; }
    if (el.matches('[data-showq]')) {
      const t = el.dataset.showq;
      cfg.hiddenQueues = cfg.hiddenQueues.filter((x) => x !== t);
      if (!el.checked) cfg.hiddenQueues.push(t);
      return saveCfg();
    }
    if (el.matches('[data-show]')) {
      const k = el.dataset.show;
      cfg.hidden = cfg.hidden.filter((x) => x !== k);
      if (!el.checked) cfg.hidden.push(k);
      return saveCfg();
    }
    if (el.matches('[data-c]') && showingCfg) {
      setCfg(el.dataset.c, el.type === 'checkbox' ? el.checked : el.value);
      if (el.dataset.c === 'hotkey') el.value = cfg.hotkey;
    }
  });
  root.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName === 'DETAILS' && d.dataset.k) { ui.open[d.dataset.k] = d.open; saveUi(); }
  }, true);

  // Borda interna: arrastar ajusta a largura (mínimo PANEL_MIN, máximo o valor das configurações);
  // clique duplo recolhe o painel, que reabre com a última largura ajustada.
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { id: e.pointerId, x: e.clientX, w: panelWidth(), moved: false };
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('drag');
    panel.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    // Painel à direita cresce ao arrastar para a esquerda; à esquerda, ao arrastar para a direita.
    const w = drag.w + (abas.lado() === 'left' ? dx : -dx);
    ui.panelW = Math.round(Math.max(PANEL_MIN, Math.min(maxWidth(), w)));
    applyLayout();
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    try { grip.releasePointerCapture(drag.id); } catch (_) { /* ignora */ }
    if (drag.moved) saveUi();
    drag = null;
    grip.classList.remove('drag');
    panel.classList.remove('resizing');
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); endDrag(); toggle(false); });

  // Aba lateral: arrastar na vertical muda a posição; um clique sem arraste abre ou fecha o painel.
  let tabDrag = null, tabMoved = false;
  tab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    tabDrag = { id: e.pointerId, y: e.clientY, top: abas.topoAtual(), moved: false };
    tab.setPointerCapture(e.pointerId);
  });
  tab.addEventListener('pointermove', (e) => {
    if (!tabDrag || e.pointerId !== tabDrag.id) return;
    const dy = e.clientY - tabDrag.y;
    if (!tabDrag.moved && Math.abs(dy) < 4) return;
    tabDrag.moved = true;
    tab.classList.add('dragging');
    abas.posicionar(tabDrag.top + dy);
  });
  const endTabDrag = (e) => {
    if (!tabDrag || (e && e.pointerId !== tabDrag.id)) return;
    try { tab.releasePointerCapture(tabDrag.id); } catch (_) { /* ignora */ }
    if (tabDrag.moved) {
      abas.salvar();
      tabMoved = true; // o clique que o navegador dispara ao soltar não deve abrir o painel
      setTimeout(() => { tabMoved = false; }, 0);
    }
    tabDrag = null;
    tab.classList.remove('dragging');
  };
  tab.addEventListener('pointerup', endTabDrag);
  tab.addEventListener('pointercancel', endTabDrag);
  // Mudança de zoom ou de monitor altera a densidade de pixels: o rótulo é redesenhado na nova resolução.
  window.addEventListener('resize', () => { tabLabel(tabText); placeTab(); });

  body.addEventListener('scroll', () => {
    if (showingCfg || norm(search.value)) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { ui.scroll[ui.view] = body.scrollTop; saveUi(); }, 250);
  });
  search.addEventListener('input', () => { sel = 0; render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); render(); scrollSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); scrollSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel] && norm(search.value)) openFromResult(results[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); if (search.value) { search.value = ''; render(); } else toggle(false); }
  });
  cfgQ.addEventListener('input', () => { filterCfg(); body.scrollTop = 0; });
  cfgQ.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (cfgQ.value) { cfgQ.value = ''; filterCfg(); } }
    else if (e.key === 'Enter') e.preventDefault();
  });
  function scrollSel() { const el = root.querySelector('.res.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }

  document.addEventListener('keydown', (e) => { if (HOTKEY(e)) { e.preventDefault(); toggle(); } }, true);
  window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.pnr === 'toggle') toggle(); });

  captureTop();
  applyLayout();
  (document.body || document.documentElement).appendChild(host);
  placeTab(); // com a aba já na página, a altura é conhecida e a posição pode ser limitada à janela
  handlePending();
  if (sessionStorage.getItem(SS_REOPEN)) { sessionStorage.removeItem(SS_REOPEN); toggle(true); }
})();
