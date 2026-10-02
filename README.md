# Ebook AI Backend

Backend Node.js/Express para geração de e-books com esqueleto local, pesquisa pública antes dos capítulos, dois estágios de texto por bloco e capa Gemini com SVG local de reserva. O fallback intercalado usa Gemini, Groq, Mistral, OpenRouter e Cloudflare. Cada pool aceita até 100 chaves.

## Rotas

### E-book grátis e login por e-mail

O visitante pode gerar um e-book grátis sem informar e-mail. A cota é persistida por endereço IP no PostgreSQL e é compartilhada por pessoas que usam a mesma rede. Depois do primeiro e-book, a página mostra os planos; para pagar e continuar, a pessoa entra com um código temporário enviado por e-mail.

Configure `DATABASE_URL` e `AUTH_SESSION_SECRET` para habilitar sessões e cotas. O PostgreSQL é necessário mesmo para a cortesia anônima. `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM` habilitam os códigos por e-mail. `ADMIN_EMAIL` recebe acesso administrativo após confirmar o código; o administrador pode gerar sem limite.

As rotas de geração e montagem exigem uma reserva gratuita ou uma reserva da conta/plano, vinculada ao usuário ou ao IP. Checkout e painel administrativo exigem sessão autenticada. Contas novas adicionais do mesmo IP são recusadas; uma pessoa que já tem conta pode entrar de outra rede.

### `POST /api/generate-block`
Monta um esqueleto local e passa o bloco pelo Arquiteto Denso e pelo Refino + Humanização. Tarefas comuns priorizam modelos econômicos; capítulos classificados como técnicos ou especializados usam a ordem complexa configurada. Se todos os provedores falharem, o rascunho local é mantido.

Body JSON:
```json
{
  "bookTitle": "Domine suas Finanças",
  "chapterTitle": "Capítulo 1: O Primeiro Passo",
  "blockNumber": 1,
  "niche": "finanças pessoais",
  "targetAudience": "jovens profissionais endividados",
  "tone": "acolhedor e direto",
  "recentContext": ""
}
```

### `POST /api/prepare-book`
Consulta as fontes públicas conectadas para todos os capítulos antes de iniciar as chamadas de IA. A pesquisa usa cache e seleção de fragmentos dentro de um orçamento aproximado de 900 tokens por capítulo; falhas nas fontes não impedem a geração.

O catálogo inclui Wikipedia, Wikidata, OpenAlex, Crossref, Open Library, Google Books, Project Gutenberg/Gutendex, Wikisource em português e inglês e Internet Archive. As consultas usam HTTP público sem exigir chaves para essas fontes (Europeana, se habilitada, é uma exceção opcional). São coletados metadados e descrições curtas; o backend não baixa livros completos. APIs públicas podem impor quotas, atrasos ou indisponibilidade, tratados individualmente.

### `POST /api/generate-outline` e `POST /api/refine-outline`
`generate-outline` monta primeiro o esqueleto e procura referências locais sem IA. Depois de `prepare-book`, `refine-outline` usa uma chamada econômica para melhorar subtítulo, descrição e títulos. Se as chaves falharem ou o JSON for inválido, o esqueleto local permanece.

### `POST /api/generate-cover`
Tenta gerar uma capa com texto usando Gemini. Se todas as chaves Gemini falharem, cria automaticamente uma capa vetorial SVG local. Ambos os formatos são incorporados ao PDF e ao EPUB.

Body JSON:
```json
{
  "title": "Domine suas Finanças",
  "niche": "finanças pessoais",
  "stylePreference": "minimalista"
}
```

## Deploy no Render

1. Suba este diretório em um repositório Git.
2. No Render, crie um **Web Service** apontando para o repositório.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Em **Environment**, configure PostgreSQL, SMTP, Asaas e as chaves de IA necessárias — veja `.env.example`.
6. O Render injeta `PORT` automaticamente; o servidor já usa `process.env.PORT`.

Configure `ASAAS_WEBHOOK_TOKEN` e cadastre `https://SEU-DOMINIO/api/asaas-webhook` no painel Asaas. Use `ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3` para validar cobranças no sandbox antes de produção.

## Arquitetura de resiliência

- Cada chamada de API individual usa `AbortController` com timeout de 15s.
- A Fase 0 monta sumário, referências locais e rascunhos sem chamada de IA. `.md`, `.txt`, `.json` e `.csv` são varridos com limites de tamanho e sem ler `.env`, dependências ou `.git`.
- A pesquisa pública ocorre antes da primeira chamada de IA; cada fonte falha isoladamente, e os fragmentos são deduplicados, classificados e limitados.
- A coleta global usa `fetch` nativo do Node.js 18+, timeouts, limites de resultados, cache e logs por fonte. Metadados não garantem que o texto da obra esteja em domínio público; a licença deve ser verificada na página da fonte.
- Cada bloco usa duas chamadas de texto em sequência: rascunho denso e polimento. Falhas acionam o fallback intercalado; se todos falharem, o rascunho local é mantido e o e-book continua.
- O contexto de capítulos anteriores é um resumo local limitado a 900 caracteres; o texto bruto não é reenviado. Blocos concluídos são salvos no navegador para retomada.
- Prompts mantêm instruções estáticas separadas e numa ordem estável. Cache nativo depende do modelo e da API; a estimativa de tokens é aproximada, não uma garantia de economia fixa.
- A capa tenta Gemini com rotação pelas chaves configuradas. Se a geração de imagem falhar, o backend desenha uma capa SVG local para permitir PDF e EPUB.
- Divida cada capítulo em blocos pequenos para manter cada requisição abaixo do limite do Render.
