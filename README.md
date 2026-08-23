# Claude Telegram Bridge

Serviço persistente (Render) que responde no Telegram instantaneamente usando o Claude de verdade, autenticado com sua assinatura Pro/Max via Agent SDK — sem chave de API paga por token.

## Pipeline de agentes

Cada mensagem aciona um Orquestrador (tech lead + PO) que não tem acesso ao Lovable. Ele delega, via subagentes (`Task` tool), para:

- **analyst**: transforma o pedido numa especificação técnica com critérios de aceite. Sem ferramentas externas.
- **dev**: único agente com acesso de escrita ao Lovable (`create_project`, `send_message`). Sempre usa o workspace fixo do Rafael. Se o Lovable não estiver autorizado, falha rápido com uma mensagem clara em vez de ficar tentando de novo.
- **qa**: revisa o resultado do dev contra os critérios de aceite — só tem ferramentas de leitura no Lovable. Aprova ou reprova, e se reprovar o orquestrador aciona o dev de novo.

O contexto da conversa é mantido por chat do Telegram (resume de sessão), então o orquestrador lembra do que já foi perguntado/decidido entre mensagens. Cada passo que o orquestrador responde vira uma mensagem separada no Telegram (não um bloco único no final).

### Como dev/qa acessam o Lovable

Via OAuth direto (`/oauth/lovable/start`) — **ainda pendente**: o Lovable rejeita nosso `client_id` (erro `invalid_client`) porque não libera clientes de domínios não cadastrados, só integrações pré-aprovadas (Cursor, Claude Desktop, etc). Isso só se resolve com o suporte deles (`support@lovable.dev`) liberando nosso redirect (`https://claude-telegram-bridge.onrender.com/oauth/lovable/callback`) na allowlist, ou passando um `client_id` fixo.

> Testamos uma alternativa via `RemoteTrigger` (rotina de nuvem já autenticada no Lovable pelos conectores da conta) — funciona quando chamada por uma sessão interativa do claude.ai/Cowork, mas falha com `Unable to get organization UUID` quando chamada por um processo headless autenticado só com `CLAUDE_CODE_OAUTH_TOKEN`. Não é viável pra esse bot no estado atual.

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
- `RENDER_API_KEY` (opcional, mas recomendado): API key do Render (Account Settings → API Keys) com permissão de escrever env vars neste serviço. Sem ela, o token do Lovable fica só em memória e se perde a cada deploy/restart.
- `RENDER_SERVICE_ID` (opcional): só necessário se o service ID mudar; hoje tem um default fixo pro serviço `claude-telegram-bridge`.

## Registrar o webhook no Telegram (uma vez por bot)

```
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<seu-servico>.onrender.com/telegram/<slug>", "secret_token": "<webhookSecret>"}'
```
