# Claude Telegram Bridge

Serviço persistente (Render) que responde no Telegram instantaneamente usando o Claude de verdade, autenticado com sua assinatura Pro/Max via Agent SDK — sem chave de API paga por token.

## Pipeline de agentes

Cada mensagem aciona um Orquestrador (tech lead + PO) que não tem acesso ao Lovable. Ele delega, via subagentes (`Task` tool), para:

- **analyst**: transforma o pedido numa especificação técnica com critérios de aceite. Sem ferramentas externas.
- **dev**: único agente com permissão de criar/alterar projetos no Lovable. Sempre usa o workspace fixo do Rafael.
- **qa**: revisa o resultado do dev contra os critérios de aceite — só inspeciona, nunca escreve. Aprova ou reprova, e se reprovar o orquestrador aciona o dev de novo.

O contexto da conversa é mantido por chat do Telegram (resume de sessão), então o orquestrador lembra do que já foi perguntado/decidido entre mensagens.

### Como dev/qa acessam o Lovable

O bot no Render não tem OAuth próprio com o Lovable — o Lovable não libera `client_id` de domínios não cadastrados (só clientes pré-aprovados como Cursor/Claude Desktop). Em vez disso, dev e qa acionam sob demanda uma **rotina de nuvem** (`dev-lovable-executor`, criada em claude.ai/code/routines) que já está autenticada no Lovable através dos conectores da conta do Rafael — os mesmos que o Cowork usa.

O mecanismo, via a ferramenta `RemoteTrigger`:
1. `update` no trigger, sobrescrevendo a instrução da tarefa daquela execução.
2. `run` pra disparar a rotina imediatamente (isso ignora o intervalo mínimo de 1h dos agendamentos por cron — só se aplica a disparos automáticos recorrentes, não a execuções sob demanda).
3. Poll em `get_run_log` até a rotina terminar e devolver o resultado.

Isso significa que qualquer subagente que precise de um conector já autorizado na conta do Rafael (Lovable, Supabase, etc.) pode usar o mesmo padrão — basta dar acesso às ferramentas `RemoteTrigger`/`ToolSearch` pra ele e seguir o mesmo passo a passo.

## Variáveis de ambiente (Render → Environment)

- `CLAUDE_CODE_OAUTH_TOKEN`: gerado com `claude setup-token` no seu computador. Esse mesmo token dá acesso à ferramenta `RemoteTrigger` dentro do agente.
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

- `CLOUD_DEV_TRIGGER_ID` (opcional): ID da rotina `dev-lovable-executor` em claude.ai/code/routines. Tem um default fixo no código; só precisa setar se recriar a rotina.

## Registrar o webhook no Telegram (uma vez por bot)

```
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<seu-servico>.onrender.com/telegram/<slug>", "secret_token": "<webhookSecret>"}'
```
