# Claude Telegram Bridge

Serviço persistente (Render) que responde no Telegram instantaneamente usando o Claude de verdade, autenticado com sua assinatura Pro/Max via Agent SDK — sem chave de API paga por token.

## Variáveis de ambiente (Render → Environment)

- `CLAUDE_CODE_OAUTH_TOKEN`: gerado com `claude setup-token` no seu computador.
- `PROJECTS_CONFIG`: JSON com um objeto por bot/projeto:

```json
[
  {
    "slug": "rafael-pipeline",
    "botToken": "SEU_TOKEN_DO_BOTFATHER",
    "webhookSecret": "escolha-uma-senha-forte",
    "systemPrompt": "instrução customizada opcional"
  }
]
```

## Registrar o webhook no Telegram (uma vez por bot)

```
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<seu-servico>.onrender.com/telegram/<slug>", "secret_token": "<webhookSecret>"}'
```
