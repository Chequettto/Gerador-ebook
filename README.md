# Ebook AI Backend

Backend Node.js/Express para geração automatizada de e-books via esteira tripla de IAs (Gemini 1.5 Flash → Groq/Llama 3.3 70B → Mistral Small), com anel de resiliência de 18 chaves e pausa técnica automática. Pronto para deploy no Render (Web Service).

## Rotas

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
Gera a URL de uma capa 800x1200 via Pollinations FLUX, sem texto na imagem.

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
5. Em **Environment**, adicione as 18 chaves (`GEMINI_KEY_1..6`, `GROQ_KEY_1..6`, `MISTRAL_KEY_1..6`) — veja `.env.example`.
6. O Render injeta `PORT` automaticamente; o servidor já usa `process.env.PORT`.

## Arquitetura de resiliência

- Cada chamada de API individual usa `AbortController` com timeout de 15s.
- Se uma chave falha (429/500/timeout), o sistema passa para a próxima chave do mesmo pool.
- Se as 6 chaves de um provedor falharem na mesma rodada, o servidor pausa por 10s e tenta a rodada inteira novamente — indefinidamente, sem descartar o progresso do bloco.
- Cada capítulo deve ser dividido em 8 blocos pelo frontend/orquestrador, chamando `/api/generate-block` uma vez por bloco, para manter cada requisição bem abaixo do limite de 30s do Render.
