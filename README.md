# Ebook AI Backend

Backend Node.js/Express para geração automatizada de e-books via esteira tripla de IAs (Gemini 1.5 Flash → Groq/Llama 3.3 70B → Mistral Small), com anel de resiliência de 18 chaves e pausa técnica automática. Pronto para deploy no Render (Web Service).

## Rotas

### E-book grátis e login por e-mail

O visitante pode gerar um e-book grátis sem informar e-mail. A cota é persistida por endereço IP no PostgreSQL e é compartilhada por pessoas que usam a mesma rede. Depois do primeiro e-book, a página mostra os planos; para pagar e continuar, a pessoa entra com um código temporário enviado por e-mail.

Configure `DATABASE_URL` e `AUTH_SESSION_SECRET` para habilitar sessões e cotas. O PostgreSQL é necessário mesmo para a cortesia anônima. `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM` habilitam os códigos por e-mail. `ADMIN_EMAIL` recebe acesso administrativo após confirmar o código; o administrador pode gerar sem limite.

As rotas de geração e montagem exigem uma reserva gratuita ou uma reserva da conta/plano, vinculada ao usuário ou ao IP. Checkout e painel administrativo exigem sessão autenticada. Contas novas adicionais do mesmo IP são recusadas; uma pessoa que já tem conta pode entrar de outra rede.

### `POST /api/generate-block`
Gera 1 bloco (~350–400 palavras) de um capítulo, passando pela esteira tripla.

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

### `POST /api/generate-cover`
Gera uma capa com título, subtítulo e autor usando exclusivamente o modelo de imagem Gemini. Configure ao menos uma variável `GEMINI_KEY_1..GEMINI_KEY_40`.

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
- Se uma chave falha (429/500/timeout), o sistema passa para a próxima chave do mesmo pool.
- Se as 6 chaves de um provedor falharem na mesma rodada, o servidor pausa por 10s e tenta a rodada inteira novamente — indefinidamente, sem descartar o progresso do bloco.
- Cada capítulo deve ser dividido em 8 blocos pelo frontend/orquestrador, chamando `/api/generate-block` uma vez por bloco, para manter cada requisição bem abaixo do limite de 30s do Render.
