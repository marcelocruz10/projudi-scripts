// ==UserScript==
// @name         Painel de Agrupadores e Localizadores - Projudi
// @namespace    tjam.projudi.agrupadores
// @version      1.8.3
// @description  Agrupadores e localizadores da unidade em árvore, com os processos de cada um no gabinete (conclusos) e na secretaria, busca por sentido e abertura da lista no Projudi.
// @author       Marcelo Cruz de Oliveira
// @match        https://projudi.tjam.jus.br/projudi/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/marcelocruz10/projudi-scripts/main/painel-agrupadores-localizadores.user.js
// @downloadURL  https://raw.githubusercontent.com/marcelocruz10/projudi-scripts/main/painel-agrupadores-localizadores.user.js
// @run-at       document-idle
// ==/UserScript==

/*
 * Funcionamento
 * - Somente leitura: nada é gravado, movimentado ou alterado no Projudi. O painel lê telas de consulta e,
 *   no clique, abre a tela de consulta já filtrada.
 * - Cada item tem dois números: GABINETE (conclusos) e SECRETARIA (ativos fora da conclusão).
 * - Mesa: o painel lê todas as filas de conclusão da unidade, todas as páginas, e guarda os processos
 *   conclusos e o agrupador de cada um.
 * - Agrupador: gabinete = conclusos na Mesa com ele; secretaria = Busca › Avançada pelo agrupador, situação
 *   ATIVO. As duas listas não se sobrepõem: a Busca só traz a conclusão que já saiu da Mesa.
 * - Localizador: a Busca › Avançada traz os dois lados juntos; o gabinete é a interseção com os conclusos da
 *   Mesa (lida pelos números de processo, 100 por página) e a secretaria, o restante.
 * - Árvore: o Projudi só tem listas planas; os ramos saem do próprio nome, pelas partes separadas por " - "
 *   (GÊNERO › ESPÉCIE › ATO, conforme a NOMENCLATURA dos agrupadores). Ramo com um item só não se abre: o item
 *   aparece inteiro. Em todo nível, quem tem mais processos vem primeiro.
 * - Busca por sentido, local e sem IA: sem acento e caixa, por prefixo, por radical e por dicionário de
 *   sinônimos (o embutido e o do usuário, na engrenagem).
 * - Unidades: ao abrir, conta a unidade ativa (com retrato guardado por alguns minutos). As outras unidades
 *   mostram o último retrato; o ⟳ nelas troca a Atuação, conta e restaura a unidade original.
 * - Atalho: Alt+K (configurável). Convive com o Painel de Navegação (Alt+J), que fica à direita; este fica
 *   à esquerda por padrão.
 */

