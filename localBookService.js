'use strict';

const fs = require('fs');
const path = require('path');
const { compressReferenceText, normalizePromptText } = require('./promptCompression');

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage', 'dist', 'build']);
const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
let cachedCorpusRoot = null;
let cachedCorpus = null;

const GENERIC_CHAPTERS = [
  'Fundamentos e conceitos essenciais',
  'Como entender o cenário atual e definir objetivos',
  'Ferramentas e métodos para começar',
  'Aplicação prática passo a passo',
  'Erros comuns e como evitá-los',
  'Estratégias para avançar com consistência',
  'Como medir resultados e ajustar o plano',
  'Próximos passos para continuar evoluindo',
];

const FINANCE_CHAPTERS = [
  'Diagnóstico financeiro e definição de objetivos',
  'Orçamento realista e controle de gastos',
  'Organização e negociação de dívidas',
  'Reserva de emergência e hábitos de poupança',
  'Fundamentos de investimentos e gestão de riscos',
  'Plano financeiro para os próximos doze meses',
  'Como acompanhar resultados e corrigir a rota',
  'Próximos passos para construir segurança financeira',
];

const BLOCK_GUIDES = [
  'Apresente os conceitos e explique por que eles importam para o leitor.',
  'Mostre como reconhecer a situação e quais critérios ajudam a tomar uma decisão.',
  'Descreva um método prático em etapas, incluindo como começar com os recursos disponíveis.',
  'Explique riscos, erros comuns e formas simples de preveni-los.',
  'Mostre como adaptar a estratégia a diferentes realidades, sem prometer resultados garantidos.',
  'Feche com uma síntese e uma ação pequena que o leitor possa iniciar agora.',
];

const BLOCK_APPLICATIONS = [
  'Uma boa base começa separando fatos, interpretações e dúvidas. Registre o que já se sabe, quais informações ainda faltam e que decisão depende delas. Essa distinção evita transformar uma suposição em regra e ajuda o leitor a procurar evidências antes de escolher um caminho.',
  'Use as respostas para identificar um ponto de partida, não para julgar o próprio desempenho. Se várias questões parecerem importantes, compare urgência, impacto e esforço. Escolha uma prioridade que possa ser observada no cotidiano e anote quais condições podem facilitar ou dificultar a mudança.',
  'Defina uma primeira ação pequena, um prazo e um sinal verificável de conclusão. Depois, registre o resultado e compare-o com a situação inicial. Se a ação não funcionar, investigue o motivo e ajuste uma variável por vez; assim fica mais fácil descobrir o que realmente ajudou.',
  'Quando surgir um obstáculo, interrompa o plano e avalie o risco antes de insistir. Uma alternativa pode ser reduzir o tamanho da ação, pedir orientação qualificada ou adiar uma decisão irreversível. Rever o caminho com base em novas informações é parte do método, não um fracasso.',
  'Considere duas pessoas com recursos e rotinas diferentes: a mesma recomendação pode ser viável para uma e impraticável para outra. Adapte frequência, ferramentas e ritmo sem perder o objetivo central. Um exemplo deve esclarecer a decisão, não prometer que todos obterão o mesmo resultado.',
  'Ao final, escreva um plano curto com a próxima ação, a data de revisão e o critério que indicará progresso. Compartilhe a decisão com alguém de confiança quando isso ajudar a manter consistência. A continuidade vem de revisões regulares e ajustes realistas, não de mudanças perfeitas de uma só vez.',
];

function safeText(value) {
  return normalizePromptText(value)
    .replace(/(?:api[_-]?key|password|passwd|secret|token|database_url)\s*[:=]\s*[^\s,;]+/gi, '[dado secreto removido]');
}

function walkTextFiles(directory, output, budget, root = directory) {
  if (output.length >= MAX_FILES || budget.bytes >= MAX_TOTAL_BYTES) return;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    if (output.length >= MAX_FILES || budget.bytes >= MAX_TOTAL_BYTES) break;
    if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkTextFiles(fullPath, output, budget, root);
      continue;
    }
    if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (/^(package(-lock)?|yarn\.lock|pnpm-lock|\.env)/i.test(entry.name)) continue;

    try {
      const size = fs.statSync(fullPath).size;
      if (size === 0 || size > MAX_FILE_BYTES || budget.bytes + size > MAX_TOTAL_BYTES) continue;
      const contents = safeText(fs.readFileSync(fullPath, 'utf8'));
      output.push({ path: path.relative(root, fullPath), contents });
      budget.bytes += size;
    } catch (_) {}
  }
}

