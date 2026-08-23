import express from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";

const app = express();
app.set("trust proxy", 1); // Render fica atrás de proxy; sem isso req.protocol vira "http"
app.use(express.json());

const LOVABLE_WORKSPACE_ID = "aD4lGjRXiZsXfyXexOBi"; // Rafael's Lovable — NUNCA outro workspace, especialmente nunca OmniaConexa

// Rotina de nuvem (Claude Code routine) já autenticada no Lovable via conectores da conta do
// Rafael no claude.ai. O bot no Render não tem OAuth próprio com o Lovable (o Lovable não libera
// client_id de domínios não cadastrados) — em vez disso, dev/qa acionam essa rotina sob demanda
// via RemoteTrigger, que roda na nuvem já com o Lovable conectado.
const CLOUD_DEV_TRIGGER_ID = process.env.CLOUD_DEV_TRIGGER_ID || "trig_014isDtyVyyMiiHK5Z7ktrMP";
const CLOUD_ENVIRONMENT_ID = "env_015p7LpNAjL9bL3xMxFTqcKc";

const ORCHESTRATOR_PROMPT = `Você é o Orquestrador do pipeline de criação/alteração de sistemas do Rafael. Você é tech lead + PO: não escreve código nem mexe no Lovable diretamente. As ferramentas RemoteTrigger e mcp__lovable__* não estão disponíveis pra você — nunca tente usá-las, isso é trabalho do dev e do qa.

Fluxo:
1. Ao receber um pedido, confirme o entendimento em 1-2 frases, de forma objetiva e técnica. Pergunte apenas o essencial que faltar (nome do sistema, funcionalidades-chave). Não prossiga até o pedido estar claro o suficiente.
2. Quando estiver claro, acione o subagente "analyst" (ferramenta Task) pra transformar o pedido numa especificação técnica com critérios de aceite.
3. Acione o subagente "dev" (Task) passando a especificação, pra criar ou alterar o projeto no Lovable.
4. Acione o subagente "qa" (Task) passando os critérios de aceite e o que o dev retornou, pra validar o resultado.
5. Se o QA reprovar, acione o dev de novo com os apontamentos e repita a validação. Se aprovar, siga pro passo 6.
6. Responda ao Rafael com o link de preview e um resumo curto (1-2 frases) do que foi construído.

Se o pedido não for sobre construir/alterar um sistema (por exemplo, uma pergunta comum), responda direto, sem acionar subagentes.
Nunca use listas, markdown pesado ou emojis — é uma conversa de chat comum.`;

const ANALYST_PROMPT = `Você é o Analista/Spec Writer do pipeline do Rafael. Recebe um pedido já confirmado pelo orquestrador e escreve uma especificação técnica objetiva: requisitos funcionais, principais telas/fluxos, e uma lista curta e clara de critérios de aceite (Definition of Done). Você não tem acesso a nenhuma ferramenta externa — devolva só a especificação em texto estruturado pro orquestrador repassar ao dev.`;

// Template compartilhado por dev e qa pra acionar a rotina de nuvem sob demanda.
function remoteTriggerInstructions({ allowedTools, taskFraming }) {
  return `Você não tem acesso direto ao Lovable — mcp__lovable__* não existem aqui. O acesso acontece através de uma rotina na nuvem (Claude Code routine) já autenticada no Lovable via os conectores da conta do Rafael. Você aciona essa rotina sob demanda com a ferramenta RemoteTrigger. Se ela aparecer como "deferred"/sem schema carregado, chame primeiro ToolSearch com query "select:RemoteTrigger".

ID da rotina: "${CLOUD_DEV_TRIGGER_ID}"
Workspace fixo do Lovable: "${LOVABLE_WORKSPACE_ID}" — NUNCA use outro, especialmente nunca o da OmniaConexa.

${taskFraming}

Passo a passo pra cada tarefa:
1. Monte em texto a instrução completa da tarefa pra rotina executar (${taskFraming.toLowerCase().includes("apenas inspecione") ? "só inspeção" : "criação/edição"} no Lovable), sempre citando o workspace_id acima.
2. Chame RemoteTrigger action "update", trigger_id "${CLOUD_DEV_TRIGGER_ID}", body:
{"job_config":{"ccr":{"environment_id":"${CLOUD_ENVIRONMENT_ID}","session_context":{"model":"claude-sonnet-5","allowed_tools":${JSON.stringify(allowedTools)}},"events":[{"data":{"uuid":"<gere um uuid v4 novo>","session_id":"","type":"user","parent_tool_use_id":null,"message":{"content":"<sua instrução completa da tarefa aqui>","role":"user"}}}]}}}
3. Chame RemoteTrigger action "run", trigger_id "${CLOUD_DEV_TRIGGER_ID}". Guarde o session_id retornado.
4. Chame RemoteTrigger action "get_run_log", session_id retornado. Se ainda não aparecer uma linha "result:", chame de novo — repita até no máximo ~20 vezes. Quando aparecer "result:", extraia o texto final que a rotina respondeu.
5. Se depois de ~20 tentativas ainda não tiver terminado, diga que está demorando mais que o esperado em vez de ficar tentando pra sempre.`;
}

const DEV_TOOLS_LOVABLE = [
  "mcp__lovable__create_project",
  "mcp__lovable__send_message",
  "mcp__lovable__get_message",
  "mcp__lovable__get_project",
  "mcp__lovable__list_projects",
  "mcp__lovable__list_workspaces",
];

const QA_TOOLS_LOVABLE = ["mcp__lovable__get_project", "mcp__lovable__get_message", "mcp__lovable__list_projects"];

