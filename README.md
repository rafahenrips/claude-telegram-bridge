# Claude Telegram Bridge

Serviço persistente (Render) que responde no Telegram instantaneamente usando o Claude de verdade, autenticado com sua assinatura Pro/Max via Agent SDK — sem chave de API paga por token.

## Pipeline de agentes

Cada mensagem aciona um Orquestrador (tech lead + PO) que não tem acesso ao Lovable. Ele delega, via subagentes (`Task` tool), para:

- **analyst**: transforma o pedido numa especificação técnica com critérios de aceite. Sem ferramentas externas.
- **dev**: único agente com acesso de escrita ao Lovable (`create_project`, `send_message`). Sempre usa o workspace fixo do Rafael.
- **qa**: revisa o resultado do dev contra os critérios de aceite. Só tem ferramentas de leitura no Lovable — aprova ou reprova, e se reprovar o orquestrador aciona o dev de novo.

O contexto da conversa é mantido por chat do Telegram (resume de sessão), então o orquestrador lembra do que já foi perguntado/decidido entre mensagens.

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

- `LOVABLE_ACCESS_TOKEN` / `LOVABLE_REFRESH_TOKEN`: preenchidos automaticamente após o login em `/oauth/lovable/start`. Não precisa setar na mão.
- `RENDER_API_KEY` (opcional, mas recomendado): API key do Render (Account Settings → API Keys) com permissão de escrever env vars neste serviço. Sem ela, o token do Lovable fica só em memória e se perde a cada deploy/restart — com ela, o próprio serviço persiste `LOVABLE_ACCESS_TOKEN`/`LOVABLE_REFRESH_TOKEN` de volta no Render toda vez que faz login ou renova o token.
- `RENDER_SERVICE_ID` (opcional): só necessário se o service ID mudar; hoje tem um default fixo pro serviço `claude-telegram-bridge`.

## Registrar o webhook no Telegram (uma vez por bot)

```
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<seu-servico>.onrender.com/telegram/<slug>", "secret_token": "<webhookSecret>"}'
```