(function () {
  'use strict';

  /* ================================================================ núcleo puro (testado em Node) */
  const PAL = (() => {
    // Sem acentos, maiúsculas, "2ª" = "2A", espaços simples.
    const norm = (s) => String(s || '').replace(/ª/g, 'a').replace(/[º°]/g, 'o').normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
    const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR'));
    const soma = (arr, f) => { let s = 0; for (const x of arr || []) s += (+f(x) || 0); return s; };

    // Partes do nome. "- NOME" (hífen inicial) é agrupador legado ou preso para exclusão.
    function partes(nome) {
      const bruto = String(nome || '').replace(/\s+/g, ' ').trim();
      const legado = /^-\s/.test(bruto);
      const limpo = legado ? bruto.replace(/^-\s+/, '') : bruto;
      return { legado, partes: limpo.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean) };
    }

    const PROF_MAX = 2; // agrupa no máximo em dois níveis (gênero e espécie); o resto é folha

    // Números de um item: gab (conclusos no gabinete), sec (na secretaria), tot (soma; null se nenhum foi lido).
    const nums = (it) => {
      const g = it.gab === undefined ? null : it.gab, s = it.sec === undefined ? null : it.sec;
      return { gab: g, sec: s, tot: g === null && s === null ? null : (+g || 0) + (+s || 0) };
    };
    function folha(e, prof) {
      return Object.assign({ tipo: 'item', item: e.item, rotulo: e.partes.slice(prof).join(' - ') || e.item.nome }, nums(e.item));
    }

    function agrupar(lista, prof, prefixo) {
      const out = [];
      const baldes = new Map();
      for (const e of lista) {
        if (prof >= PROF_MAX || e.partes.length <= prof + 1) { out.push(folha(e, prof)); continue; }
        const k = norm(e.partes[prof]);
        if (!baldes.has(k)) baldes.set(k, []);
        baldes.get(k).push(e);
      }
      for (const [k, b] of baldes) {
        if (b.length === 1) { out.push(folha(b[0], prof)); continue; }
        let g = { tipo: 'grupo', chave: prefixo + '›' + k, rotulo: b[0].partes[prof], filhos: agrupar(b, prof + 1, prefixo + '›' + k) };
        // Ramo cujo único filho é outro ramo: funde os dois ("CUMP SENTENCA - LIQUIDACAO").
        while (g.filhos.length === 1 && g.filhos[0].tipo === 'grupo') {
          const f = g.filhos[0];
          g = { tipo: 'grupo', chave: f.chave, rotulo: g.rotulo + ' - ' + f.rotulo, filhos: f.filhos };
        }
        out.push(g);
      }
      return out;
    }

    function totalizar(nos) {
      for (const n of nos) {
        if (n.tipo !== 'grupo') continue;
        totalizar(n.filhos);
        for (const k of ['gab', 'sec', 'tot']) n[k] = n.filhos.some((f) => f[k] !== null && f[k] !== undefined) ? soma(n.filhos, (f) => f[k]) : null;
        n.itens = soma(n.filhos, (f) => (f.tipo === 'grupo' ? f.itens : 1));
      }
      return nos;
    }

    // Vara de Garantias: os itens do magistrado começam por "07"; os demais (outras vagas, secretaria) vão ao ramo OUTROS.
    // A Central de Plantão Criminal é competência da Vara de Garantias (decisão dele, 17/10), embora o nome não o diga.
    const ehGarantias = (nomeUnidade) => /GARANTIAS|CENTRAL DE PLANTAO CRIMINAL/.test(norm(nomeUnidade));
    const ehProprio = (nome) => /^07(?!\d)/.test(String(nome || '').trim());
    // plano: na Garantias os itens são poucos e não se reúnem em gênero/espécie (decisão dele, 17/10).
    const opcoesDaUnidade = (nomeUnidade) => (ehGarantias(nomeUnidade) ? { proprio: ehProprio, plano: true } : {});

    function ramos(itens, secao) {
      const normais = [], legados = [];
      for (const it of itens || []) {
        const p = partes(it.nome);
        (p.legado ? legados : normais).push({ item: it, partes: p.partes });
      }
      const nos = agrupar(normais, 0, secao);
      if (legados.length) {
        nos.push({ tipo: 'grupo', chave: secao + '›-LEGADO', rotulo: 'LEGADO (nome iniciado por “- ”)', legado: true,
          filhos: legados.map((e) => Object.assign({ tipo: 'item', item: e.item, rotulo: e.item.nome }, nums(e.item))) });
      }
      return nos;
    }

    // Árvore de uma seção. itens: [{id, nome, gab, sec}]. secao: 'agr' | 'loc' (prefixo das chaves).
    // opts.proprio(nome): o que não for próprio vai, com a sua própria árvore, ao ramo OUTROS, sempre por último.
    function montarArvore(itens, secao, opts) {
      const proprio = opts && opts.proprio;
      if (!proprio) return totalizar(ramos(itens, secao));
      const meus = [], outros = [];
      for (const it of itens || []) (proprio(it.nome) ? meus : outros).push(it);
      if (opts.plano) {
        // Lista plana: o próprio item em cada ramo; nos 07, o rótulo sem o "07 - ", que o ramo já diz.
        const lista = (its, tira) => its.map((it) => Object.assign({ tipo: 'item', item: it,
          rotulo: (tira ? String(it.nome).replace(/^07\s*[-–—]?\s*/, '') : String(it.nome).trim()) || it.nome }, nums(it)));
        const nos = [];
        if (meus.length) nos.push({ tipo: 'grupo', chave: secao + '›-07', rotulo: '07', proprio: true, filhos: lista(meus, true) });
        if (outros.length) nos.push({ tipo: 'grupo', chave: secao + '›-OUTROS', rotulo: 'OUTROS', outros: true, filhos: lista(outros, false) });
        return totalizar(nos);
      }
      const nos = ramos(meus, secao);
      if (outros.length) nos.push({ tipo: 'grupo', chave: secao + '›-OUTROS', rotulo: 'OUTROS', outros: true, filhos: ramos(outros, secao + '›-OUTROS') });
      return totalizar(nos);
    }

    // crit: 'tot' (padrão), 'gab' ou 'sec'. O ramo OUTROS fica sempre no fim.
    const valor = (n, crit) => { const v = n[crit === 'gab' || crit === 'sec' ? crit : 'tot']; return v === null || v === undefined ? -1 : +v; };
    function ordenar(nos, crit) {
      nos.sort((a, b) => (a.ordem !== undefined && b.ordem !== undefined ? a.ordem - b.ordem : 0) || ((a.outros ? 1 : 0) - (b.outros ? 1 : 0)) || (valor(b, crit) - valor(a, crit)) || norm(a.rotulo).localeCompare(norm(b.rotulo), 'pt-BR'));
      for (const n of nos) if (n.tipo === 'grupo') ordenar(n.filhos, crit);
      return nos;
    }

    // Visível: item com algum processo (ou todos, com "zerados"); ramo com algum filho visível.
    const temProcesso = (n) => (+n.tot || 0) > 0;
    function visiveis(nos, zerados) {
      const out = [];
      for (const n of nos) {
        if (n.tipo === 'grupo') {
          const f = visiveis(n.filhos, zerados);
          if (f.length) out.push(Object.assign({}, n, { filhos: f }));
        } else if (zerados || temProcesso(n)) out.push(n);
      }
      return out;
    }

    // Folhas com o caminho dos ramos, para a busca e para a lista plana.
    function folhas(nos, caminho, out) {
      out = out || [];
      for (const n of nos) {
        if (n.tipo === 'grupo') folhas(n.filhos, (caminho || []).concat(n.rotulo), out);
        else out.push({ no: n, caminho: caminho || [] });
      }
      return out;
    }

    /* Busca por sentido (porta da busca do Painel Inteligência Processual 3.3+). Cada palavra da consulta casa
     * uma palavra do texto por prefixo, pelo radical (sufixos comuns do português) ou por um sinônimo. Todas as
     * palavras precisam casar, em qualquer ordem. Exato vale mais que radical, que vale mais que sinônimo. */
    const SUFIXOS = ['ACOES', 'ACAO', 'ADOS', 'ADAS', 'ADO', 'ADA', 'IDO', 'IDA', 'AR', 'ER', 'IR', 'OU', 'S'];
    function radical(p) {
      for (const s of SUFIXOS) if (p.length - s.length >= 4 && p.slice(-s.length) === s) return p.slice(0, -s.length);
      return p;
    }
    // Singular simples, para "CITACOES" casar "CITACAO" (o radical sozinho sobraria curto demais: "CIT").
    const singular = (p) => (/[OA]ES$/.test(p) ? p.slice(0, -3) + 'AO' : /NS$/.test(p) ? p.slice(0, -2) + 'M' : p.length > 3 && /[^S]S$/.test(p) ? p.slice(0, -1) : p);
    const casa = (q, w) => w.indexOf(q) === 0 || w.indexOf(singular(q)) === 0 || singular(w) === singular(q)
      || (radical(q).length >= 4 && (w.indexOf(radical(q)) === 0 || radical(w) === radical(q)));
    const palavras = (s) => norm(s).split(/[^A-Z0-9]+/).filter(Boolean);

    function prepararSinonimos(grupos) {
      return (grupos || []).map((g) => [].concat(...g.map(palavras))).filter((g) => g.length > 1);
    }

    function pontuar(consulta, texto, grupos) {
      const qs = palavras(consulta);
      if (!qs.length) return 1;
      const ws = palavras(texto);
      let pontos = 0;
      for (const q of qs) {
        if (ws.indexOf(q) >= 0) { pontos += 15; continue; }
        if (ws.some((w) => casa(q, w))) { pontos += 10; continue; }
        const termos = [].concat(...grupos.filter((g) => g.some((t) => t === q || casa(q, t))));
        if (termos.some((t) => ws.some((w) => w === t || casa(t, w)))) { pontos += 8; continue; }
        return 0;
      }
      if (ws.length && casa(qs[0], ws[0])) pontos += 3;
      return pontos;
    }

    // Resultados ordenados: pontuação, depois a contagem pelo critério ativo.
    function buscar(consulta, lista, grupos, crit) {
      const out = [];
      for (const f of lista) {
        const p = pontuar(consulta, f.caminho.concat(f.no.item.nome).join(' '), grupos);
        if (p > 0) out.push({ f, p });
      }
      out.sort((a, b) => (b.p - a.p) || (valor(b.f.no, crit) - valor(a.f.no, crit)));
      return out.map((o) => o.f);
    }

    // Sinônimos embutidos: grupos de busca do Painel 4.0, mais os termos penais (garantias), cíveis e
    // previdenciários tirados dos nomes reais das tabelas, e as abreviaturas da NOMENCLATURA 1.6.
    // São só termos de busca: nenhum grupo classifica processo nem cria norma.
    const SINONIMOS = [
      ['DEFESA', 'CONTESTACAO', 'CONTESTAR'],
      ['TRANSITOU', 'TRANSITO', 'TRANSITADO'],
      ['EMBARGOS', 'ED', 'EMBARGO', 'EMB'],
      ['CITADO', 'CITACAO', 'CITAR'],
      ['INTIMADO', 'INTIMACAO', 'INTIMAR'],
      ['SENTENCIADO', 'SENTENCA', 'JULGAMENTO', 'JULGADO', 'SENT'],
      ['RECURSO', 'APELACAO', 'AGRAVO', 'CONTRARRAZOES'],
      ['PERICIA', 'LAUDO', 'PERITO'],
      ['AUDIENCIA', 'SESSAO', 'PAUTA', 'AIJ', 'AUD'],
      ['SUSPENSAO', 'SOBRESTAMENTO', 'SUSPENSO', 'SOBRESTADO'],
      ['PAGAMENTO', 'DEPOSITO', 'PAGO', 'PGTO'],
      ['ARQUIVAMENTO', 'ARQUIVADO', 'BAIXA', 'ENCERRADO', 'ENCERRADOS'],
      ['PRISAO', 'PRESO', 'PRESOS', 'CUSTODIA', 'FLAGRANTE', 'PREVENTIVA', 'TEMPORARIA'],
      ['CAUTELAR', 'CAUTELARES', 'MEDIDA', 'MONITORAMENTO', 'TORNOZELEIRA'],
      ['ANPP', 'ACORDO', 'PERSECUCAO', 'TRANSACAO', 'CONCILIACAO', 'CEJUSC'],
      ['MP', 'MINISTERIO PUBLICO', 'MINISTERIAL', 'PROMOTOR', 'PROMOTORIA', 'PARQUET'],
      ['DELEGADO', 'POLICIA', 'POLICIAL', 'INQUERITO', 'IP', 'AUTORIDADE'],
      ['SISBAJUD', 'BACENJUD', 'BLOQUEIO', 'PENHORA', 'TEIMOSINHA', 'DESBLOQUEIO', 'DESBLOQ'],
      ['RENAJUD', 'VEICULO', 'VEICULOS'],
      ['SIGILO', 'QUEBRA', 'INTERCEPTACAO', 'TELEFONICO', 'BANCARIO', 'TELEMATICO'],
      ['RESTITUICAO', 'BENS', 'APREENDIDA', 'APREENDIDO', 'APREENSAO', 'COISA'],
      ['INSANIDADE', 'MENTAL', 'INIMPUTAVEL'],
      ['MANDADO', 'OFICIAL', 'DILIGENCIA', 'DILIGENCIAS'],
      ['ALVARA', 'LEVANTAMENTO'],
      ['RPV', 'PRECATORIO', 'REQUISITORIO', 'REQUISICAO'],
      ['CALCULO', 'CALCULOS', 'CONTADORIA', 'LIQUIDACAO', 'LIQUID'],
      ['CUMPRIMENTO', 'CUMP', 'EXECUCAO', 'EXECUTIVO'],
      ['COMPETENCIA', 'DECLINIO', 'REDISTRIBUICAO', 'REDISTRIB', 'REDISTRIBUIR', 'CONFLITO'],
      ['REMESSA', 'REMETER', 'ENVIAR', 'ENCAMINHAR'],
      ['AGUARDANDO', 'AGUARDA', 'AG', 'AGUARDAR'],
      ['VISTA', 'VISTAS', 'MANIFESTACAO', 'MANIFESTAR', 'RESPOSTA', 'RETORNO'],
      ['ADVOGADO', 'ADV', 'HABILITACAO', 'HABILIT', 'PROCURADOR'],
      ['DEFENSORIA', 'DPE', 'DEFENSOR'],
      ['INSS', 'AUTARQUIA', 'PREVIDENCIARIO', 'PREVIDENCIA', 'PREV', 'BENEFICIO'],
      ['APOSENTADORIA', 'APOSENTADO', 'APOSENTAR'],
      ['BPC', 'LOAS', 'ASSISTENCIAL', 'DEFICIENTE', 'IDOSO'],
      ['BANCO', 'BANCARIO', 'CREDITO', 'CRED', 'EMPRESTIMO', 'EMPREST', 'CONSIGNADO', 'CONSIG', 'FINANCIAMENTO', 'FINANC', 'CARTAO'],
      ['CONSUMIDOR', 'CDC', 'NEGATIVACAO', 'NEGATIV', 'INDEVIDO', 'INDEVIDA'],
      ['DANO', 'DANOS', 'INDENIZACAO', 'INDENIZ', 'MORAL', 'RESP', 'RESPONSABILIDADE'],
      ['TUTELA', 'LIMINAR', 'URGENCIA', 'ANTECIPADA', 'ANTEC'],
      ['INICIAL', 'EMENDA', 'PETICAO'],
      ['ROBO', 'BOT', 'AUTOMACAO', 'AUTOMATICO'],
      ['TRIBUNAL', 'TJAM', 'TRF1', '2 GRAU', 'SEGUNDO GRAU', 'INSTANCIA'],
      ['DESPACHO', 'DESP'],
      ['DECISAO', 'DEC', 'DECIDIR'],
      ['IMPUGNACAO', 'IMPUG', 'IMPUGNADA', 'IMPUGNADO'],
      ['HONORARIOS', 'HONOR'],
      ['SUPERENDIVIDAMENTO', 'SUPERENDIV'],
      ['ACIDENTE', 'ACID', 'ACIDENTARIO'],
      ['CERTIDAO', 'CERTIFICAR'],
      ['OFICIO', 'OFICIAR'],
      ['EDITAL', 'EDITAIS'],
      ['CARTA PRECATORIA', 'PRECATORIA', 'DEPRECADO', 'DEPRECAR'],
    ];

    // Grupos do usuário: uma linha por grupo, termos separados por vírgula.
    function lerGruposDoUsuario(texto) {
      const out = [];
      for (const linha of String(texto || '').split(/\r?\n/)) {
        const g = linha.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
        if (g.length > 1) out.push(g);
      }
      return out;
    }

    // "N registro(s) encontrado(s)" da tela de resultado; null quando a tela não traz o total.
    function totalDeRegistros(texto) {
      const s = String(texto || '').replace(/\s+/g, ' ');
      const m = s.match(/(\d[\d.]*)\s*registro\(s\)\s*encontrado/i);
      if (m) return +m[1].replace(/\./g, '');
      if (/nenhum registro encontrado/i.test(s)) return 0;
      return null;
    }

    const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const desentidade = (s) => String(s || '')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&(\w+);/g, (m, n) => (n in ENTIDADES ? ENTIDADES[n] : m))
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

    // Resposta do AJAX de lista (AjaxJspTag): <item><name>..</name><value>..</value></item>, ou <option>.
    function opcoesDoAjax(texto) {
      const out = [];
      const t = String(texto || '');
      const re = /<item>([\s\S]*?)<\/item>/gi;
      let m;
      while ((m = re.exec(t))) {
        const nome = (m[1].match(/<name>([\s\S]*?)<\/name>/i) || [])[1];
        const val = (m[1].match(/<value>([\s\S]*?)<\/value>/i) || [])[1];
        if (val !== undefined && String(val).trim()) out.push({ id: desentidade(val).trim(), nome: desentidade(nome).replace(/\s+/g, ' ').trim() });
      }
      if (out.length) return out;
      const ro = /<option[^>]*value\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
      while ((m = ro.exec(t))) if (m[1].trim()) out.push({ id: desentidade(m[1]).trim(), nome: desentidade(m[2]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() });
      return out;
    }

    const CNJ = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

    /* Conta a Mesa. linhas: [{processo, agrupador, fila}] (uma por linha de fila lida). Cada processo conta uma
     * vez por agrupador; por fila, uma vez por fila. Devolve {porNome: {NOME_NORM: {nome, total, filas:{fila:n}}},
     * semAgrupador, total}. */
    function contarMesa(linhas) {
      const porNome = {};
      const vistos = new Set(), vistosFila = new Set(), todos = new Set(), sem = new Set();
      for (const l of linhas || []) {
        const p = (String(l.processo || '').match(CNJ) || [])[0];
        if (!p) continue;
        todos.add(p);
        const nome = String(l.agrupador || '').replace(/\s+/g, ' ').trim();
        if (!nome) { sem.add(p); continue; }
        const k = norm(nome);
        if (!porNome[k]) porNome[k] = { nome, total: 0, filas: {} };
        if (!vistos.has(k + '|' + p)) { vistos.add(k + '|' + p); porNome[k].total++; }
        const kf = k + '|' + l.fila + '|' + p;
        if (!vistosFila.has(kf)) { vistosFila.add(kf); porNome[k].filas[l.fila] = (porNome[k].filas[l.fila] || 0) + 1; }
      }
      return { porNome, semAgrupador: sem.size, total: todos.size, conclusos: todos };
    }

    /* Linhas de uma tabela de fila: cabeçalho com PROCESSO e AGRUPADOR (lidos pelo rótulo, não pela posição,
     * como no Travessia). celulas: [[texto, ...], ...] só com as células diretas de cada linha. */
    function linhasDaFila(tabela, fila) {
      if (!tabela || !tabela.length) return [];
      const cab = tabela[0].map((c) => norm(c));
      const iP = cab.indexOf('PROCESSO'), iA = cab.indexOf('AGRUPADOR');
      if (iP < 0 || iA < 0) return [];
      const out = [];
      for (const r of tabela.slice(1)) {
        if (r.length <= Math.max(iP, iA)) continue;
        const p = (String(r[iP] || '').match(CNJ) || [])[0];
        if (p) out.push({ processo: p, agrupador: String(r[iA] || '').replace(/\s+/g, ' ').trim(), fila });
      }
      return out;
    }

    /* Agrupadores do retrato. A Busca Avançada por agrupador e a Mesa NÃO se sobrepõem (conferido em 13/10/2026 na
     * 3ª Unidade, processo a processo: zero em comum): a Busca devolve os processos cuja conclusão com o agrupador
     * já saiu da Mesa. Por isso gab = Mesa (pelo nome) e sec = Busca (pelo id). mesa: contarMesa (ou null). */
    function agrupadoresDoRetrato(lista, busca, mesa) {
      return (lista || []).map((x) => {
        const m = mesa ? mesa.porNome[norm(x.nome)] : null;
        return { id: x.id, nome: x.nome, gab: mesa ? (m ? m.total : 0) : null,
          sec: busca && x.id in busca ? busca[x.id] : null, filas: m ? m.filas : {} };
      });
    }

    /* Localizadores do retrato. A Busca por localizador traz conclusos e não conclusos juntos: o gabinete é a
     * interseção dos processos do localizador com os conclusos da Mesa; a secretaria, o restante.
     * total: {id: n}; processos: {id: [cnj...]}; conclusos: Set de cnj (ou null, se a Mesa não foi lida). */
    function localizadoresDoRetrato(lista, total, processos, conclusos) {
      return (lista || []).map((x) => {
        const t = total && x.id in total ? total[x.id] : null;
        if (t === null || !conclusos) return { id: x.id, nome: x.nome, gab: null, sec: t };
        let g = 0;
        for (const p of (processos && processos[x.id]) || []) if (conclusos.has(p)) g++;
        return { id: x.id, nome: x.nome, gab: g, sec: Math.max(0, t - g) };
      });
    }

    /* Contagem por fases (07 antes dos OUTROS): o item não contado nesta chamada leva os números do retrato
     * anterior (pelo id). No agrupador o gabinete vem sempre fresco da Mesa, que já foi lida inteira; só a
     * secretaria é a anterior. No localizador os dois dependem da Busca: ambos vêm do anterior. */
    function mesclarParcial(novos, anteriores, foiContado, secao) {
      const ant = new Map((anteriores || []).map((x) => [String(x.id), x]));
      return (novos || []).map((x) => {
        if (foiContado(x)) return x;
        const a = ant.get(String(x.id));
        return secao === 'agr' ? Object.assign({}, x, { sec: a ? a.sec : null })
          : Object.assign({}, x, { gab: a ? a.gab : null, sec: a ? a.sec : null });
      });
    }

    // Itens do menu da mesa: add_menu("Seção") abre seção; add_menu("Rótulo", "url") é item (porte do Travessia).
    function itensDoMenu(html) {
      const out = [];
      let secao = '';
      const re = /add_menu\(\s*"([^"]*)"\s*(?:,\s*"([^"]*)")?/g;
      let m;
      while ((m = re.exec(String(html || '')))) {
        if (!m[2]) { secao = m[1].trim(); continue; }
        out.push({ secao, rotulo: m[1].trim(), url: m[2] });
      }
      return out;
    }
    // Os endereços do menu são relativos ao contexto /projudi ("/processo/conclusaoJuiz.do?_tj=…").
    const urlDoMenu = (html, secao, rotulo) => {
      const it = itensDoMenu(html).find((x) => norm(x.secao) === norm(secao) && norm(x.rotulo) === norm(rotulo));
      if (!it) return null;
      return /^\/(?!projudi\/)/.test(it.url) ? '/projudi' + it.url : it.url;
    };

    /* ---- Extrato analítico (página para imprimir em PDF). retratos: [{cod, nome, ts, agrupadores, localizadores,
     * mesa}]. Devolve o HTML completo de uma página A4, uma unidade por seção, cada uma em página nova. */
    const escH = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const pct = (v, t) => (t > 0 && v !== null && v !== undefined ? (100 * v / t).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%' : '—');
    const quando = (ts) => { const d = new Date(ts); return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };

    function linhasDoExtrato(nos, prof, totalSec, secao, out) {
      for (const n of nos) {
        const cel = `<td class="n">${fmt(n.gab)}</td><td class="n">${fmt(n.sec)}</td><td class="n t">${fmt(n.tot)}</td><td class="n p">${pct(n.tot, totalSec)}</td>`;
        if (n.tipo === 'grupo') {
          out.push(`<tr class="g p${prof}"><td style="padding-left:${4 + prof * 14}px">${escH(n.rotulo)} <small>${n.itens} itens</small></td>${cel}</tr>`);
          linhasDoExtrato(n.filhos, prof + 1, totalSec, secao, out);
        } else {
          out.push(`<tr class="i${n.tot ? '' : ' z'}"><td style="padding-left:${4 + prof * 14}px" title="${escH(n.item.nome)}">${escH(n.rotulo)}</td>${cel}</tr>`);
          const fs = secao === 'agr' ? Object.keys(n.item.filas || {}).map((f) => [f, n.item.filas[f]]).sort((a, b) => b[1] - a[1]) : [];
          if (fs.length > 1 || (fs.length === 1 && fs[0][1] !== n.gab)) {
            out.push(`<tr class="f"><td style="padding-left:${18 + prof * 14}px" colspan="5">Gabinete por fila: ${fs.map(([f, q]) => escH(f) + ' ' + fmt(q)).join(' · ')}</td></tr>`);
          }
        }
      }
      return out;
    }

    function secaoDoExtrato(titulo, itens, secao, extra, opts) {
      const arv = ordenar(montarArvore(itens || [], secao, opts), 'tot');
      const tg = soma(itens, (x) => x.gab), ts = soma(itens, (x) => x.sec);
      const tot = tg + ts;
      const temGab = (itens || []).some((x) => x.gab !== null && x.gab !== undefined);
      const q = (itens || []).length;
      return `<h2>${titulo} <small>${q} ${q === 1 ? 'item' : 'itens'}</small></h2>
<table><thead><tr><th>${secao === 'agr' ? 'Agrupador' : 'Localizador'}</th><th class="n">Gabinete</th><th class="n">Secretaria</th><th class="n">Total</th><th class="n">% do total</th></tr></thead>
<tbody>${linhasDoExtrato(arv, 0, tot, secao, []).join('')}${extra || ''}</tbody>
<tfoot><tr><td>Soma da seção</td><td class="n">${temGab ? fmt(tg) : '—'}</td><td class="n">${fmt(ts)}</td><td class="n t">${fmt(tot)}</td><td class="n p">100,0%</td></tr></tfoot></table>`;
    }

    // opcoes.so07: na Vara de Garantias, o extrato leva só os itens "07" (sem o ramo OUTROS nem os sem agrupador).
    function extratoHtml(retratos, agora, opcoes) {
      const lista = (retratos || []).filter(Boolean);
      const so07 = !!(opcoes && opcoes.so07);
      const titulo = 'Extrato de agrupadores e localizadores - ' + ((opcoes && opcoes.titulo) || (lista.length === 1 ? lista[0].nome : lista.length + ' unidades'))
        + ' - ' + new Date(agora || Date.now()).toLocaleDateString('pt-BR').split('/').reverse().join('-');
      const unidades = lista.map((r0, i) => {
        const opts = opcoesDaUnidade(r0.nome);
        const recorte = so07 && opts.proprio;
        const r = recorte ? Object.assign({}, r0, {
          agrupadores: (r0.agrupadores || []).filter((x) => ehProprio(x.nome)),
          localizadores: (r0.localizadores || []).filter((x) => ehProprio(x.nome)) }) : r0;
        const tg = soma(r.agrupadores, (x) => x.gab), tsA = soma(r.agrupadores, (x) => x.sec), tsL = soma(r.localizadores, (x) => x.sec);
        const semAgr = !recorte && r.mesa && r.mesa.semAgrupador
          ? `<tr class="i sem"><td>(conclusos sem agrupador)</td><td class="n">${fmt(r.mesa.semAgrupador)}</td><td class="n">—</td><td class="n t">${fmt(r.mesa.semAgrupador)}</td><td class="n p"></td></tr>` : '';
        const filas = r.mesa && (r.mesa.filas || []).length
          ? `<p class="filas"><b>Filas de conclusão lidas:</b> ${(r.mesa.filas || []).map((f) => escH(f.fila + (f.n > 1 ? ' (' + f.n + ')' : '')) + ' ' + fmt(f.total)).join(' · ')}</p>` : '';
        return `<section class="${i ? 'nova' : ''}">
<h1>${escH(r.nome)}</h1>
<p class="meta">${r.composicao ? '<b>Soma de ' + r.composicao.length + ' competências:</b> ' + escH(r.composicao.join(' · ')) + ' · item de mesmo nome somado entre elas · retrato mais antigo de ' : 'Retrato de '}${quando(r.ts)} · processos em situação ATIVO${recorte ? ' · <b>somente agrupadores e localizadores 07</b>' : opts.proprio ? ' · itens 07 primeiro; os demais no ramo OUTROS' : ''}${r.erroMesa ? ' · <b>Mesa não lida:</b> ' + escH(r.erroMesa) : ''}</p>
<div class="cards">
  <div><span>Conclusos no gabinete</span><b>${r.mesa ? fmt(r.mesa.total) : '—'}</b></div>
  <div><span>Sem agrupador (gabinete)</span><b>${r.mesa ? fmt(r.mesa.semAgrupador) : '—'}</b></div>
  <div><span>Agrupadores</span><b>${fmt((r.agrupadores || []).length)}</b><small>gab. ${fmt(tg)} · sec. ${fmt(tsA)}</small></div>
  <div><span>Localizadores</span><b>${fmt((r.localizadores || []).length)}</b><small>sec. ${fmt(tsL)}</small></div>
</div>
${filas}
${secaoDoExtrato('Agrupadores', r.agrupadores, 'agr', semAgr, opts)}
${secaoDoExtrato('Localizadores', r.localizadores, 'loc', '', opts)}
</section>`;
      }).join('');
      return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escH(titulo)}</title>
<style>
  @page{size:A4;margin:14mm 12mm 16mm}
  *{box-sizing:border-box}
  body{font:10px/1.35 Verdana,Arial,sans-serif;color:#222;margin:0;padding:16px;background:#fff}
  .barra{position:sticky;top:0;background:#3f5a73;color:#fff;padding:8px 12px;margin:-16px -16px 14px;display:flex;gap:10px;align-items:center}
  .barra button{font:inherit;padding:4px 10px;border:0;border-radius:4px;cursor:pointer}
  h1{font-size:15px;margin:0 0 2px;color:#2f4659}
  h2{font-size:12px;margin:16px 0 4px;color:#2f4659;border-bottom:2px solid #3f5a73;padding-bottom:2px}
  h2 small,td small{font-weight:normal;color:#777;font-size:9px}
  .meta{margin:0 0 8px;color:#555}
  .cards{display:flex;gap:8px;margin:6px 0}
  .cards div{flex:1;border:1px solid #cdd4d8;border-radius:5px;padding:5px 7px}
  .cards span{display:block;font-size:8.5px;color:#666;text-transform:uppercase;letter-spacing:.3px}
  .cards b{font-size:15px;color:#2f4659}
  .cards small{display:block;color:#777;font-size:8.5px}
  .filas{color:#555;margin:4px 0}
  table{width:100%;border-collapse:collapse;page-break-inside:auto}
  thead{display:table-header-group}
  tr{page-break-inside:avoid}
  th{background:#3f5a73;color:#fff;text-align:left;padding:3px 4px;font-size:9px}
  td{padding:2px 4px;border-bottom:1px solid #e6e9eb;vertical-align:top}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;width:62px}
  .t{font-weight:bold}
  .p{color:#666;width:56px}
  tr.g td{font-weight:bold;background:#f0f3f4}
  tr.g.p0 td{background:#e3e9ec}
  tr.z td{color:#9aa3a8}
  tr.f td{font-size:8.5px;color:#7a5b16;border-bottom:1px dotted #eee}
  tr.sem td{color:#7a5b16;font-style:italic}
  tfoot td{font-weight:bold;border-top:2px solid #3f5a73;background:#f7f8f9}
  td:nth-child(2):not([colspan]){color:#7a5b16}
  th:nth-child(2){color:#f3dfa8}
  .nota{margin-top:14px;color:#666;font-size:8.5px;border-top:1px solid #ddd;padding-top:6px}
  section.nova{page-break-before:always}
  @media print{.barra{display:none}body{padding:0}}
</style></head><body>
<div class="barra"><b style="flex:1">${escH(titulo)}</b><button onclick="window.print()">Imprimir / Salvar em PDF</button></div>
${unidades || '<p>Nenhuma unidade com retrato.</p>'}
<p class="nota"><b>Método.</b> Gabinete: processos conclusos, lidos em todas as filas de conclusão da Mesa (processo contado uma vez por item). Secretaria: processos em situação ATIVO fora da conclusão. No agrupador, a secretaria é a Busca Avançada pelo agrupador, que só traz a conclusão que já saiu da Mesa; no localizador, é a Busca Avançada pelo localizador menos os processos que estão conclusos. A soma de um ramo é a soma dos seus itens; a soma da seção de localizadores pode contar o mesmo processo mais de uma vez, pois um processo pode ter mais de um localizador. % do total: participação do item na soma da seção. Extrato gerado em ${quando(agora || Date.now())} pelo Painel de Agrupadores e Localizadores, somente leitura.</p>
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script>
</body></html>`;
    }

    const SEM_UNIDADE ='Não há unidade ativa na sessão do Projudi. Entre numa unidade (a mesa dela) e o painel conta sozinho; enquanto isso, mostra o último retrato.';
    /* ---- Leitura de telas (recebem um documento já carregado; testadas com o HTML real do Projudi). */
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const pretty = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('pt-BR');

    // Contador da mesa: total, vermelho (prazo) ou assessoria (porte do Painel de Navegação).
    function linkKind(a) {
      if (/^ASSESSORIA/i.test(txt(a))) return 'assess';
      const dentro = a.querySelector('font[color]'), fora = a.closest('font[color]');
      if ((dentro && /red/i.test(dentro.getAttribute('color'))) || (fora && /red/i.test(fora.getAttribute('color')))) return 'red';
      return 'total';
    }
    // Nome da fila: o texto da célula antes do primeiro link (o <b> engloba também os contadores).
    function titleOf(td) {
      let s = '';
      const w = td.ownerDocument.createTreeWalker(td, 4);
      let n;
      while ((n = w.nextNode())) {
        if (n.parentElement && n.parentElement.closest('a')) break;
        s += ' ' + n.textContent;
      }
      return pretty(s.replace(/\(\d+\)/g, '').replace(/[\s(]+$/, ''));
    }
    // Filas da mesa: célula com <b> e links com _tj (os contadores). Homônimas recebem n = 2, 3...
    function filasDaMesa(doc) {
      const out = [], occ = {};
      for (const td of doc.querySelectorAll('td')) {
        if (!td.querySelector(':scope > b')) continue;
        const links = [...td.querySelectorAll('a[href]')].filter((a) => {
          const h = a.getAttribute('href') || '';
          return /_tj=/.test(h) && !/mesaJuiz\.do|usuario\.do|areaAtuacao/.test(h);
        });
        if (!links.length) continue;
        const title = titleOf(td);
        if (!title) continue;
        const n = (occ[norm(title)] = (occ[norm(title)] || 0) + 1);
        const total = links.find((a) => linkKind(a) === 'total');
        out.push({ title, n, total: total ? +((txt(total).match(/(\d+)/) || [])[1] || 0) : 0, href: total ? total.getAttribute('href') : null });
      }
      return out;
    }
    // Tabela da fila de conclusões: cabeçalho com PROCESSO e AGRUPADOR; só as células diretas de cada linha
    // (a célula Partes traz tabela aninhada, que deslocaria as colunas).
    function tabelaDireta(doc) {
      for (const t of doc.querySelectorAll('table')) {
        const tr = t.querySelector('tr');
        if (!tr) continue;
        const cab = [...tr.querySelectorAll(':scope > td, :scope > th')].map(txt);
        const nc = cab.map(norm);
        if (nc.indexOf('PROCESSO') < 0 || nc.indexOf('AGRUPADOR') < 0) continue;
        const linhas = [cab];
        for (const r of t.querySelectorAll('tr')) {
          if (r.closest('table') !== t || r === tr) continue;
          linhas.push([...r.querySelectorAll(':scope > td')].map(txt));
        }
        return linhas;
      }
      return null;
    }
    // Opções reais de um filtro: fora as de valor vazio, negativo ou "null" e as de rótulo ("-- CLIQUE AQUI PARA
    // SELECIONAR --", que vem com valor "null" e, enviada, contaria o acervo inteiro).
    const opcoes = (sel) => (sel ? [...sel.querySelectorAll('option')].filter((o) => {
      const v = (o.getAttribute('value') || '').trim();
      return v && !/^-/.test(v) && !/^(null|undefined)$/i.test(v) && !/^\s*--|selecion/i.test(txt(o));
    }).map((o) => ({ id: o.getAttribute('value').trim(), nome: txt(o) })) : []);
    // Formulário da Busca Avançada: recusa quando o campo Vara não traz a unidade marcada (sem marca, a busca
    // cairia na primeira vara da lista, de outra comarca).
    function formDaBuscaNoDoc(doc) {
      const form = doc.querySelector('form[name=processoBuscaForm]');
      // Sem unidade ativa na sessão (logo após o login, na tela de escolha de competência/unidade, ou durante a
      // troca de Atuação feita por outro painel), o Projudi devolve a página da Busca sem o formulário.
      if (!form) { const e = new Error(SEM_UNIDADE); e.semUnidade = true; throw e; }
      const op = form.querySelector('select[name=codVara] option[selected]');
      if (!op || !op.getAttribute('value')) {
        // A Busca do perfil não oferece esta unidade no campo Vara (ex.: Garantias Júri, Maria da Penha e Trânsito).
        const e = new Error('A Busca Avançada não marcou a unidade ativa no campo Vara; a contagem sairia de outra vara.');
        e.foraDoAlcance = true;
        throw e;
      }
      return { form, cod: op.getAttribute('value'), nome: txt(op), localizadores: opcoes(form.querySelector('select[name=idLocalizador]')) };
    }
    const agrupadoresDoForm = (form) => opcoes(form && form.querySelector('select[name=idAgrupador]'));
    // Números de processo de uma página de resultado da Busca Avançada (só a coluna do número, nunca as partes).
    function processosDaBusca(doc) {
      const out = [];
      for (const tr of doc.querySelectorAll('tr')) {
        const tds = [...tr.querySelectorAll(':scope > td')];
        if (tds.length < 6) continue;
        for (const td of tds.slice(0, 3)) {
          const m = txt(td).match(new RegExp('^' + CNJ.source));
          if (m) { out.push(m[0]); break; }
        }
      }
      return out;
    }

    // Seletor de unidades: as competências da Vara de Garantias (rótulo "GARANTIAS · X") viram filhas de um grupo
    // "VARA DE GARANTIAS", no lugar da primeira delas; as demais unidades seguem soltas, na ordem recebida.
    function agruparUnidades(lista) {
      const out = [];
      let grupo = null;
      for (const o of lista) {
        const m = /^GARANTIAS · \s*(.+)$/.exec(o.rotulo);
        if (!m) { out.push(o); continue; }
        if (!grupo) { grupo = { grupo: 'VARA DE GARANTIAS', itens: [] }; out.push(grupo); }
        grupo.itens.push(Object.assign({}, o, { rotulo: m[1] }));
      }
      return out;
    }

    /* ---- Vara de Garantias inteira. partes: [{cod, rotulo, ret}], um retrato por competência contada. */
    const LISTA = { agr: 'agrupadores', loc: 'localizadores' };
    // Itens com id "cod~id": o mesmo id existe em mais de uma competência. _cod e _id levam o clique à de origem.
    const itensDaParte = (p, secao) => (p.ret[LISTA[secao]] || []).map((x) => Object.assign({}, x, { id: p.cod + '~' + x.id, _cod: p.cod, _id: x.id }));
    function mesaSomada(rs) {
      const com = rs.filter((r) => r.mesa);
      return com.length ? { total: soma(com, (r) => r.mesa.total), semAgrupador: soma(com, (r) => r.mesa.semAgrupador), filas: [] } : null;
    }
    // Retrato virtual do painel: listas de todas as competências, sem somar nada entre elas.
    function varaVirtual(partes, nome) {
      const rs = partes.map((p) => p.ret);
      return { cod: 'g:VARA', nome, vara: true, partes, ts: Math.min(...rs.map((r) => r.ts)), mesa: mesaSomada(rs),
        agrupadores: [].concat(...partes.map((p) => itensDaParte(p, 'agr'))),
        localizadores: [].concat(...partes.map((p) => itensDaParte(p, 'loc'))) };
    }
    // Árvore do painel: cada competência é um ramo do primeiro nível, com a sua própria árvore (07 e OUTROS).
    function arvoreDaVara(partes, secao, opts) {
      // A ordem das competências é a recebida (relevância), fixa: não muda com a coluna escolhida.
      return totalizar(partes.map((p, i) => {
        const chave = secao + '›C' + p.cod;
        return { tipo: 'grupo', chave, rotulo: p.rotulo, competencia: true, ordem: i, filhos: montarArvore(itensDaParte(p, secao), chave, opts) };
      }));
    }
    // Consolidado do extrato: itens de mesmo nome somados entre as competências.
    function somarPorNome(listas) {
      const m = new Map();
      for (const l of listas) {
        for (const x of l || []) {
          const k = norm(x.nome);
          let a = m.get(k);
          if (!a) { a = { id: 'v' + (m.size + 1), nome: x.nome, gab: null, sec: null, filas: {} }; m.set(k, a); }
          if (x.gab !== null && x.gab !== undefined) a.gab = (a.gab || 0) + (+x.gab || 0);
          if (x.sec !== null && x.sec !== undefined) a.sec = (a.sec || 0) + (+x.sec || 0);
          for (const f of Object.keys(x.filas || {})) a.filas[f] = (a.filas[f] || 0) + (+x.filas[f] || 0);
        }
      }
      return [...m.values()];
    }
    function consolidarVara(partes, nome) {
      const rs = partes.map((p) => p.ret);
      return { cod: 'g:VARA', nome, vara: true, ts: Math.min(...rs.map((r) => r.ts)), mesa: mesaSomada(rs),
        composicao: partes.map((p) => p.rotulo),
        agrupadores: somarPorNome(rs.map((r) => r.agrupadores)), localizadores: somarPorNome(rs.map((r) => r.localizadores)) };
    }

    /* Relevância de uma unidade (decisão dele, 17/10): o ACERVO ATIVO dela, medido na contagem pela Busca Avançada
     * só com a situação ATIVO (retrato.acervo). Vale no seletor (todas as unidades), na fila do ⟳ e na ordem das
     * competências da Vara. Antes da primeira medição, a ordem que ele deu para a Garantias; fora do alcance da
     * Busca, por último. Os 07 continuam contados antes dos OUTROS, na 1ª passada. */
    const ORDEM_GARANTIAS = ['INQUERITOS (CAPITAL)', 'INQUERITOS (INTERIOR)', 'INQUERITOS (VECUTE)', 'INQUERITOS (MEIO AMBIENTE)',
      'INQUERITOS (AUDITORIA MILITAR)', 'CUSTODIA'];
    function posFixa(nome) {
      const n = norm(nome);
      for (let i = 0; i < ORDEM_GARANTIAS.length; i++) if (n.indexOf(ORDEM_GARANTIAS[i]) >= 0) return i;
      return 99;
    }
    const acervoDe = (ret) => (ret && typeof ret.acervo === 'number' ? ret.acervo : null);
    const semAcervo = (x) => (x.acervo === null || x.acervo === undefined ? 1 : 0);
    // lista: [{rotulo, nome?, acervo?, fora?}]
    function porRelevancia(lista) {
      return lista.slice().sort((a, b) => ((a.fora ? 1 : 0) - (b.fora ? 1 : 0)) || (semAcervo(a) - semAcervo(b))
        || ((+b.acervo || 0) - (+a.acervo || 0)) || (posFixa(a.nome || a.rotulo) - posFixa(b.nome || b.rotulo))
        || a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
    }
    function ordemDeContagem(partes) {
      return porRelevancia(partes.map((p) => Object.assign({}, p, { acervo: acervoDe(p.ret), nome: p.u ? p.u.label : (p.ret ? p.ret.nome : p.rotulo) })));
    }

    return { norm, fmt, soma, acervoDe, porRelevancia, mesclarParcial, agruparUnidades, varaVirtual, arvoreDaVara, consolidarVara, ordemDeContagem, ehGarantias, ehProprio, opcoesDaUnidade, partes, montarArvore, ordenar, visiveis, folhas, radical, pontuar, buscar,
      prepararSinonimos, lerGruposDoUsuario, SINONIMOS, totalDeRegistros, opcoesDoAjax, desentidade,
      contarMesa, linhasDaFila, agrupadoresDoRetrato, localizadoresDoRetrato, itensDoMenu, urlDoMenu, CNJ,
      filasDaMesa, tabelaDireta, formDaBuscaNoDoc, agrupadoresDoForm, processosDaBusca, extratoHtml };
  })();

  if (typeof module !== 'undefined' && module.exports) { module.exports = PAL; return; }
  if (typeof window === 'undefined') return;

  /* ================================================================ navegador */
  const { norm, fmt } = PAL;
  const LS_CFG = 'pal.cfg.v1', LS_UI = 'pal.ui.v1', LS_RET = 'pal.retrato.v2', LS_UNI = 'pal.unidades.v1';
  // Competências que a Busca Avançada do perfil não alcança: fora da contagem da Vara (decisão dele, 17/10).
  const LS_FORA = 'pal.fora.v1';
  const SS_PEND = 'pal.pend', SS_TOP = 'pal.top';
  const BUSCA_URL = '/projudi/processo/buscaProcesso.do?actionType=iniciar';
  const COUNT_RE = /\((\d+)\)\s*$/;

  // A Prototype.js do Projudi altera Array.prototype.toJSON: a gravação neutraliza a alteração (ver o navegador).
  const toJson = (v) => {
    const own = Object.prototype.hasOwnProperty.call(Array.prototype, 'toJSON');
    const saved = Array.prototype.toJSON;
    if (own) delete Array.prototype.toJSON;
    try { return JSON.stringify(v); } finally { if (own) Array.prototype.toJSON = saved; }
  };
  const fixArrays = (o) => {
    if (typeof o === 'string' && /^\s*\[/.test(o)) { try { return fixArrays(JSON.parse(o)); } catch (_) { return o; } }
    if (Array.isArray(o)) return o.map(fixArrays);
    if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = fixArrays(o[k]); }
    return o;
  };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? fixArrays(JSON.parse(v)) : d; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, toJson(v)); } catch (_) { /* ignora */ } };
  const ssGet = (k) => { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (_) { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, toJson(v)); } catch (_) { /* ignora */ } };
  const ssDel = (k) => { try { sessionStorage.removeItem(k); } catch (_) { /* ignora */ } };

  const DEFAULTS = {
    hotkey: 'K', side: 'left', width: 440, fontSize: 12,
    cacheMin: 10,          // retrato da unidade ativa vale por estes minutos; depois, recontagem em segundo plano
    concorrencia: 3,       // consultas simultâneas à Busca Avançada
    zerados: false,        // mostrar itens sem processos
    semAgrupador: true,    // mostrar a linha "(sem agrupador)" com os conclusos sem agrupador
    sinonimos: '',         // grupos do usuário: uma linha por grupo, termos separados por vírgula
  };
  const cfg = Object.assign({}, DEFAULTS, lsGet(LS_CFG, {}) || {});
  const saveCfg = () => lsSet(LS_CFG, cfg);
  const ui = Object.assign({ crit: 'tot', open: {}, sel: '', panelW: 0, tabTop: null }, lsGet(LS_UI, {}) || {});
  if (!/^(tot|gab|sec)$/.test(ui.crit)) ui.crit = 'tot'; // 1.0.x guardava 'acervo' ou 'mesa'
  if (!ui.open || typeof ui.open !== 'object') ui.open = {};
  const saveUi = () => lsSet(LS_UI, ui);

  const hotkey = () => (/^[A-Za-z0-9]$/.test(cfg.hotkey || '') ? cfg.hotkey.toUpperCase() : 'K');
  const HOTKEY = (e) => e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && typeof e.key === 'string' && e.key.toUpperCase() === hotkey();

  /* ------------------------------------------------------------ rede (somente leitura) */
  const abs = (h, base) => new URL(h, base || location.href).href;
  // Codificação ISO-8859-1, usada pelo Projudi nos formulários.
  const enc = (s) => [...String(s)].map((ch) => {
    const c = ch.charCodeAt(0);
    if (/[A-Za-z0-9\-_.*]/.test(ch)) return ch;
    if (c === 32) return '+';
    return c < 256 ? '%' + c.toString(16).toUpperCase().padStart(2, '0') : encodeURIComponent(ch);
  }).join('');

  async function decodificar(r) {
    if (!r.ok) throw new Error('O Projudi respondeu HTTP ' + r.status + '.');
    const buf = await r.arrayBuffer();
    const cs = ((r.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1] || 'iso-8859-1';
    try { return new TextDecoder(cs).decode(buf); } catch (_) { return new TextDecoder('iso-8859-1').decode(buf); }
  }
  const EXPIRADA = 'Sessão do Projudi expirada. Faça login novamente; até lá o painel não conta nem atualiza a lista de unidades.';
  const erroExpirada = () => { const e = new Error(EXPIRADA); e.expirada = true; return e; };
  function paraDoc(txt, url) {
    if (/SessionExpired/i.test(url || '')) throw erroExpirada();
    const doc = new DOMParser().parseFromString(txt, 'text/html');
    if (doc.querySelector('input[type=password]')) throw erroExpirada();
    return doc;
  }
  async function getDoc(url) {
    const r = await fetch(url, { credentials: 'include' });
    const txt = await decodificar(r);
    return { url: r.url, doc: paraDoc(txt, r.url), txt };
  }
  async function getTexto(url) { return decodificar(await fetch(url, { credentials: 'include' })); }
  async function postDoc(url, pares) {
    const body = pares.map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
    const r = await fetch(url, { method: 'POST', credentials: 'include', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const txt = await decodificar(r);
    return { url: r.url, doc: paraDoc(txt, r.url), txt };
  }
  // Campos de um formulário como o navegador os enviaria (sem botões), em pares; set() troca ou acrescenta.
  function camposDe(form) {
    const p = [];
    for (const el of form.elements) {
      if (!el.name || el.disabled || /^(submit|button|reset|file|image)$/i.test(el.type)) continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      if (el.tagName === 'SELECT' && el.multiple) { for (const o of el.selectedOptions) p.push([el.name, o.value]); continue; }
      p.push([el.name, el.value]);
    }
    return p;
  }
  const comCampos = (pares, mudar) => {
    const out = pares.filter(([k]) => !(k in mudar));
    for (const k of Object.keys(mudar)) out.push([k, mudar[k]]);
    return out;
  };

  // Executa tarefas com no máximo n simultâneas.
  async function emLotes(tarefas, n, aoAvancar) {
    let i = 0, feitas = 0;
    const res = new Array(tarefas.length);
    async function trabalhador() {
      while (i < tarefas.length) {
        const k = i++;
        res[k] = await tarefas[k]();
        feitas++;
        if (aoAvancar) aoAvancar(feitas, tarefas.length);
      }
    }
    const ws = [];
    for (let w = 0; w < Math.max(1, Math.min(n, tarefas.length)); w++) ws.push(trabalhador());
    await Promise.all(ws);
    return res;
  }

  /* ------------------------------------------------ mesa e hierarquia (porte do Painel de Navegação) */
  const pretty = (s) => (s || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('pt-BR');
  const short = (s) => String(s || '')
    .replace(/\s+DA COMARCA DE MANAUS/gi, '')
    .replace(/N[ÚU]CLEO DA JUSTI[ÇC]A 4\.0/gi, 'NJ 4.0')
    .replace(/PREVIDENCI[ÁA]RIO/gi, 'PREV.')
    .replace(/E DE ACIDENTES DE TRABALHO/gi, 'E AC. TRAB.')
    .replace(/VARA DE GARANTIAS INQU[ÉE]RITOS - INQU[ÉE]RITOS/gi, 'GARANTIAS · INQUÉRITOS')
    .replace(/VARA DE GARANTIAS CUST[ÓO]DIA - CUST[ÓO]DIA/gi, 'GARANTIAS · CUSTÓDIA ')
    .replace(/CENTRAL DE PLANT[ÃA]O CRIMINAL - CRIMINAL/gi, 'GARANTIAS · PLANTÃO CRIMINAL')
    .replace(/\s+/g, ' ').trim();

  function splitLabel(t) {
    t = (t || '').replace(/\s+/g, ' ').trim();
    const m = t.match(COUNT_RE);
    return m ? { label: pretty(t.slice(0, m.index)), count: +m[1] } : null;
  }
  function contentDocs() {
    const out = [];
    const f = document.querySelector('iframe[name=userMainFrame]');
    try { if (f && f.contentDocument) out.push(f.contentDocument); } catch (_) { /* ignora */ }
    out.push(document);
    return out;
  }
  function crumbAnchors(doc) {
    return [...doc.querySelectorAll('a[href*="mesaJuiz.do"]')].filter((x) => {
      const t = x.textContent.replace(/\s+/g, ' ').trim();
      return t.length > 1 && !COUNT_RE.test(t) && !/^In[ií]cio$|^Alterar/i.test(t) && /_tj=/.test(x.getAttribute('href') || '');
    });
  }
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
  // Topo da hierarquia: a tela de escolha mais alta vista nesta sessão (em geral, a do login). Aproveita o
  // registro do Painel de Navegação quando ele existe.
  function captureTop() {
    if (document.querySelector('iframe[name=userMainFrame]')) return;
    const links = childLinks(document, location.href);
    if (!links.length) return;
    const depth = crumbAnchors(document).length;
    const cur = ssGet(SS_TOP);
    if (!cur || depth <= cur.depth) ssSet(SS_TOP, { depth, links });
  }
  async function topLinks() {
    for (const k of [SS_TOP, 'pnr.top']) {
      const t = ssGet(k);
      if (t && Array.isArray(t.links) && t.links.length) return t.links;
    }
    for (const d of contentDocs()) {
      const a = crumbAnchors(d)[0];
      if (a) { const pg = await getDoc(a.href); return childLinks(pg.doc, pg.url); }
    }
    // Aba nova (sessionStorage vazio) e sem quadro com a hierarquia: a tela de entrada da Mesa dá o topo.
    const raiz = await sessaoViva();
    const links = childLinks(raiz.doc, raiz.url);
    if (links.length) { ssSet(SS_TOP, { depth: 0, links }); return links; }
    throw new Error('Não localizei a tela inicial da mesa. Volte à tela inicial do Projudi (a que aparece logo após o login) e tente novamente.');
  }
  // Sessão caída nem sempre devolve a tela de login: o Projudi também responde com aviso de inatividade, página
  // vazia ou desvio ao portal (medido pelo MCP em 19/09/2026), e o painel lia isso como "sem unidade ativa".
  // A tela de entrada da Mesa (a mesma que o login entrega) tira a dúvida: viva, traz as competências ou a mesa.
  async function sessaoViva() {
    const pg = await getDoc(abs('/projudi/usuario/postLogon.do?actionType=iniciar'));
    if (!childLinks(pg.doc, pg.url).length && !pg.doc.querySelector('iframe[name=userMainFrame]')) throw erroExpirada();
    return pg;
  }
  async function walk(path) {
    let links = await topLinks();
    let cur = { doc: null, url: null, links };
    for (let i = 0; i < path.length; i++) {
      const next = links.find((l) => norm(l.label) === norm(path[i]));
      if (!next) {
        if (i === 0) ssDel(SS_TOP);
        throw new Error('Não localizei "' + path[i] + '" no Projudi. Volte à tela inicial do Projudi e atualize a lista de unidades.');
      }
      cur = await getDoc(next.url);
      cur.link = next;
      links = cur.links = childLinks(cur.doc, cur.url);
    }
    return cur;
  }
  function currentAtuacao() {
    for (const d of contentDocs()) {
      const a = d.querySelector('a[href*="areaAtuacao"]');
      if (a) return a.textContent.replace(/\s+/g, ' ').trim();
    }
    return null;
  }
  // Link "Início": leva à mesa da unidade ativa.
  function inicioUrl() {
    for (const d of contentDocs()) {
      const a = [...d.querySelectorAll('a[href*="mesaJuiz.do"]')].find((x) => /^In[ií]cio$/i.test(x.textContent.replace(/\s+/g, ' ').trim()));
      if (a) return abs(a.getAttribute('href'), d.location ? d.location.href : location.href);
    }
    return null;
  }

  const { filasDaMesa, tabelaDireta, formDaBuscaNoDoc } = PAL;

  // Filas da mesa. Unidade ativa: o quadro userMainFrame desta página nasce com a lista de filas (o src original
  // dele), sem precisar de navegação; na falta, o link Início. Outra unidade: pelo caminho, como o navegador.
  async function mesaDaUnidade(caminho) {
    const deShell = async (shell) => {
      if (PAL.filasDaMesa(shell.doc).length) return shell;
      const ifr = shell.doc.querySelector('iframe[name=userMainFrame]');
      if (!ifr) throw new Error('A unidade não abriu a mesa esperada.');
      return getDoc(abs(ifr.getAttribute('src'), shell.url));
    };
    if (caminho) return deShell(await walk(caminho));
    const f = document.querySelector('iframe[name=userMainFrame]');
    if (f && f.getAttribute('src')) {
      const m = await getDoc(abs(f.getAttribute('src')));
      if (PAL.filasDaMesa(m.doc).length) return m;
    }
    const u = inicioUrl();
    if (!u) throw new Error('Não localizei a mesa da unidade ativa. Volte à mesa (Início) e tente de novo.');
    return deShell(await getDoc(u));
  }

  /* ------------------------------------------------------------------------ contagem */
  // Formulário da Busca Avançada da unidade ativa; recusa quando o campo Vara não traz a unidade marcada
  // (sem marca, a busca cairia na primeira vara da lista, de outra comarca).
  async function formDaBusca() {
    const pg = await getDoc(abs(BUSCA_URL));
    let b;
    try { b = formDaBuscaNoDoc(pg.doc); } catch (e) {
      if (e.semUnidade) await sessaoViva(); // sessão caída vira aviso de sessão, não de unidade
      throw e;
    }
    return Object.assign(b, { pg, action: abs(b.form.getAttribute('action'), pg.url) });
  }

  async function identificarAtiva() {
    const b = await formDaBusca();
    return { cod: b.cod, nome: b.nome };
  }

  // Lê todas as filas de conclusão da mesa: linhas (processo, agrupador, fila) e a lista de agrupadores (com id).
  async function lerMesa(caminho, progresso) {
    const mesa = await mesaDaUnidade(caminho);
    const filas = filasDaMesa(mesa.doc).filter((q) => q.total > 0 && q.href);
    const linhas = [];
    let agrupadores = null;
    const lidas = [];
    for (let i = 0; i < filas.length; i++) {
      const q = filas[i];
      progresso('Mesa: lendo a fila ' + q.title + ' (' + (i + 1) + ' de ' + filas.length + ')…');
      let lst;
      try { lst = await getDoc(abs(q.href, mesa.url)); } catch (_) { continue; }
      const form = lst.doc.forms.processoConclusaoForm;
      if (!form) continue; // fila do cartório (ex.: audiências): fora da contagem
      if (!agrupadores || !agrupadores.length) agrupadores = PAL.agrupadoresDoForm(form);
      const action = abs(form.getAttribute('action') || lst.url, lst.url);
      const original = camposDe(form);
      let total = null, lidos = 0;
      try {
        for (let p = 1; p <= 60; p++) {
          const pg = await postDoc(action, comCampos(original, {
            preAnalisada: 'ambos', situacao: 'todas', loginAssessor: '', idAgrupador: '',
            conclusaoPageSize: '100', pagerConfigPageSize: '100', conclusaoPageNumber: String(p),
          }));
          if (total === null) total = PAL.totalDeRegistros(pg.doc.body ? pg.doc.body.textContent : '') || 0;
          const tab = tabelaDireta(pg.doc);
          const ls = PAL.linhasDaFila(tab, q.n > 1 ? q.title + ' (' + q.n + ')' : q.title);
          for (const l of ls) linhas.push(l);
          lidos += ls.length;
          if (!ls.length || lidos >= total) break;
        }
      } finally {
        try { await postDoc(action, original); } catch (_) { /* a tela volta ao filtro original no próximo uso */ }
      }
      lidas.push({ fila: q.title, n: q.n, total });
    }
    return { linhas, agrupadores, filas: lidas };
  }

  async function agrupadoresPeloAjax(cod) {
    const txt = await getTexto(abs('/projudi/processo/buscaProcesso.do?actionType=ajaxUpdateTiposAgrupador&codVara=' + encodeURIComponent(cod)));
    return PAL.opcoesDoAjax(txt);
  }

  /* Conta a unidade ativa e grava o retrato. caminho: rótulos até a unidade (quando veio por troca).
   * Na Vara de Garantias, os itens 07 são contados e gravados antes dos OUTROS (decisão dele, 17/10).
   * opcoes.so: '07' | 'outros' conta só essa fase (as duas passadas da Vara inteira); opcoes.mesa: a Mesa já lida
   * na passada anterior ({mesa, agrs, erroMesa}), para não relê-la; O painel se redesenha a cada gravação. */
  async function contarAtiva(caminho, progresso, opcoes) {
    opcoes = opcoes || {};
    progresso('Abrindo a Busca Avançada…');
    const b = await formDaBusca();
    const locs = b.localizadores;
    let mesa = null, agrs = null, erroMesa = null;
    if (opcoes.mesa) ({ mesa, agrs, erroMesa } = opcoes.mesa);
    else {
      try {
        const m = await lerMesa(caminho, progresso);
        agrs = m.agrupadores;
        mesa = PAL.contarMesa(m.linhas);
        mesa.filas = m.filas;
      } catch (e) { erroMesa = e.message; }
    }
    if (!agrs || !agrs.length) {
      try { agrs = await agrupadoresPeloAjax(b.cod); } catch (_) { agrs = agrs || []; }
    }
    const base = comCampos(camposDe(b.form), { idStatus: '0', processoPageSize: '10', processoPageNumber: '1' });
    const conclusos = mesa ? mesa.conclusos : null;
    const buscaAgr = {}, totalLoc = {}, procLoc = {};
    const post = async (pares) => {
      for (let tent = 0; ; tent++) {
        try { return await postDoc(b.action, pares); } catch (e) { if (tent || /expirada/.test(e.message)) throw e; }
      }
    };
    const totalDe = (pg) => PAL.totalDeRegistros(pg.doc.body ? pg.doc.body.textContent : '');
    // Agrupador: só o total (secretaria; a Mesa já deu o gabinete).
    const contarAgr = (id) => async () => {
      buscaAgr[id] = totalDe(await post(comCampos(base, { idAgrupador: id, idLocalizador: '-1' })));
    };
    // Localizador: total e, havendo conclusos na Mesa, os números de processo (100 por página) para separar o
    // gabinete da secretaria pela interseção.
    const contarLoc = (id) => async () => {
      const separar = conclusos && conclusos.size > 0;
      const tam = separar ? '100' : '10';
      const pg1 = await post(comCampos(base, { idLocalizador: id, idAgrupador: '', processoPageSize: tam }));
      const total = totalDe(pg1);
      totalLoc[id] = total;
      if (!separar || !total) return;
      const vistos = new Set(PAL.processosDaBusca(pg1.doc));
      for (let p = 2; vistos.size < total && p <= Math.ceil(total / 100) + 1; p++) {
        const pg = await post(comCampos(base, { idLocalizador: id, idAgrupador: '', processoPageSize: '100', processoPageNumber: String(p) }));
        const ns = PAL.processosDaBusca(pg.doc);
        if (!ns.length) break;
        for (const n of ns) vistos.add(n);
      }
      procLoc[id] = [...vistos];
    };
    // Caminho da unidade na hierarquia: o da troca, ou o da lista de unidades pelo nome (para abrir listas dela
    // quando ela não for mais a ativa).
    // Acervo ativo da unidade (a relevância dela): a Busca só com a situação ATIVO, sem agrupador nem localizador.
    let acervo = null;
    if (opcoes.so !== 'outros') {
      progresso('Medindo o acervo ativo…');
      try { acervo = totalDe(await post(comCampos(base, { idAgrupador: '', idLocalizador: '-1' }))); } catch (_) { acervo = null; }
    }
    const daLista = unidades().find((u) => norm(u.label) === norm(b.nome));
    const proprio = PAL.opcoesDaUnidade(b.nome).proprio;
    const fases = !proprio ? [null] : opcoes.so ? [opcoes.so] : ['07', 'outros'];
    const contados = { agr: new Set(), loc: new Set() };
    const anterior = (lsGet(LS_RET, {}) || {})[b.cod] || null;
    const lotes = Math.max(1, Math.min(6, +cfg.concorrencia || 3));
    let retrato = null;
    for (const fase of fases) {
      const entra = (nome) => fase === null || (fase === '07') === proprio(nome);
      const tarefas = [];
      for (const a of agrs) if (entra(a.nome)) { tarefas.push(contarAgr(a.id)); contados.agr.add(String(a.id)); }
      for (const l of locs) if (entra(l.nome)) { tarefas.push(contarLoc(l.id)); contados.loc.add(String(l.id)); }
      const rot = fase === '07' ? 'Itens 07' : fase === 'outros' ? 'OUTROS' : 'Gabinete e secretaria';
      await emLotes(tarefas, lotes, (f, t) => progresso(rot + ': contando ' + f + ' de ' + t + '…'));
      // O que esta chamada ainda não contou vem do retrato anterior; "parcial" diz que os OUTROS são de antes.
      const parcial = fase === '07';
      retrato = {
        cod: b.cod, nome: b.nome, ts: Date.now(), caminho: caminho || (daLista ? daLista.caminho : null),
        agrupadores: PAL.mesclarParcial(PAL.agrupadoresDoRetrato(agrs, buscaAgr, mesa), anterior && anterior.agrupadores, (x) => contados.agr.has(String(x.id)), 'agr'),
        localizadores: PAL.mesclarParcial(PAL.localizadoresDoRetrato(locs, totalLoc, procLoc, conclusos), anterior && anterior.localizadores, (x) => contados.loc.has(String(x.id)), 'loc'),
        mesa: mesa ? { total: mesa.total, semAgrupador: mesa.semAgrupador, filas: mesa.filas } : null,
        erroMesa,
        acervo: typeof acervo === 'number' ? acervo : PAL.acervoDe(anterior),
      };
      if (parcial) { retrato.parcial = true; retrato.tsOutros = anterior ? (anterior.parcial ? anterior.tsOutros || null : anterior.ts) : null; }
      const todos = lsGet(LS_RET, {}) || {};
      todos[b.cod] = retrato;
      lsSet(LS_RET, todos);
      if (panel.classList.contains('on') && !showingCfg) render(); // os 07 aparecem antes de os OUTROS terminarem
    }
    // A Mesa lida segue para a passada seguinte (não vai ao armazenamento: o conjunto de conclusos não se serializa).
    retrato._mesa = { mesa, agrs, erroMesa };
    return retrato;
  }

  // Lista de unidades: percorre a hierarquia da mesa (como o Painel de Navegação), inclusive as que não têm
  // conclusos, pois o acervo existe mesmo sem conclusão. Restaura a Atuação ao final.
  async function listarUnidades(progresso) {
    const original = currentAtuacao();
    const units = [];
    async function explorar(caminho, links, prof) {
      for (const k of links) {
        if (caminho.some((p) => norm(p) === norm(k.label))) continue;
        const p = caminho.concat(k.label);
        progresso('Unidades: lendo ' + p.map(short).join(' › ') + '…');
        let pg;
        try { pg = await walk(p); } catch (e) { if (e.expirada) throw e; continue; }
        if (pg.doc.querySelector('iframe[name=userMainFrame]')) units.push({ caminho: p, label: k.label, count: k.count });
        else if (prof < 6) await explorar(p, pg.links, prof + 1);
      }
    }
    await explorar([], await topLinks(), 0);
    // Nenhuma unidade: não grava a lista vazia por cima da anterior; diz se foi a sessão.
    if (!units.length) {
      await sessaoViva();
      throw new Error('A leitura não achou nenhuma unidade; a lista anterior foi mantida. Volte à tela inicial do Projudi e tente de novo.');
    }
    const lista = { ts: Date.now(), units };
    lsSet(LS_UNI, lista);
    await restaurar(original, units, progresso);
    return lista;
  }

  async function restaurar(atuacao, units, progresso) {
    if (!atuacao) return null;
    const alvo = norm(atuacao);
    const cands = [];
    for (const u of units || []) {
      const n = norm(u.label);
      if (n === alvo || n.startsWith(alvo) || alvo.startsWith(n)) cands.push({ u, score: u.caminho.slice(0, -1).filter((s) => alvo.includes(norm(s))).length });
    }
    cands.sort((x, y) => y.score - x.score);
    if (!(cands.length === 1 || (cands.length > 1 && cands[0].score > cands[1].score))) return null;
    if (progresso) progresso('Restaurando a Atuação: ' + short(cands[0].u.label));
    await walk(cands[0].u.caminho);
    return cands[0].u.label;
  }

  // Conta outra unidade: troca a Atuação, conta e restaura a original.
  async function contarOutra(unidade, progresso) {
    const original = currentAtuacao();
    const units = (lsGet(LS_UNI, null) || { units: [] }).units;
    let r;
    try {
      progresso('Trocando a Atuação para ' + short(unidade.label) + '…');
      await walk(unidade.caminho);
      r = await contarAtiva(unidade.caminho, progresso);
    } finally {
      const ok = await restaurar(original, units, progresso).catch(() => null);
      if (original && !ok) toast('Atenção: não consegui restaurar a Atuação original. Reabra a unidade antes de trabalhar.');
    }
    return r;
  }

  /* ------------------------------------------------------------- navegação no clique */
  // As telas de destino abrem dentro da mesa (quadro userMainFrame). O pedido viaja em sessionStorage e é
  // executado pelo script na carga da tela de destino (preencher o filtro e pesquisar).
  async function abrirBusca(ret, item, tipo) {
    const pend = { acao: 'busca', tipo, id: item.id, nome: item.nome, cod: ret.cod, ts: Date.now() };
    const ativa = await identificarAtiva().catch(() => null);
    if (ativa && ativa.cod === ret.cod) {
      const f = document.querySelector('iframe[name=userMainFrame]');
      ssSet(SS_PEND, pend);
      if (f) { f.src = BUSCA_URL; toggle(false); } else location.href = BUSCA_URL;
      return;
    }
    if (!ret.caminho) throw new Error('Para abrir a lista de outra unidade, conte-a antes pelo ⟳ (o painel precisa do caminho dela).');
    setStatus('Abrindo ' + short(ret.nome) + '…');
    const shell = await walk(ret.caminho);
    ssSet(SS_PEND, Object.assign(pend, { acao: 'shellBusca' }));
    location.href = shell.link.url;
  }

  async function abrirFila(ret, item, fila) {
    const m = String(fila).match(/^(.*) \((\d+)\)$/);
    const q = m ? m[1] : fila, n = m ? +m[2] : 1;
    const pend = { acao: 'fila', q, n, id: item.id, nome: item.nome, ts: Date.now() };
    const ativa = await identificarAtiva().catch(() => null);
    const f = document.querySelector('iframe[name=userMainFrame]');
    if (ativa && ativa.cod === ret.cod && f) {
      // Unidade ativa: o link da fila sai fresco da mesa e abre direto no quadro, já com o filtro pendente.
      const mesa = await mesaDaUnidade(null);
      const cel = PAL.filasDaMesa(mesa.doc).find((c) => norm(c.title) === norm(q) && c.n === n);
      if (!cel || !cel.href) throw new Error('Não localizei a fila "' + q + '" na mesa.');
      ssSet(SS_PEND, Object.assign(pend, { acao: 'mesa' }));
      try { sessionStorage.setItem('pnr.cfFlag', 'auto'); } catch (_) { /* ignora */ }
      f.src = abs(cel.href, mesa.url);
      toggle(false);
      return;
    }
    if (!ret.caminho) throw new Error('Não localizei a mesa desta unidade. Conte-a antes pelo ⟳.');
    const shell = await walk(ret.caminho);
    ssSet(SS_PEND, pend);
    location.href = shell.link.url;
  }

  /* Abre uma tela do menu da mesa (add_menu na página do quadro principal) com um pedido pendente.
   * Usado por "Conclusões › Todas" (gabinete do agrupador, todas as filas de uma vez) e
   * "Conclusões › Buscar Conclusões" (gabinete do localizador). */
  async function abrirMenu(ret, secao, rotulo, pend) {
    const ativa = await identificarAtiva().catch(() => null);
    const f = document.querySelector('iframe[name=userMainFrame]');
    if (ativa && ativa.cod === ret.cod && f) {
      const url = PAL.urlDoMenu(document.documentElement.innerHTML, secao, rotulo);
      if (!url) throw new Error('Não localizei "' + secao + ' › ' + rotulo + '" no menu desta página. Volte à mesa da unidade e tente de novo.');
      ssSet(SS_PEND, Object.assign({ ts: Date.now() }, pend));
      try { sessionStorage.setItem('pnr.cfFlag', 'auto'); } catch (_) { /* ignora */ }
      f.src = abs(url);
      toggle(false);
      return;
    }
    if (!ret.caminho) throw new Error('Não localizei a mesa desta unidade. Conte-a antes pelo ⟳.');
    setStatus('Abrindo ' + short(ret.nome) + '…');
    const shell = await walk(ret.caminho);
    ssSet(SS_PEND, Object.assign({ ts: Date.now() }, pend, { acao: 'shellMenu', depois: pend.acao, secao, rotulo }));
    location.href = shell.link.url;
  }

  const recente = (p) => p && Date.now() - p.ts < 60000;
  const botao = (form, re) => [...form.querySelectorAll('input[type=submit],input[type=button],button')].find((b) => re.test(b.value || b.textContent || ''));
  function garantirOpcao(sel, id, nome) {
    if (!sel) return false;
    let o = [...sel.options].find((x) => x.value === String(id));
    if (!o) { o = sel.ownerDocument.createElement('option'); o.value = String(id); o.textContent = nome; sel.appendChild(o); }
    sel.value = String(id);
    return true;
  }
  function avisar(msg) {
    try { top.frames['mainFrame'].postMessage({ pal: 'aviso', msg }, location.origin); } catch (_) { /* sem mainFrame */ }
  }

  // Executa o pedido pendente na tela em que o script acabou de carregar (qualquer quadro).
  function executarPendente() {
    const p = ssGet(SS_PEND);
    if (!p) return;
    if (!recente(p)) { ssDel(SS_PEND); return; }
    const d = document;
    if (p.acao === 'busca' && d.forms.processoBuscaForm) {
      ssDel(SS_PEND);
      const form = d.forms.processoBuscaForm;
      const cv = form.querySelector('select[name=codVara] option[selected]');
      if (!cv || cv.value !== p.cod) { avisar('A Busca Avançada abriu em outra unidade; a lista não foi filtrada.'); return; }
      if (form.elements.idStatus) form.elements.idStatus.value = '0';
      if (p.tipo === 'loc') { if (form.elements.idLocalizador) form.elements.idLocalizador.value = p.id; }
      else garantirOpcao(form.querySelector('select[name=idAgrupador]'), p.id, p.nome);
      const b = botao(form, /pesquisar|buscar/i);
      if (b) b.click(); else form.submit();
      return;
    }
    if (p.acao === 'mesa' && d.forms.processoConclusaoForm) {
      ssDel(SS_PEND);
      const form = d.forms.processoConclusaoForm;
      const r = (name, value) => form.querySelector('input[type=radio][name="' + name + '"][value="' + value + '"]');
      const rp = r('preAnalisada', 'ambos'), rs = r('situacao', 'todas');
      if (rp) rp.checked = true;
      if (rs) rs.checked = true;
      if (form.elements.loginAssessor) form.elements.loginAssessor.value = '';
      garantirOpcao(form.querySelector('select[name=idAgrupador]'), p.id, p.nome);
      if (form.elements.conclusaoPageNumber) form.elements.conclusaoPageNumber.value = '1';
      // O filtro automático do Painel de Navegação não sobrepõe este (ele se cala quando acha a marca).
      try { sessionStorage.setItem('pnr.cfFlag', 'auto'); } catch (_) { /* ignora */ }
      const b = botao(form, /filtrar/i);
      if (b) b.click(); else form.submit();
      return;
    }
    if (p.acao === 'concLoc' && d.forms.buscaConclusoes1GrauForm) {
      ssDel(SS_PEND);
      const form = d.forms.buscaConclusoes1GrauForm;
      garantirOpcao(form.querySelector('select[name=codTipoLocalizador]'), p.id, p.nome);
      const rp = form.querySelector('input[type=radio][name=pessoal][value=sim]');
      if (rp) rp.checked = true;
      const b = botao(form, /pesquisar|buscar/i);
      if (b) b.click(); else form.submit();
      return;
    }
    if (window.name !== 'mainFrame') return;
    // Etapas do quadro principal: esperar a mesa carregar e seguir para o destino.
    if (p.acao === 'shellBusca' || p.acao === 'fila' || p.acao === 'shellMenu') {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (Date.now() - t0 > 25000) { clearInterval(iv); ssDel(SS_PEND); toast('A unidade abriu, mas não consegui seguir até a lista.'); return; }
        const f = document.querySelector('iframe[name=userMainFrame]');
        let fd = null;
        try { fd = f && f.contentDocument; } catch (_) { fd = null; }
        if (!fd || fd.readyState !== 'complete') return;
        if (p.acao === 'shellBusca') {
          clearInterval(iv);
          ssSet(SS_PEND, Object.assign({}, p, { acao: 'busca', ts: Date.now() }));
          f.src = BUSCA_URL;
          return;
        }
        if (p.acao === 'shellMenu') {
          clearInterval(iv);
          const url = PAL.urlDoMenu(document.documentElement.innerHTML, p.secao, p.rotulo);
          if (!url) { ssDel(SS_PEND); toast('A unidade abriu, mas o menu não trouxe "' + p.rotulo + '".'); return; }
          ssSet(SS_PEND, Object.assign({}, p, { acao: p.depois, ts: Date.now() }));
          try { sessionStorage.setItem('pnr.cfFlag', 'auto'); } catch (_) { /* ignora */ }
          f.src = abs(url);
          return;
        }
        const cel = filasDaMesa(fd).find((c) => norm(c.title) === norm(p.q) && c.n === (p.n || 1));
        if (!cel) return;
        const a = [...fd.querySelectorAll('a[href]')].find((x) => x.getAttribute('href') === cel.href);
        if (!a) return;
        clearInterval(iv);
        ssSet(SS_PEND, Object.assign({}, p, { acao: 'mesa', ts: Date.now() }));
        try { sessionStorage.setItem('pnr.cfFlag', 'auto'); } catch (_) { /* ignora */ }
        a.click();
      }, 300);
    }
  }

  // Quadros que não são o principal: repassam o atalho e executam o pedido pendente.
  if (window.name !== 'mainFrame') {
    document.addEventListener('keydown', (e) => {
      if (!HOTKEY(e)) return;
      e.preventDefault();
      try { top.frames['mainFrame'].postMessage({ pal: 'toggle' }, location.origin); } catch (_) { /* sem mainFrame */ }
    }, true);
    // Clique ou Esc em qualquer outro quadro da página (mesa, conclusões, cabeçalho) fecha os painéis, que vivem no
    // quadro principal (ver abasDoProjudi). Uma vez por quadro, qualquer que seja o script que chegue primeiro.
    if (!window.__projudiAbasQuadro) {
      window.__projudiAbasQuadro = true;
      const avisar = () => { try { top.frames['mainFrame'].postMessage({ projudiAbas: 'fechar' }, location.origin); } catch (_) { /* sem mainFrame */ } };
      document.addEventListener('pointerdown', avisar, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') avisar(); }, true);
    }
    try { executarPendente(); } catch (_) { /* nunca atrapalhar a tela do Projudi */ }
    return;
  }

  /* ---------------------------------------------------------------------------- tela */
  const ACC = '#3f5a73', ACC_D = '#2f4659', ACC_L = 'rgba(63,90,115,.35)';
  const host = document.createElement('div');
  host.id = 'pal-host';
  host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host{all:initial}
  *{box-sizing:border-box;font-family:Verdana,Arial,sans-serif}
  button,input,select,textarea{font-family:inherit}
  .tab{position:fixed;top:220px;background:${ACC};border:none;padding:8px 5px;line-height:0;font-size:0;
       cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,.35);touch-action:none;user-select:none}
  .tab canvas{display:block;pointer-events:none}
  .tab.right{right:0;border-radius:6px 0 0 6px}
  .tab.left{left:0;border-radius:0 6px 6px 0}
  .tab.ativa{filter:brightness(.8);box-shadow:inset 0 0 0 2px rgba(255,255,255,.55)}
  .tab:hover,.tab.dragging{background:${ACC_D}}
  .tab.dragging{cursor:grabbing}
  .panel{position:fixed;top:0;height:100vh;max-width:100vw;background:#fbfaf5;box-shadow:0 0 14px rgba(0,0,0,.25);
         display:none;flex-direction:column;font-size:12px;color:#222}
  .panel.right{right:0;border-left:3px solid ${ACC}}
  .panel.left{left:0;border-right:3px solid ${ACC}}
  .panel.on{display:flex}
  .grip{position:absolute;top:0;bottom:0;width:9px;cursor:ew-resize;z-index:5;touch-action:none}
  .panel.right .grip{left:-6px}.panel.left .grip{right:-6px}
  .grip:hover,.grip.drag{background:${ACC_L}}
  .panel.resizing{user-select:none}
  header{background:${ACC};color:#fff;padding:8px 10px;display:flex;align-items:center;gap:6px}
  header b{flex:1;font-size:12px;letter-spacing:.3px}
  header button{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:4px;cursor:pointer;font-size:12px;padding:2px 7px;line-height:1.2}
  header button:hover,header button.on{background:rgba(255,255,255,.18)}
  header button[hidden]{display:none}
  header button.save{background:#fff;color:${ACC_D};border-color:#fff;font-weight:bold}
  .bar{padding:8px 10px;border-bottom:1px solid #ddd8c4;background:#eef0ec;display:flex;flex-direction:column;gap:6px}
  input[type=search]{width:100%;padding:6px 8px;border:1px solid #a9b2b8;border-radius:4px;font-size:12px}
  .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .row select{flex:1;min-width:0}
  .row[hidden]{display:none}
  .pdfmenu{background:#fff;border:1px solid #c7ced2;border-radius:4px;padding:4px 6px}
  select{font-size:11px;padding:3px;border:1px solid #a9b2b8;border-radius:4px;max-width:100%;background:#fff}
  .seg{display:inline-flex}
  .seg button{border:1px solid ${ACC};background:#fff;color:${ACC};padding:3px 9px;font-size:11px;cursor:pointer}
  .seg button:first-child{border-radius:4px 0 0 4px}.seg button:last-child{border-radius:0 4px 4px 0}
  .seg button+button{border-left:none}
  .seg button.on{background:${ACC};color:#fff}
  .btn{border:1px solid #8a9298;background:#fff;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;color:#333}
  .btn:hover{background:#e4e8ea}
  .btn.on{background:${ACC};color:#fff;border-color:${ACC}}
  .btn:disabled{opacity:.5;cursor:default}
  .lbl{font-size:11px;color:#444}
  .status{font-size:10px;color:#666;min-height:12px}
  .status.err{color:#b00020;font-weight:bold}
  .body{flex:1;overflow:auto;padding:6px 8px 20px}
  details{margin:1px 0}
  summary{cursor:pointer;padding:3px 4px;border-radius:3px;list-style:none;display:flex;align-items:center;gap:6px}
  summary::-webkit-details-marker{display:none}
  summary::before{content:'▸';color:${ACC};width:10px;flex:none}
  details[open]>summary::before{content:'▾'}
  summary:hover{background:#e4e8ea}
  .sec>summary{font-weight:bold;color:${ACC_D};background:#dde3e7;padding:5px 4px;margin-top:6px}
  .g{margin-left:12px}
  .g>summary .r{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:bold;color:#3a3f43}
  .g>summary small{color:#888;font-size:9px;font-weight:normal}
  .it{display:flex;align-items:center;gap:4px;margin-left:28px;padding:2px 4px;border-bottom:1px dotted #e0e3e5}
  .sec>.it{margin-left:30px}
  .it .r{flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .it .r:hover{text-decoration:underline}
  .n{font-size:10px;min-width:58px;text-align:right;font-variant-numeric:tabular-nums;flex:none;border:1px solid transparent;border-radius:9px;padding:1px 6px}
  .n.g{color:#7a5b16;font-weight:bold}
  .n.s{color:${ACC_D};font-weight:bold}
  .n.g:not(.na){border-color:#c7a85a;background:#fff;cursor:pointer}
  .n.s:not(.na){border-color:${ACC};background:#fff;cursor:pointer}
  .n.g:not(.na):hover,.n.g.on{background:#c7a85a;color:#fff}
  .n.s:not(.na):hover{background:${ACC};color:#fff}
  .n.z{opacity:.35}
  .n.na{cursor:default}
  .colhead{position:sticky;top:-6px;z-index:2;display:flex;align-items:center;gap:6px;padding:4px 4px 3px;background:#fbfaf5;border-bottom:1px solid #d6dadc}
  .colhead .r{flex:1}
  .colhead .n{font-size:9px;text-transform:uppercase;letter-spacing:.4px;font-weight:bold}
  .sec>summary .r{flex:1}
  .sum{font-size:10px;color:#555;flex:none;font-variant-numeric:tabular-nums}
  .sub{margin-left:44px;display:flex;gap:6px;align-items:center;padding:2px 4px;background:#f7f1e1;font-size:11px;cursor:pointer;border-bottom:1px dotted #e6dcc0}
  .sub:hover{background:#efe3c2}
  .sub .r{flex:1}
  .res{padding:4px 6px;border-radius:4px;display:flex;gap:6px;align-items:center;cursor:pointer}
  .res.sel,.res:hover{background:#e4e8ea}
  .res .p{flex:1;min-width:0}
  .res.zero{opacity:.5}
  .res small{display:block;color:#777;font-size:10px}
  .res .tipo{font-size:9px;color:#fff;background:${ACC};border-radius:3px;padding:0 4px;flex:none}
  .res .tipo.loc{background:#6b7f5a}
  .empty{color:#666;padding:16px 8px;line-height:1.5}
  .foot{font-size:10px;color:#777;padding:8px 4px 0;line-height:1.4}
  .toast{position:fixed;bottom:16px;left:16px;background:#333;color:#fff;padding:8px 12px;border-radius:5px;font-size:12px;display:none;max-width:380px}
  .toast.on{display:block}
  .cfg{display:flex;flex-direction:column;gap:12px}
  .cfg fieldset{border:1px solid #d6dadc;border-radius:5px;padding:8px 10px;margin:0;display:flex;flex-direction:column;gap:7px}
  .cfg legend{font-weight:bold;color:${ACC_D};font-size:11px;padding:0 4px}
  .cfg label{display:flex;gap:6px;align-items:center;font-size:11px}
  .cfg label.col{flex-direction:column;align-items:stretch;gap:3px}
  .cfg .hint{font-size:10px;color:#777;line-height:1.4}
  .cfg textarea{width:100%;min-height:110px;font:11px Consolas,monospace;padding:4px;border:1px solid #a9b2b8;border-radius:3px}
  input[type=number],input[type=text].k{width:60px;font-size:11px;padding:2px 4px;border:1px solid #a9b2b8;border-radius:3px}
</style>
<button class="tab" data-a="tab"></button>
<div class="panel">
  <div class="grip" title="Arraste para ajustar a largura. Clique duas vezes para recolher o painel."></div>
  <header>
    <b>Agrupadores e Localizadores</b>
    <button data-a="cfg" title="Configurações">⚙</button>
    <button data-a="close" title="Fechar (Esc)">✕</button>
    <button class="save" data-a="cfgsave" data-cfgbtn hidden>Salvar</button>
    <button data-a="cfgback" data-cfgbtn hidden>Voltar</button>
  </header>
  <div class="bar main-bar">
    <div class="row"><select data-a="unid" title="Unidade exibida"></select><button class="btn" data-a="contar" title="Contar de novo esta unidade">⟳</button></div>
    <input type="search" placeholder="Buscar por sentido (ex.: prisão, bloqueio de valores, aguarda MP)" />
    <div class="row">
      <span class="lbl">Ordem:</span><span class="seg" data-ordem><button data-crit="tot" title="Mais processos no total (gabinete + secretaria) primeiro">Total</button><button data-crit="gab" title="Mais conclusos no gabinete primeiro">Gabinete</button><button data-crit="sec" title="Mais processos na secretaria primeiro">Secretaria</button></span>
      <button class="btn" data-t="expand">Expandir</button><button class="btn" data-t="collapse">Recolher</button><button class="btn" data-t="zeros" title="Mostrar itens sem processos">Zerados</button><button class="btn" data-a="pdf" title="Exportar o extrato analítico em PDF">PDF</button>
    </div>
    <div class="row pdfmenu" hidden>
      <span class="lbl">Extrato em PDF:</span><button class="btn" data-a="pdf1">Esta unidade</button><button class="btn" data-a="pdfall">Todas com retrato</button>
    </div>
    <div class="row pdfmenu pdfgar" hidden>
      <span class="lbl">Vara de Garantias:</span><button class="btn" data-a="pdf07" title="Só os agrupadores e localizadores que começam por 07">Só os 07</button><button class="btn" data-a="pdfout" title="Os 07 e, no fim, o ramo OUTROS">07 e OUTROS</button>
    </div>
    <div class="status"></div>
  </div>
  <div class="body"></div>
</div>
<div class="toast"></div>`;

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel'), body = $('.body'), search = $('input[type=search]'), statusEl = $('.status'), tab = $('.tab'), grip = $('.grip'), unidSel = $('select[data-a=unid]');
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
  const abas = abasDoProjudi({ id: 'agrupadores', ordem: 0, tab, host, aberto: () => panel.classList.contains('on'),
    largura: () => panel.getBoundingClientRect().width, fechar: () => toggle(false), aplicar: () => applyLayout() });

  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function setStatus(msg, err) { statusEl.textContent = msg || ''; statusEl.classList.toggle('err', !!err); }
  function toast(msg) { const t = $('.toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 7000); }
  // Erro na tela; a sessão vencida também vai ao balão, para não passar despercebida.
  function falhou(e) { setStatus(e.message, true); if (e.expirada) toast(e.message); }

  let showingCfg = false, busy = false, ativaCod = null, results = [], sel = 0;
  const gabAberto = new Set();

  /* layout (porte do Painel de Navegação) */
  const PANEL_MIN = 280;
  const maxWidth = () => Math.max(PANEL_MIN, +cfg.width || 440);
  const panelWidth = () => { const w = +ui.panelW || 0; return w ? Math.max(PANEL_MIN, Math.min(maxWidth(), w)) : maxWidth(); };
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
  function applyLayout() {
    const side = abas.lado();
    host.style.left = side === 'left' ? '0' : '';
    host.style.right = side === 'right' ? '0' : '';
    panel.classList.remove('left', 'right'); panel.classList.add(side);
    tab.classList.remove('left', 'right'); tab.classList.add(side);
    const z = Math.max(0.75, Math.min(1.5, (+cfg.fontSize || 12) / 12));
    panel.style.zoom = z;
    panel.style.width = Math.round(panelWidth() / z) + 'px';
    panel.style.height = Math.round(100 / z) + 'vh';
    tabLabel('AGRUPADORES');
    tab.title = 'Agrupadores e Localizadores · atalho Alt+' + hotkey() + '. Arraste para cima ou para baixo para mover as abas.';
    placeTab();
  }

  /* dados exibidos */
  const retratos = () => lsGet(LS_RET, {}) || {};
  const unidades = () => (lsGet(LS_UNI, null) || { units: [] }).units || [];
  const gruposBusca = () => PAL.prepararSinonimos(PAL.SINONIMOS.concat(PAL.lerGruposDoUsuario(cfg.sinonimos)));
  // Retrato de uma unidade da lista: pelo caminho, ou pelo nome (o da Busca Avançada e o da mesa coincidem
  // sem acento e caixa).
  const retratoDaUnidade = (rs, u) => Object.values(rs).find((x) => (x.caminho && x.caminho.join('|') === u.caminho.join('|')) || norm(x.nome) === norm(u.label)) || null;
  // Vara de Garantias inteira: competências da lista de unidades (e retratos da Garantias fora dela).
  const VARA = 'g:GARANTIAS';
  const rotuloComp = (s) => short(s).replace(/^GARANTIAS · \s*/i, '').toLocaleUpperCase('pt-BR');
  const foraDoAlcance = () => new Set(lsGet(LS_FORA, []) || []);
  function marcarFora(label, fora) {
    const f = foraDoAlcance();
    if (fora) f.add(norm(label)); else f.delete(norm(label));
    lsSet(LS_FORA, [...f]);
  }
  // Competências da Vara; as fora do alcance da Busca vêm marcadas (fora) e ficam fora da contagem e do PDF.
  function competencias() {
    const rs = retratos(), vistos = new Set(), out = [], fora = foraDoAlcance();
    for (const u of unidades()) {
      if (!PAL.ehGarantias(u.label)) continue;
      const r = retratoDaUnidade(rs, u);
      if (r) vistos.add(r.cod);
      out.push({ u, cod: r ? r.cod : null, rotulo: rotuloComp(u.label), ret: r, fora: fora.has(norm(u.label)) });
    }
    for (const r of Object.values(rs)) if (PAL.ehGarantias(r.nome) && !vistos.has(r.cod)) out.push({ u: null, cod: r.cod, rotulo: rotuloComp(r.nome), ret: r });
    return PAL.ordemDeContagem(out);
  }
  const contadas = () => competencias().filter((p) => p.ret && !p.fora);
  const naVara = () => competencias().filter((p) => !p.fora);
  function retratoExibido() {
    const rs = retratos();
    if (ui.sel === VARA) { const ps = contadas(); return ps.length ? PAL.varaVirtual(ps, 'VARA DE GARANTIAS') : null; }
    if (ui.sel && ui.sel.indexOf('u:') !== 0 && rs[ui.sel]) return rs[ui.sel];
    if (ui.sel && ui.sel.indexOf('u:') === 0) {
      const u = unidades().find((x) => 'u:' + x.caminho.join('|') === ui.sel);
      return u ? retratoDaUnidade(rs, u) : null;
    }
    if (ativaCod) return rs[ativaCod] || null;
    // Sem unidade ativa na sessão: o retrato mais recente, para o painel não abrir vazio.
    return Object.values(rs).sort((x, y) => y.ts - x.ts)[0] || null;
  }
  const exibindoAtiva = () => !ui.sel || ui.sel === ativaCod;
  const hora = (ts) => { const d = new Date(ts); return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };

  function preencherUnidades() {
    const rs = retratos();
    const ops = [];
    const ativa = ativaCod && rs[ativaCod];
    const recente = !ativaCod && !ui.sel ? retratoExibido() : null;
    ops.push(`<option value="">${esc(ativaCod ? 'Unidade ativa' + (ativa ? ': ' + short(ativa.nome) : '') : 'Sem unidade ativa' + (recente ? ' · último retrato: ' + short(recente.nome) : ''))}</option>`);
    const vistos = new Set(ativaCod ? [ativaCod] : []);
    const lista = [];
    for (const u of unidades()) {
      const r = retratoDaUnidade(rs, u);
      if (r) { if (vistos.has(r.cod)) continue; vistos.add(r.cod); }
      const fora = PAL.ehGarantias(u.label) && foraDoAlcance().has(norm(u.label));
      lista.push({ valor: r ? r.cod : 'u:' + u.caminho.join('|'), rotulo: short(u.label) + (fora ? ' (fora do alcance da Busca)' : r ? '' : ' (sem retrato)'),
        nome: u.label, acervo: PAL.acervoDe(r), fora });
    }
    for (const r of Object.values(rs)) if (!vistos.has(r.cod)) { vistos.add(r.cod); lista.push({ valor: r.cod, rotulo: short(r.nome), nome: r.nome, acervo: PAL.acervoDe(r) }); }
    const opt = (o) => `<option value="${esc(o.valor)}">${esc(o.rotulo)}</option>`;
    const comps = naVara();
    const todas = { valor: VARA, rotulo: '▣ TODAS AS COMPETÊNCIAS (' + comps.filter((p) => p.ret).length + ' de ' + comps.length + ' contadas)' };
    // Unidades e competências pela relevância (acervo ativo); o grupo da Garantias vale pela soma das competências.
    const blocos = PAL.agruparUnidades(lista).map((o) => {
      if (!o.grupo) return o;
      const itens = PAL.porRelevancia(o.itens);
      const medidas = itens.filter((x) => typeof x.acervo === 'number');
      return Object.assign(o, { itens, rotulo: o.grupo, acervo: medidas.length ? PAL.soma(medidas, (x) => x.acervo) : null });
    });
    for (const o of PAL.porRelevancia(blocos)) {
      ops.push(o.grupo ? `<optgroup label="${esc(o.grupo)}">${opt(todas)}${o.itens.map(opt).join('')}</optgroup>` : opt(o));
    }
    ops.push('<option value="!listar">↻ Atualizar a lista de unidades…</option>');
    unidSel.innerHTML = ops.join('');
    // Escolha guardada como unidade "sem retrato" que, contada, passou a ter retrato: aponta o retrato.
    if (ui.sel && ui.sel.indexOf('u:') === 0) {
      const u = unidades().find((x) => 'u:' + x.caminho.join('|') === ui.sel);
      const r = u && retratoDaUnidade(rs, u);
      if (r) { ui.sel = r.cod === ativaCod ? '' : r.cod; saveUi(); }
    }
    unidSel.value = ui.sel && [...unidSel.options].some((o) => o.value === ui.sel) ? ui.sel : '';
  }

  // Critério de ordem: 'tot' (gabinete + secretaria) | 'gab' | 'sec'.
  const crit = () => (ui.crit === 'gab' || ui.crit === 'sec' ? ui.crit : 'tot');
  const DICA = {
    agr: { gab: 'Gabinete: conclusos na Mesa com este agrupador. Clique para ver todas as conclusões ou fila a fila.',
      sec: 'Secretaria: processos cuja conclusão com este agrupador já saiu da Mesa. Clique para abrir na Busca Avançada.' },
    loc: { gab: 'Gabinete: processos do localizador que estão conclusos. Clique para abrir em Buscar Conclusões.',
      sec: 'Secretaria: processos do localizador fora da conclusão. A Busca Avançada abre a lista do localizador inteira (gabinete e secretaria).' },
  };
  // Número de gabinete (amarelo) e de secretaria (azul). Em ramo, só informa; em item, abre a lista.
  function chipG(n, secao, k) {
    if (n.gab === null || n.gab === undefined) return '<span class="n g na" title="Mesa não lida">—</span>';
    if (n.tipo === 'grupo' || !n.item) return `<span class="n g na${n.gab === 0 ? ' z' : ''}">${fmt(n.gab)}</span>`;
    return `<span class="n g${n.gab === 0 ? ' z' : ''}${gabAberto.has(k) ? ' on' : ''}" data-gab="${esc(k)}" title="${DICA[secao].gab}">${fmt(n.gab)}</span>`;
  }
  function chipS(n, secao) {
    if (n.sec === null || n.sec === undefined) return '<span class="n s na">—</span>';
    if (n.tipo === 'grupo' || !n.item) return `<span class="n s na${n.sec === 0 ? ' z' : ''}">${fmt(n.sec)}</span>`;
    return `<span class="n s${n.sec === 0 ? ' z' : ''}" data-busca title="${DICA[secao].sec}">${fmt(n.sec)}</span>`;
  }
  function itemHtml(n, secao) {
    const k = secao + ':' + n.item.id;
    let h = `<div class="it" data-sec="${secao}" data-id="${esc(n.item.id)}"><span class="r" data-nome title="${esc(n.item.nome)}">${esc(n.rotulo)}</span>${chipG(n, secao, k)}${chipS(n, secao)}</div>`;
    if (secao === 'agr' && gabAberto.has(k)) {
      const fs = Object.keys(n.item.filas || {}).map((f) => [f, n.item.filas[f]]).sort((a, b) => b[1] - a[1]);
      h += fs.length
        ? `<div class="sub" data-todas data-sec="agr" data-id="${esc(n.item.id)}" title="Abrir Conclusões › Todas, filtrada por este agrupador"><span class="r"><b>Todas as conclusões</b></span><span class="n">${fmt(n.gab)}</span></div>`
          + fs.map(([f, q]) => `<div class="sub" data-fila="${esc(f)}" data-sec="agr" data-id="${esc(n.item.id)}" title="Abrir a fila filtrada por este agrupador"><span class="r">${esc(f)}</span><span class="n">${fmt(q)}</span></div>`).join('')
        : '<div class="sub" style="cursor:default">Nenhum concluso na Mesa.</div>';
    }
    return h;
  }
  const isOpen = (k) => !!ui.open[k];
  function nosHtml(nos, secao) {
    let h = '';
    for (const n of nos) {
      if (n.tipo === 'grupo') {
        // O ramo 07 nasce aberto (decisão dele, 17/10); fechado à mão, fica fechado até o pai se abrir de novo.
        const aberto = n.proprio ? ui.open[n.chave] !== false : isOpen(n.chave);
        h += `<details class="g" data-k="${esc(n.chave)}"${n.proprio ? ' data-proprio' : ''} ${aberto ? 'open' : ''}><summary><span class="r" title="${esc(n.rotulo)}">${esc(n.rotulo)} <small>${n.itens} itens</small></span>`
          + chipG(n, secao) + chipS(n, secao) + '</summary>' + nosHtml(n.filhos, secao) + '</details>';
      } else h += itemHtml(n, secao);
    }
    return h;
  }
  function arvores(ret) {
    const c = crit();
    const opts = PAL.opcoesDaUnidade(ret.nome);
    if (ret.vara) return { agr: PAL.ordenar(PAL.arvoreDaVara(ret.partes, 'agr', opts), c), loc: PAL.ordenar(PAL.arvoreDaVara(ret.partes, 'loc', opts), c), crit: c };
    const agr = PAL.ordenar(PAL.montarArvore(ret.agrupadores || [], 'agr', opts), c);
    const loc = PAL.ordenar(PAL.montarArvore(ret.localizadores || [], 'loc', opts), c);
    return { agr, loc, crit: c };
  }
  const somaSec = (lista, k) => (lista || []).some((x) => x[k] !== null && x[k] !== undefined) ? PAL.soma(lista, (x) => x[k]) : null;
  const cabecalho = () => '<div class="colhead"><span class="r"></span><span class="n g na">Gabinete</span><span class="n s na">Secretaria</span></div>';
  function secHtml(chave, titulo, lista, nos, vazio, extra) {
    const g = somaSec(lista, 'gab'), s = somaSec(lista, 'sec');
    return `<details class="sec" data-k="${chave}" ${ui.open[chave] !== false ? 'open' : ''}><summary><span class="r">${titulo} <small style="font-weight:normal">(${(lista || []).length})</small></span>`
      + `<span class="n g na">${fmt(g)}</span><span class="n s na">${fmt(s)}</span></summary>`
      + (nos || `<div class="empty">${vazio}</div>`) + (extra || '') + '</details>';
  }

  function render() {
    syncBar();
    if (showingCfg) return renderCfg();
    preencherUnidades();
    const ret = retratoExibido();
    if (!ret && ui.sel === VARA) {
      const n = naVara().filter((p) => p.u).length;
      body.innerHTML = `<div class="empty">Nenhuma competência da Vara de Garantias foi contada ainda. Clique em ⟳: o painel conta as ${n} competências em fila (cerca de ${Math.max(1, Math.round(n * 20 / 60))} min), uma de cada vez, e no fim volta à unidade atual.<br><br>Evite usar o Projudi em outra aba durante a contagem.</div>`;
      return;
    }
    if (!ret) {
      body.innerHTML = exibindoAtiva()
        ? '<div class="empty">Ainda não há retrato da unidade ativa. A contagem começa sozinha ao abrir o painel; o ⟳ força a contagem.<br><br>A contagem lê a Busca Avançada (uma consulta por agrupador e por localizador) e as filas da Mesa. Leva cerca de meio minuto e não altera nada no Projudi.</div>'
        : '<div class="empty">Esta unidade ainda não foi contada. Clique em ⟳: o painel troca a Atuação para ela, conta e volta à unidade atual.<br><br>Evite usar o Projudi em outra aba durante a contagem.</div>';
      return;
    }
    if (ret.vara) {
      const comps = naVara(), faltam = comps.filter((p) => !p.ret).map((p) => p.rotulo);
      const fora = competencias().filter((p) => p.fora).map((p) => p.rotulo);
      if (!busy && !statusEl.classList.contains('err')) setStatus(ret.partes.length + ' de ' + comps.length + ' competências contadas · retrato mais antigo de ' + hora(ret.ts) + (ret.mesa ? ' · ' + fmt(ret.mesa.total) + ' conclusos no gabinete' : '') + '.' + (faltam.length ? ' Sem retrato: ' + faltam.join(', ') + ' (⟳ conta todas).' : '')
        + (ret.partes.some((p) => p.ret.parcial) ? ' OUTROS ainda do retrato anterior em: ' + ret.partes.filter((p) => p.ret.parcial).map((p) => p.rotulo).join(', ') + '.' : '')
        + (fora.length ? ' Fora do alcance da Busca Avançada (excluídas): ' + fora.join(', ') + '.' : ''));
    } else if (!busy && !statusEl.classList.contains('err')) setStatus('Retrato de ' + hora(ret.ts) + ' · processos ativos' + (typeof ret.acervo === 'number' ? ' · acervo ativo ' + fmt(ret.acervo) : '') + (ret.mesa ? ' · ' + fmt(ret.mesa.total) + ' conclusos no gabinete' : '') + '.' + (ret.erroMesa ? ' Mesa não lida: ' + ret.erroMesa : '')
      + (ret.parcial ? (ret.tsOutros ? ' OUTROS do retrato de ' + hora(ret.tsOutros) + '.' : ' OUTROS ainda não contados.') : ''));
    const { agr, loc } = arvores(ret);
    const q = search.value.trim();
    if (q) return renderBusca(ret, agr, loc, q);
    const vAgr = PAL.visiveis(agr, cfg.zerados), vLoc = PAL.visiveis(loc, cfg.zerados);
    const semAgr = cfg.semAgrupador && ret.mesa && ret.mesa.semAgrupador
      ? `<div class="it"><span class="r" style="cursor:default;color:#7a5b16">(sem agrupador na Mesa)</span><span class="n g na">${fmt(ret.mesa.semAgrupador)}</span><span class="n s na"></span></div>` : '';
    let h = cabecalho();
    h += secHtml('sec:agr', 'AGRUPADORES', ret.agrupadores, nosHtml(vAgr, 'agr'), 'Nenhum agrupador com processos.', semAgr);
    h += secHtml('sec:loc', 'LOCALIZADORES', ret.localizadores, nosHtml(vLoc, 'loc'), 'Nenhum localizador com processos.');
    h += '<div class="foot"><b style="color:#7a5b16">Gabinete</b>: processos conclusos (filas da Mesa). <b style="color:' + ACC_D + '">Secretaria</b>: processos ativos fora da conclusão. '
      + 'No agrupador, a secretaria é o processo cuja conclusão com aquele agrupador já saiu da Mesa. A soma de um ramo é a soma dos itens (um processo pode ter mais de um localizador).</div>';
    body.innerHTML = h;
  }

  function renderBusca(ret, agr, loc, q) {
    const g = gruposBusca();
    // A busca alcança também os zerados (quem procura um nome precisa achá-lo), mas eles vão para o fim.
    const lista = PAL.folhas(agr).map((f) => Object.assign(f, { sec: 'agr' }))
      .concat(PAL.folhas(loc).map((f) => Object.assign(f, { sec: 'loc' })));
    const achados = PAL.buscar(q, lista, g, crit());
    const temAlgum = (r) => (+r.no.tot || 0) > 0;
    results = achados.filter(temAlgum).concat(achados.filter((r) => !temAlgum(r))).slice(0, 200);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    body.innerHTML = results.length
      ? cabecalho() + results.map((r, i) => `<div class="res${i === sel ? ' sel' : ''}${temAlgum(r) ? '' : ' zero'}" data-i="${i}" data-sec="${r.sec}" data-id="${esc(r.no.item.id)}"><span class="tipo ${r.sec}">${r.sec === 'agr' ? 'AGR' : 'LOC'}</span><div class="p" data-nome>${esc(r.no.item.nome)}${r.caminho.length ? '<small>' + esc(r.caminho.join(' › ')) + '</small>' : ''}</div>${chipG(r.no, r.sec, r.sec + ':' + r.no.item.id)}${chipS(r.no, r.sec)}</div>`
        + (r.sec === 'agr' && gabAberto.has('agr:' + r.no.item.id) ? itemHtml(r.no, 'agr').replace(/^<div class="it"[\s\S]*?<\/div>/, '') : '')).join('')
      : '<div class="empty">Nada encontrado. A busca aceita palavras em qualquer ordem, sem acento, por radical e por sinônimo (⚙ para acrescentar sinônimos).</div>';
  }

  function syncBar() {
    root.querySelector('.main-bar').style.display = showingCfg ? 'none' : '';
    root.querySelectorAll('[data-crit]').forEach((b) => b.classList.toggle('on', b.dataset.crit === crit()));
    root.querySelector('[data-t=zeros]').classList.toggle('on', !!cfg.zerados);
    root.querySelector('[data-a=cfg]').classList.toggle('on', showingCfg);
    root.querySelectorAll('[data-cfgbtn]').forEach((b) => { b.hidden = !showingCfg; });
    root.querySelector('[data-a=contar]').disabled = busy;
  }

  /* configurações */
  let cfgSnap = null;
  function renderCfg() {
    body.innerHTML = `<div class="cfg">
<fieldset><legend>Contagem</legend>
  <label>Retrato da unidade ativa vale por <input type="number" min="0" max="1440" data-c="cacheMin" value="${esc(cfg.cacheMin)}"> minutos</label>
  <div class="hint">Passado esse tempo, ao abrir o painel o retrato antigo aparece na hora e a recontagem corre em segundo plano. 0 = contar sempre.</div>
  <label>Consultas simultâneas à Busca Avançada <input type="number" min="1" max="6" data-c="concorrencia" value="${esc(cfg.concorrencia)}"></label>
  <label><input type="checkbox" data-c="semAgrupador" ${cfg.semAgrupador ? 'checked' : ''}> Mostrar a linha dos conclusos sem agrupador</label>
</fieldset>
<fieldset><legend>Busca por sentido</legend>
  <label class="col">Sinônimos acrescentados (uma linha por grupo, termos separados por vírgula)
    <textarea data-c="sinonimos" placeholder="ex.: tornozeleira, monitoramento eletrônico">${esc(cfg.sinonimos)}</textarea></label>
  <div class="hint">Somam-se aos ${PAL.SINONIMOS.length} grupos embutidos (prisão/custódia/flagrante, MP/ministerial, SISBAJUD/bloqueio, RPV/precatório, aguardando/ag., etc.).</div>
</fieldset>
<fieldset><legend>Aparência</legend>
  <label>Lado das abas (vale para os dois painéis) <select data-c="side"><option value="left" ${abas.lado() !== 'right' ? 'selected' : ''}>esquerdo</option><option value="right" ${abas.lado() === 'right' ? 'selected' : ''}>direito</option></select></label>
  <label>Largura máxima <input type="number" min="280" max="900" data-c="width" value="${esc(cfg.width)}"> px</label>
  <label>Tamanho da letra <input type="number" min="9" max="18" data-c="fontSize" value="${esc(cfg.fontSize)}"></label>
  <label>Atalho: Alt + <input type="text" class="k" maxlength="1" data-c="hotkey" value="${esc(hotkey())}"></label>
  <div class="hint">O Painel de Navegação usa Alt+J; não repita a letra.</div>
</fieldset>
<fieldset><legend>Dados guardados neste navegador</legend>
  <button class="btn" data-a="limpar">Apagar retratos e lista de unidades</button>
</fieldset></div>`;
  }
  function setCfg(k, v) {
    if (k === 'hotkey') { v = String(v || '').trim().toUpperCase(); if (!/^[A-Z0-9]$/.test(v)) v = 'K'; }
    if (['cacheMin', 'concorrencia', 'width', 'fontSize'].includes(k)) v = Math.max(0, +v || DEFAULTS[k]);
    cfg[k] = v;
    if (k === 'side') return abas.definirLado(v); // o lado é comum aos dois painéis (reaplica os dois)
    applyLayout();
  }
  function openCfg() { cfgSnap = JSON.parse(toJson(cfg)); showingCfg = true; render(); body.scrollTop = 0; }
  function closeCfg(save) {
    if (!save && cfgSnap) { for (const k of Object.keys(cfg)) delete cfg[k]; Object.assign(cfg, cfgSnap); applyLayout(); }
    saveCfg(); cfgSnap = null; showingCfg = false; render();
    toast(save ? 'Configurações salvas.' : 'Alterações descartadas.');
  }

  /* abrir, contar */
  function toggle(force) {
    const on = force !== undefined ? force : !panel.classList.contains('on');
    panel.classList.toggle('on', on);
    if (on) abas.abriu(); else abas.fechou();
    if (!on) return;
    showingCfg = false;
    render();
    setTimeout(() => search.focus({ preventScroll: true }), 30);
    aoAbrir();
  }

  async function aoAbrir() {
    if (busy) return;
    setStatus(''); // erro de uma abertura anterior não fica na tela
    try {
      let a;
      try { a = await identificarAtiva(); } catch (e) {
        if (!e.semUnidade) throw e;
        ativaCod = null;
        render();
        setStatus(e.message);
        return;
      }
      ativaCod = a.cod;
      if (!ui.sel || ui.sel === a.cod) {
        const r = retratos()[a.cod];
        const validade = (+cfg.cacheMin || 0) * 60000;
        render();
        if (!r || Date.now() - r.ts > validade) await contar(null);
      } else render();
    } catch (e) { falhou(e); }
  }

  async function contar(unidade) {
    if (busy) return;
    busy = true;
    syncBar();
    setStatus('');
    try {
      const r = unidade ? await contarOutra(unidade, (m) => setStatus(m)) : await contarAtiva(null, (m) => setStatus(m));
      if (!unidade) ativaCod = r.cod;
      else { ui.sel = r.cod; saveUi(); } // o seletor passa a apontar o retrato recém-contado
      // Contada por inteiro: se estava fora do alcance da Busca, volta à Vara.
      if (PAL.ehGarantias(r.nome)) { marcarFora(r.nome, false); if (unidade) marcarFora(unidade.label, false); }
      busy = false;
      setStatus('');
      if (panel.classList.contains('on') && !showingCfg) render();
    } catch (e) {
      busy = false;
      if (e.foraDoAlcance && unidade && PAL.ehGarantias(unidade.label)) {
        marcarFora(unidade.label, true);
        setStatus('A Busca Avançada do seu perfil não oferece esta competência no campo Vara: sem ela não há como contar a secretaria nem os localizadores. Ela fica fora da contagem da Vara de Garantias.', true);
        if (panel.classList.contains('on') && !showingCfg) render();
        return;
      }
      falhou(e);
    } finally {
      busy = false;
      syncBar();
    }
  }

  // Vara de Garantias: conta as competências em duas passadas (decisão dele, 17/10). 1ª: a Mesa e os itens 07 de
  // cada competência, gravados; 2ª: os OUTROS, com a Mesa da 1ª. Ordem: mais processos primeiro
  // (PAL.ordemDeContagem). Falha numa competência não para as demais; a Atuação original volta no fim.
  async function contarVara() {
    if (busy) return;
    const ps = PAL.ordemDeContagem(naVara().filter((p) => p.u));
    if (!ps.length) return setStatus('Não há competências da Vara de Garantias na lista de unidades. Use "↻ Atualizar a lista de unidades…".', true);
    busy = true; syncBar(); setStatus('');
    const original = currentAtuacao();
    const falhas = [], mesas = {}, excluidas = [];
    let caiu = null; // sessão caída no meio da fila
    const passada = async (n, so) => {
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (excluidas.includes(p.rotulo)) continue;
        const pre = (n === 1 ? 'Passada 1 de 2 (itens 07) · ' : 'Passada 2 de 2 (OUTROS) · ') + (i + 1) + '/' + ps.length + ' ' + p.rotulo + ': ';
        try {
          setStatus(pre + 'trocando a Atuação…');
          await walk(p.u.caminho);
          // Falhou na 1ª passada (sem Mesa guardada): a 2ª conta a competência inteira, 07 e OUTROS.
          const r = await contarAtiva(p.u.caminho, (m) => setStatus(pre + m), n === 2 && !mesas[p.rotulo] ? {} : { so, mesa: mesas[p.rotulo] });
          if (n === 1) mesas[p.rotulo] = r._mesa;
        } catch (e) {
          if (e.expirada) throw e; // sessão caída: as demais falhariam igual; para a fila e avisa
          // Fora do alcance da Busca: sai da Vara (e das próximas contagens), sem contar como falha.
          if (e.foraDoAlcance) { marcarFora(p.u.label, true); excluidas.push(p.rotulo); } else falhas.push({ rotulo: p.rotulo, passada: n, msg: e.message });
        }
      }
    };
    try {
      await passada(1, '07');
      await passada(2, 'outros');
    } catch (e) {
      caiu = e;
    } finally {
      const ok = caiu ? null : await restaurar(original, unidades(), (m) => setStatus(m)).catch(() => null);
      if (original && !ok && !caiu) toast('Atenção: não consegui restaurar a Atuação original. Reabra a unidade antes de trabalhar.');
      busy = false;
      syncBar();
    }
    if (panel.classList.contains('on') && !showingCfg) render();
    if (caiu) return falhou(caiu);
    setStatus(falhas.length ? 'Falharam: ' + falhas.map((f) => f.rotulo + ' (passada ' + f.passada + ': ' + f.msg + ')').join('; ') + '. O ⟳ tenta de novo.'
      : 'Vara de Garantias contada: ' + (ps.length - excluidas.length) + ' competências, itens 07 primeiro.'
        + (excluidas.length ? ' Fora do alcance da Busca Avançada, excluídas da Vara: ' + excluidas.join(', ') + '.' : ''), !!falhas.length);
  }

  // Extrato: página própria numa aba nova (sem a Prototype.js do Projudi), que chama a impressão; no destino,
  // "Salvar como PDF". O título da página vira o nome sugerido do arquivo.
  let pdfPendente = null; // extrato à espera da escolha "Só os 07" | "07 e OUTROS"
  function exportarPdf(lista, opcoes) {
    const w = window.open('', '_blank');
    if (!w) return setStatus('O Chrome bloqueou a aba do extrato. Permita janelas pop-up para o Projudi e tente de novo.', true);
    w.document.open();
    w.document.write(PAL.extratoHtml(lista, Date.now(), opcoes));
    w.document.close();
    setStatus('Extrato aberto em aba nova: na impressão, escolha "Salvar como PDF".');
  }

  function itemDe(sec, id) {
    const ret = retratoExibido();
    if (!ret) return null;
    return (sec === 'agr' ? ret.agrupadores : ret.localizadores).find((x) => String(x.id) === String(id)) || null;
  }

  function clicar(e) {
    const a = e.target.closest('[data-a]');
    if (a) {
      const act = a.dataset.a;
      if (act === 'tab') { if (tabMoved) { tabMoved = false; return; } return toggle(); }
      if (act === 'close') return toggle(false);
      if (act === 'cfg') { if (showingCfg) { showingCfg = false; cfgSnap = null; return render(); } return openCfg(); }
      if (act === 'cfgsave') return closeCfg(true);
      if (act === 'cfgback') return closeCfg(false);
      if (act === 'pdf') {
        const m = root.querySelector('.pdfmenu');
        m.hidden = !m.hidden;
        root.querySelector('.pdfgar').hidden = true;
        pdfPendente = null;
        const n = Object.keys(retratos()).length;
        root.querySelector('[data-a=pdfall]').textContent = 'Todas com retrato (' + n + ')';
        return;
      }
      if (act === 'pdf1' || act === 'pdfall') {
        root.querySelector('.pdfmenu').hidden = true;
        let lista, titulo;
        if (act === 'pdf1' && ui.sel === VARA) {
          // Vara inteira: o consolidado (mesmo nome somado entre as competências) e depois cada competência.
          const ps = contadas();
          lista = ps.length ? [PAL.consolidarVara(ps, 'Vara de Garantias - consolidado')].concat(ps.map((p) => p.ret)) : [];
          titulo = 'Vara de Garantias';
        } else {
          lista = act === 'pdf1' ? [retratoExibido()].filter(Boolean)
            : PAL.porRelevancia(Object.values(retratos()).map((r) => ({ r, rotulo: r.nome, nome: r.nome, acervo: PAL.acervoDe(r) }))).map((x) => x.r);
        }
        if (!lista.length) return setStatus('Não há retrato para exportar. Conte a unidade antes (⟳).', true);
        // Com unidade da Vara de Garantias no extrato, pergunta antes se entram os OUTROS ou só os 07.
        if (lista.some((r) => PAL.ehGarantias(r.nome))) { pdfPendente = { lista, titulo }; root.querySelector('.pdfgar').hidden = false; return; }
        return exportarPdf(lista, { titulo });
      }
      if (act === 'pdf07' || act === 'pdfout') {
        root.querySelector('.pdfgar').hidden = true;
        const p = pdfPendente;
        pdfPendente = null;
        return p ? exportarPdf(p.lista, { so07: act === 'pdf07', titulo: p.titulo }) : undefined;
      }
      if (act === 'limpar') { lsSet(LS_RET, {}); lsSet(LS_UNI, null); ui.sel = ''; saveUi(); toast('Retratos e lista de unidades apagados.'); return; }
      if (act === 'contar') {
        if (ui.sel === VARA) return contarVara();
        if (exibindoAtiva()) return contar(null);
        const u = unidadeDaSelecao();
        if (!u) return setStatus('Não localizei o caminho desta unidade. Atualize a lista de unidades.', true);
        return contar(u);
      }
      return;
    }
    const cr = e.target.closest('[data-crit]');
    if (cr) { ui.crit = cr.dataset.crit; saveUi(); return render(); }
    const t = e.target.closest('[data-t]');
    if (t) {
      if (t.dataset.t === 'zeros') { cfg.zerados = !cfg.zerados; saveCfg(); return render(); }
      const abrir = t.dataset.t === 'expand';
      body.querySelectorAll('details.g').forEach((d) => { d.open = abrir; ui.open[d.dataset.k] = abrir; });
      return saveUi();
    }
    if (showingCfg) return;
    const falha = (x) => setStatus(x.message, true);
    const linha = (el) => {
      const row = el.closest('[data-sec][data-id]');
      if (!row) return null;
      const l = { sec: row.dataset.sec, it: itemDe(row.dataset.sec, row.dataset.id), ret: retratoExibido() };
      // Na Vara inteira, o item volta à competência de origem: a lista abre lá, com o id de lá.
      if (l.ret && l.ret.vara && l.it) { l.ret = retratos()[l.it._cod] || null; l.it = Object.assign({}, l.it, { id: l.it._id }); }
      return l;
    };
    // Gabinete: no agrupador abre/fecha a lista (todas as conclusões e fila a fila); no localizador abre
    // Buscar Conclusões filtrada.
    const gabinete = (l, k) => {
      if (l.sec === 'agr') { if (gabAberto.has(k)) gabAberto.delete(k); else gabAberto.add(k); return render(); }
      return abrirMenu(l.ret, 'Conclusões', 'Buscar Conclusões', { acao: 'concLoc', id: l.it.id, nome: l.it.nome }).catch(falha);
    };
    const gb = e.target.closest('[data-gab]');
    if (gb) {
      e.preventDefault(); e.stopPropagation();
      const l = linha(gb);
      return l && l.it && l.ret ? gabinete(l, gb.dataset.gab) : undefined;
    }
    const td = e.target.closest('[data-todas]');
    if (td) {
      const l = linha(td);
      if (l && l.it && l.ret) abrirMenu(l.ret, 'Conclusões', 'Todas', { acao: 'mesa', id: l.it.id, nome: l.it.nome }).catch(falha);
      return;
    }
    const f = e.target.closest('[data-fila]');
    if (f) {
      const l = linha(f);
      if (l && l.it && l.ret) abrirFila(l.ret, l.it, f.dataset.fila).catch(falha);
      return;
    }
    const b = e.target.closest('[data-busca]');
    if (b) {
      const l = linha(b);
      if (l && l.it && l.ret) abrirBusca(l.ret, l.it, l.sec).catch(falha);
      return;
    }
    // Nome do item: vai ao lado que tem processos (o gabinete, se só ele tiver; senão, a secretaria).
    const nm = e.target.closest('[data-nome]');
    if (nm) {
      const l = linha(nm);
      if (!l || !l.it || !l.ret) return;
      if ((+l.it.gab || 0) > 0 && !(+l.it.sec || 0)) return gabinete(l, l.sec + ':' + l.it.id);
      abrirBusca(l.ret, l.it, l.sec).catch(falha);
    }
  }

  function unidadeDaSelecao() {
    if (!ui.sel) return null;
    if (ui.sel.indexOf('u:') === 0) return unidades().find((x) => 'u:' + x.caminho.join('|') === ui.sel) || null;
    const r = retratos()[ui.sel];
    if (r && r.caminho) return unidades().find((x) => x.caminho.join('|') === r.caminho.join('|')) || { caminho: r.caminho, label: r.caminho[r.caminho.length - 1] };
    return null;
  }

  root.addEventListener('click', clicar);
  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el === unidSel) {
      if (el.value === '!listar') {
        el.value = ui.sel || '';
        if (busy) return;
        busy = true; syncBar();
        listarUnidades((m) => setStatus(m)).then((l) => { busy = false; setStatus(l.units.length + ' unidades na lista.'); render(); })
          .catch((x) => { busy = false; falhou(x); }).finally(() => { busy = false; syncBar(); });
        return;
      }
      ui.sel = el.value; saveUi(); gabAberto.clear(); search.value = ''; setStatus('');
      return render();
    }
    if (el.matches('[data-c]') && showingCfg) {
      setCfg(el.dataset.c, el.type === 'checkbox' ? el.checked : el.value);
      if (el.dataset.c === 'hotkey') el.value = cfg.hotkey;
    }
  });
  root.addEventListener('input', (e) => { if (e.target.matches('textarea[data-c]') && showingCfg) cfg[e.target.dataset.c] = e.target.value; });
  root.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName === 'DETAILS' && d.dataset.k) { ui.open[d.dataset.k] = d.open; saveUi(); }
    // Abrir a competência (ou a seção) abre junto o seu ramo 07.
    if (d.tagName === 'DETAILS' && d.open) d.querySelectorAll(':scope > details[data-proprio]').forEach((x) => { if (!x.open) x.open = true; });
  }, true);

  // Largura pela borda; clique duplo recolhe.
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { id: e.pointerId, x: e.clientX, w: panelWidth(), moved: false };
    grip.setPointerCapture(e.pointerId); grip.classList.add('drag'); panel.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    ui.panelW = Math.round(Math.max(PANEL_MIN, Math.min(maxWidth(), drag.w + (abas.lado() === 'right' ? -dx : dx))));
    applyLayout();
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    try { grip.releasePointerCapture(drag.id); } catch (_) { /* ignora */ }
    if (drag.moved) saveUi();
    drag = null; grip.classList.remove('drag'); panel.classList.remove('resizing');
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('dblclick', (e) => { e.preventDefault(); endDrag(); toggle(false); });

  // Aba: arraste vertical muda a posição; clique sem arraste abre ou fecha.
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
    tabDrag.moved = true; tab.classList.add('dragging');
    abas.posicionar(tabDrag.top + dy);
  });
  const endTabDrag = (e) => {
    if (!tabDrag || (e && e.pointerId !== tabDrag.id)) return;
    try { tab.releasePointerCapture(tabDrag.id); } catch (_) { /* ignora */ }
    if (tabDrag.moved) { abas.salvar(); tabMoved = true; setTimeout(() => { tabMoved = false; }, 0); }
    tabDrag = null; tab.classList.remove('dragging');
  };
  tab.addEventListener('pointerup', endTabDrag);
  tab.addEventListener('pointercancel', endTabDrag);
  window.addEventListener('resize', () => { tabLabel(tabText); placeTab(); });

  let deb = null;
  search.addEventListener('input', () => { sel = 0; clearTimeout(deb); deb = setTimeout(render, 150); });
  search.addEventListener('keydown', (e) => {
    const marcar = () => { root.querySelectorAll('.res').forEach((x, i) => x.classList.toggle('sel', i === sel)); const el = root.querySelector('.res.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); marcar(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); marcar(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[sel], ret = retratoExibido();
      if (r && ret && search.value.trim()) abrirBusca(ret, r.no.item, r.sec).catch((x) => setStatus(x.message, true));
    } else if (e.key === 'Escape') { e.preventDefault(); if (search.value) { search.value = ''; render(); } else toggle(false); }
  });

  document.addEventListener('keydown', (e) => { if (HOTKEY(e)) { e.preventDefault(); toggle(); } }, true);
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.pal === 'toggle') toggle();
    if (e.data.pal === 'aviso') toast(e.data.msg);
  });

  captureTop();
  applyLayout();
  (document.body || document.documentElement).appendChild(host);
  placeTab();
  try { executarPendente(); } catch (_) { /* idem */ }
})();