function loadLocalCorpus(root) {
  if (cachedCorpusRoot === root && cachedCorpus) return cachedCorpus;
  const files = [];
  const budget = { bytes: 0 };
  walkTextFiles(root, files, budget, root);
  cachedCorpusRoot = root;
  cachedCorpus = { files, bytes: budget.bytes };
  return cachedCorpus;
}

function words(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])];
}

function findLocalReferences(root, topic, chapterTitle) {
  const corpus = loadLocalCorpus(root);
  const queryWords = words(`${topic} ${chapterTitle}`);
  const matches = [];

  for (const file of corpus.files) {
    const sentences = file.contents.match(/[^.!?\n]+[.!?]?/g) || [];
    const sentenceWords = (sentence) => new Set(words(sentence));
    const scored = sentences
      .map((sentence) => {
        const text = sentence.trim();
        const availableWords = sentenceWords(text);
        const score = queryWords.reduce((total, word) => total + Number(availableWords.has(word)), 0);
        return { text, score };
      })
      .filter((item) => item.score > 0 && item.text.length >= 35)
      .sort((left, right) => right.score - left.score);

    for (const item of scored.slice(0, 3)) {
      matches.push({ path: file.path, ...item });
    }
  }

  const selected = matches.sort((left, right) => right.score - left.score).slice(0, 5);
  const rawContext = selected.map((item) => `- ${item.text} [arquivo: ${item.path}]`).join('\n');
  return {
    context: compressReferenceText(rawContext, `${topic} ${chapterTitle}`, 1800),
    filesScanned: corpus.files.length,
    bytesScanned: corpus.bytes,
    chunksSelected: selected.length,
  };
}

function buildLocalOutline({ bookTitle, niche, targetAudience, numChapters, language }) {
  const topic = normalizePromptText(niche);
  const lowerTopic = topic.toLowerCase();
  const templates = /finan|orçamento|dívida|investimento|poupar/.test(lowerTopic)
    ? FINANCE_CHAPTERS
    : GENERIC_CHAPTERS;
  const chapters = Array.from({ length: numChapters }, (_, index) => {
    const template = templates[index % templates.length];
    const suffix = index >= templates.length ? ` — etapa ${index + 1}` : '';
    return `${template}: ${topic}${suffix}`;
  });

  const localContextByChapter = {};
  let filesScanned = 0;
  let totalBytesScanned = 0;
  let totalChunksSelected = 0;
  for (const chapterTitle of chapters) {
    const result = findLocalReferences(__dirname, `${bookTitle} ${topic} ${targetAudience}`, chapterTitle);
    localContextByChapter[chapterTitle] = result.context;
    filesScanned = Math.max(filesScanned, result.filesScanned);
    totalBytesScanned = Math.max(totalBytesScanned, result.bytesScanned);
    totalChunksSelected += result.chunksSelected;
  }

  console.log(
    `[fase-zero] Fase 0 Concluída: Esqueleto e estrutura montados localmente a Custo Zero. ` +
      `${chapters.length} capítulos; ${filesScanned} arquivos textuais; ${totalBytesScanned} bytes varridos; ` +
      `${totalChunksSelected} micro-fragmentos locais selecionados.`
  );

  return {
    subtitle: `Um guia prático de ${topic} para ${targetAudience}`,
    description: `Um e-book sobre ${topic}, preparado para ${targetAudience}. A estrutura cobre fundamentos, aplicação prática e próximos passos.`,
    chapters,
    language: language || 'português do Brasil',
    localContextByChapter,
  };
}

function buildLocalDraft({ bookTitle, chapterTitle, blockNumber, niche, targetAudience }) {
  const guideIndex = (Math.max(1, Number(blockNumber) || 1) - 1) % BLOCK_GUIDES.length;
  const guide = BLOCK_GUIDES[guideIndex];
  const paragraphs = [
    `Em "${chapterTitle}", o foco é ${niche} para ${targetAudience}. ${guide}`,
    'Comece observando a situação concreta do leitor: quais fatores influenciam essa decisão, quais recursos estão disponíveis e que informação ainda falta? Separar esses pontos ajuda a escolher uma prioridade realista, em vez de seguir uma receita que talvez não se aplique ao seu contexto.',
    BLOCK_APPLICATIONS[guideIndex],
    'Ao testar uma estratégia, registre a ação, o prazo e um sinal concreto de progresso. Revise o resultado antes de ampliar a mudança. Se houver risco financeiro, jurídico ou de saúde, procure orientação qualificada; uma alternativa reversível é preferível quando as consequências ainda não estão claras.',
  ];
  return paragraphs.join('\n\n');
}

module.exports = { buildLocalDraft, buildLocalOutline, findLocalReferences };