const DEV_PROMPT = `Você é o Dev do pipeline do Rafael. Recebe uma especificação técnica e é o único agente com permissão de criar/alterar projetos no Lovable.

${remoteTriggerInstructions({
  allowedTools: DEV_TOOLS_LOVABLE,
  taskFraming: "Se ainda não existe projeto pra essa tarefa, a instrução deve pedir create_project com uma mensagem inicial detalhada baseada na especificação. Se já existe um projeto (o orquestrador indica o project_id), a instrução deve pedir send_message com as mudanças. Em ambos os casos, peça pra confirmar com get_project/get_message até ter um preview_url pronto e devolver preview_url, editor_url, project_id e um resumo do que foi feito.",
})}

Devolva ao orquestrador exatamente o que a rotina respondeu (preview_url, editor_url, project_id) e um resumo curto do que foi implementado.`;

const QA_PROMPT = `Você é o QA/Revisor do pipeline do Rafael. Recebe os critérios de aceite e o resultado que o dev produziu no Lovable.

${remoteTriggerInstructions({
  allowedTools: QA_TOOLS_LOVABLE,
  taskFraming: "Sua instrução pra rotina deve pedir apenas inspecione o projeto (get_project/get_message/list_projects) e relate o que encontrou — nunca peça create_project nem send_message, você não tem permissão de escrita.",
})}

Compare o que a rotina relatou com os critérios de aceite. Responda com um veredito objetivo começando por APROVADO ou REPROVADO. Se reprovado, liste de forma curta e específica o que precisa ser corrigido para o orquestrador acionar o dev de novo.`;

function loadProjects() {
  try {
    return JSON.parse(process.env.PROJECTS_CONFIG || "[]");
  } catch {
    return null;
  }
}

// sessão do Claude por chat do Telegram, pra manter contexto entre mensagens (resume)
const chatSessions = new Map();

const AGENTS = {
  analyst: {
    description: "Escreve a especificação técnica e os critérios de aceite a partir de um pedido já confirmado.",
    prompt: ANALYST_PROMPT,
    tools: [],
  },
  dev: {
    description: "Único agente com permissão de criar/alterar projetos no Lovable, via rotina de nuvem (RemoteTrigger).",
    prompt: DEV_PROMPT,
    tools: ["RemoteTrigger", "ToolSearch"],
    maxTurns: 40, // update + run + várias tentativas de get_run_log até a rotina terminar
  },
  qa: {
    description: "Revisa o que o dev construiu no Lovable contra os critérios de aceite; só inspeciona, nunca escreve.",
    prompt: QA_PROMPT,
    tools: ["RemoteTrigger", "ToolSearch"],
    maxTurns: 40,
  },
};

async function askClaude({ systemPrompt, userText, sessionKey }) {
  let finalText = "";

  const resumeSessionId = chatSessions.get(sessionKey);

  for await (const message of query({
    prompt: userText,
    options: {
      systemPrompt: systemPrompt || ORCHESTRATOR_PROMPT,
      disallowedTools: ["mcp__lovable__*", "RemoteTrigger"],
      agents: AGENTS,
      permissionMode: "bypassPermissions",
      resume: resumeSessionId,
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      if (message.session_id) chatSessions.set(sessionKey, message.session_id);
    }
    // parent_tool_use_id != null significa que a mensagem veio de dentro de um subagente
    // (analyst/dev/qa) — só queremos o texto que o orquestrador realmente devolve pro Rafael.
    if (message.type === "assistant" && !message.parent_tool_use_id && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block) {
          finalText += block.text;
        }
      }
    }
  }

  return finalText || "Não consegui gerar uma resposta agora. Tenta reformular o pedido?";
}

const TELEGRAM_MAX_LENGTH = 4096;

function splitForTelegram(text) {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (cut <= 0) cut = TELEGRAM_MAX_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let lastResult;
  for (const chunk of splitForTelegram(text)) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Telegram error ${resp.status}: ${errText}`);
    }
    lastResult = await resp.json();
  }
  return lastResult;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "claude-telegram-bridge", cloudDevTriggerId: CLOUD_DEV_TRIGGER_ID });
});

app.get("/telegram/:slug", (req, res) => {
  res.json({ ok: true, message: `Ponte Claude ativa para o projeto "${req.params.slug}".` });
});

app.post("/telegram/:slug", async (req, res) => {
  const { slug } = req.params;

  const projects = loadProjects();
  if (projects === null) {
    return res.status(500).json({ error: "PROJECTS_CONFIG inválido (JSON malformado)" });
  }

  const project = projects.find((p) => p.slug === slug);
  if (!project) {
    return res.status(404).json({ error: `Projeto "${slug}" não configurado em PROJECTS_CONFIG` });
  }

  const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (project.webhookSecret && incomingSecret !== project.webhookSecret) {
    return res.status(401).json({ error: "secret_token inválido" });
  }

  const update = req.body;
  const message = update?.message;

  if (!message || !message.text) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const userText = message.text;

  res.status(200).json({ ok: true });

  try {
    const reply = await askClaude({
      systemPrompt: project.systemPrompt,
      userText,
      sessionKey: `${slug}:${chatId}`,
    });
    await sendTelegramMessage({ botToken: project.botToken, chatId, text: reply });
  } catch (err) {
    console.error(`[${slug}]`, err);
    await sendTelegramMessage({
      botToken: project.botToken,
      chatId,
      text: "Deu erro ao processar seu pedido agora. Tenta de novo em instantes.",
    }).catch(() => {});
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`claude-telegram-bridge ouvindo na porta ${port}`);
});
